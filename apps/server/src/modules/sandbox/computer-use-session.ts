/**
 * Computer-use session (T-43): the model configured in Setup sees screenshots and proposes actions; the policy decides;
 * allowed actions run on a sandboxed browser page; every step's screenshot goes to restricted retention.
 * Blocked writes stop the session and return an action-approval work item.
 */
import type { ClickTarget, ComputerUsePolicy, CuAction, Decision } from './computer-use.js';
import { isAllowedUrl, resolveAndCheckUrl, type HostIpResolver } from './guards.js';
import type { ScreenshotStore } from './screenshots.js';

/** Minimal model interface for computer use. Implemented on top of the Setup provider (see anthropicComputerUse). */
export interface ComputerUseModel {
  /** Given the goal, history and the latest screenshot, return the next action or null when finished. */
  next(input: { goal: string; screenshotPng: Uint8Array; history: { action: CuAction; decision: Decision['reason'] }[] }): Promise<CuAction | null>;
}

/** The surface actions run against (a Playwright page in the sandbox, a fake in tests). */
export interface Screen {
  screenshot(): Promise<Uint8Array>;
  perform(a: CuAction): Promise<void>;
  inspectAt?(x: number, y: number): Promise<ClickTarget | null>;
}

/** Minimal Playwright context/page shape for `createBrowserScreen` so unit tests and sandbox runs share the same egress route guard. */
export interface RoutableContext {
  route(
    url: string,
    handler: (route: { request(): { url(): string }; continue(): Promise<void> | void; abort(errorCode?: string): Promise<void> | void }) => Promise<void> | void,
  ): Promise<void>;
}

export interface RoutablePage {
  screenshot(): Promise<Uint8Array>;
  goto(url: string): Promise<unknown>;
  mouse: { click(x: number, y: number): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  keyboard: { type(text: string): Promise<void>; press(keys: string): Promise<void> };
  waitForTimeout?(ms: number): Promise<void>;
  evaluate<R, Arg>(pageFunction: (arg: Arg) => R, arg: Arg): Promise<R>;
}

/**
 * Wraps a Playwright BrowserContext + Page as a `Screen`, installing `context.route('**\/*', ...)` so every request
 * (including clicks that follow an external `<a href>` or form action) goes through `isAllowedUrl` + IP validation.
 */
export async function createBrowserScreen(
  context: RoutableContext,
  page: RoutablePage,
  egressAllowlist: string[],
  opts: { resolvedIps?: HostIpResolver; lookupFn?: (host: string) => Promise<readonly string[]> } = {},
): Promise<Screen & { blockedRequests: string[] }> {
  const blockedRequests: string[] = [];
  const checkUrl = async (url: string): Promise<boolean> => {
    if (url.startsWith('data:')) return true;
    if (opts.resolvedIps !== undefined) return isAllowedUrl(url, egressAllowlist, opts.resolvedIps);
    return resolveAndCheckUrl(url, egressAllowlist, opts.lookupFn);
  };

  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (await checkUrl(url)) {
      await route.continue();
      return;
    }
    blockedRequests.push(url);
    await route.abort('blockedbyclient');
  });

  return {
    blockedRequests,
    async screenshot() {
      return page.screenshot();
    },
    async inspectAt(x: number, y: number): Promise<ClickTarget | null> {
      try {
        return await page.evaluate(
          ([px, py]) => {
            const doc = (globalThis as unknown as { document?: any }).document;
            const raw = doc?.elementFromPoint?.(px, py);
            if (!raw) return null;
            const el = raw.closest?.('button, a, input, select, textarea, [role], form') ?? raw;
            const tagName = String(el.tagName ?? '').toLowerCase();
            const role = el.getAttribute?.('role') ?? null;
            const attrType = el.getAttribute?.('type');
            const propType = typeof el.type === 'string' ? el.type : null;
            const type = attrType ?? propType ?? null;
            const inForm = Boolean(el.closest?.('form'));
            const submits = Boolean(
              el.closest?.('button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]'),
            );
            const anchor = el.closest?.('a');
            const href = anchor && typeof anchor.href === 'string' ? anchor.href : null;
            const text = String(el.textContent ?? '').trim().slice(0, 120) || null;
            return { tagName, role, type, inForm, submits, href, text };
          },
          [x, y] as [number, number],
        );
      } catch {
        return null;
      }
    },
    async perform(a: CuAction): Promise<void> {
      switch (a.kind) {
        case 'screenshot':
          return;
        case 'scroll':
          await page.mouse.wheel(a.dx, a.dy);
          return;
        case 'wait':
          if (page.waitForTimeout) await page.waitForTimeout(a.ms);
          return;
        case 'navigate':
          if (!(await checkUrl(a.url))) {
            blockedRequests.push(a.url);
            throw new Error(`navigation to ${a.url} is not allow-listed`);
          }
          await page.goto(a.url);
          return;
        case 'click':
          await page.mouse.click(a.x, a.y);
          return;
        case 'type':
          await page.keyboard.type(a.text);
          return;
        case 'key':
          await page.keyboard.press(a.keys);
          return;
      }
    },
  };
}

