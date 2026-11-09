/**
 * Computer-use session (T-43): the model configured in Setup sees screenshots and proposes actions; the policy decides;
 * allowed actions run on a sandboxed browser page; every step's screenshot goes to restricted retention.
 * Blocked writes stop the session and return an action-approval work item.
 */
import type { ComputerUsePolicy, CuAction, Decision } from './computer-use.js';
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
    const d = opts.policy.decide(action);
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