export interface SessionResult {
  status: 'finished' | 'needs_approval' | 'blocked' | 'step_limit';
  steps: { action: CuAction; decision: Decision['reason'] }[];
  workItem?: Decision['workItem'];
  screenshots: number;
}

export async function runComputerUse(opts: {
  runId: string;
  goal: string;
  model: ComputerUseModel;
  screen: Screen;
  policy: ComputerUsePolicy;
  screenshots: ScreenshotStore;
  maxSteps?: number;
}): Promise<SessionResult> {
  const steps: SessionResult['steps'] = [];
  let shots = 0;
  const capture = async () => {
    const png = await opts.screen.screenshot();
    await opts.screenshots.put(opts.runId, ++shots, png);
    return png;
  };
  let png = await capture();
  for (let i = 0; i < (opts.maxSteps ?? 25); i++) {
    const action = await opts.model.next({ goal: opts.goal, screenshotPng: png, history: steps });
    if (!action) return { status: 'finished', steps, screenshots: shots };
    const target =
      action.kind === 'click'
        ? action.target !== undefined
          ? action.target
          : opts.screen.inspectAt
            ? await opts.screen.inspectAt(action.x, action.y)
            : null
        : undefined;
    const d = opts.policy.decide(action, target);
    steps.push({ action, decision: d.reason });
    if (!d.allowed) {
      return { status: d.reason === 'needs_approval' ? 'needs_approval' : 'blocked', steps, workItem: d.workItem, screenshots: shots };
    }
    if (action.kind !== 'screenshot') await opts.screen.perform(action);
    png = await capture();
  }
  return { status: 'step_limit', steps, screenshots: shots };
}

/**
 * Anthropic computer-use adapter. The tool type/version string comes from the Setup capability record because it
 * changes across model generations; it is never hard-coded here.
 */
export function anthropicComputerUse(cfg: {
  apiKey: string;
  model: string;
  toolType: string; // e.g. the computer tool version recorded when the capability test passed
  betaHeader?: string;
  display: { width: number; height: number };
  fetchFn?: typeof fetch;
}): ComputerUseModel {
  const f = cfg.fetchFn ?? fetch;
  return {
    async next({ goal, screenshotPng, history }) {
      const res = await f('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(cfg.betaHeader ? { 'anthropic-beta': cfg.betaHeader } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 1024,
          tools: [{ type: cfg.toolType, name: 'computer', display_width_px: cfg.display.width, display_height_px: cfg.display.height }],
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `Goal: ${goal}\nPrevious actions: ${JSON.stringify(history)}\nRead-only unless an approval exists. Reply with one computer action, or no tool call when done.` },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(screenshotPng).toString('base64') } },
              ],
            },
          ],
        }),
      });
      if (!res.ok) throw new Error(`computer-use model call failed: ${res.status}`);
      const j = (await res.json()) as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] };
      const call = j.content?.find((c) => c.type === 'tool_use' && c.name === 'computer');
      return call?.input ? toAction(call.input) : null;
    },
  };
}

/** Maps a provider computer action to the internal action model. Unknown actions map to a write-classified key press. */
export function toAction(input: Record<string, unknown>): CuAction {
  const coord = Array.isArray(input.coordinate) ? (input.coordinate as number[]) : [0, 0];
  switch (input.action) {
    case 'screenshot':
      return { kind: 'screenshot' };
    case 'scroll':
      return { kind: 'scroll', dx: 0, dy: Number(input.scroll_amount ?? 3) * (input.scroll_direction === 'up' ? -100 : 100) };
    case 'wait':
      return { kind: 'wait', ms: Number(input.duration ?? 1) * 1000 };
    case 'left_click':
      return { kind: 'click', x: coord[0] ?? 0, y: coord[1] ?? 0, ...(typeof input.label === 'string' ? { label: input.label } : {}) };
    case 'type':
      return { kind: 'type', text: String(input.text ?? '') };
    default:
      return { kind: 'key', keys: String(input.text ?? input.action ?? 'unknown') };
  }
}

/**
 * Capability test used by Setup before a model may be marked computerUse=true: one call with the computer tool and a
 * blank screenshot must come back as a well-formed computer action.
 */
export async function testComputerUseCapability(model: ComputerUseModel, blankPng: Uint8Array): Promise<boolean> {
  try {
    const a = await model.next({ goal: 'Take a screenshot of the screen.', screenshotPng: blankPng, history: [] });
    return a !== null && typeof a.kind === 'string';
  } catch {
    return false;
  }
}
