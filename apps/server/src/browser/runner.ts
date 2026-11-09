/**
 * Browser replay runner (APP_ROLE=browser, runs inside the sandbox Job). Executes a released, digest-verified procedure
 * with parameter inputs. Every network request outside the allowlist is aborted. Screenshots go to a restricted
 * directory that the caller uploads to a short-retention container.
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifyArtifact, isAllowedUrl } from '../modules/sandbox/guards.js';
import { validateProcedure, type Procedure } from '../modules/sandbox/replay.js';

export interface RunSpec {
  runId: string;
  artifact: string; // serialized Procedure JSON exactly as released
  releasedDigest: string;
  inputs: Record<string, string>;
  egressAllowlist: string[];
  screenshotDir?: string;
  timeoutMs?: number;
}

export interface RunResult {
  runId: string;
  ok: boolean;
  outputs: Record<string, string>;
  blockedRequests: string[];
  screenshots: string[];
  error?: string;
}

export async function runProcedure(spec: RunSpec): Promise<RunResult> {
  verifyArtifact(spec.artifact, spec.releasedDigest); // throws on tampering — nothing runs
  const proc = JSON.parse(spec.artifact) as Procedure;
  validateProcedure(proc);
  for (const p of proc.params) if (!(p in spec.inputs)) throw new Error(`missing input ${p}`);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(); // fresh context: no stored login state
  const page = await context.newPage();
  page.setDefaultTimeout(spec.timeoutMs ?? 15_000);
  const blocked: string[] = [];
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('data:') || isAllowedUrl(url, spec.egressAllowlist)) return route.continue();
    blocked.push(url);
    return route.abort('blockedbyclient');
  });

  const outputs: Record<string, string> = {};
  const shots: string[] = [];
  const shot = async (n: number) => {
    if (!spec.screenshotDir) return;
    fs.mkdirSync(spec.screenshotDir, { recursive: true });
    const f = path.join(spec.screenshotDir, `${spec.runId}-${String(n).padStart(3, '0')}.png`);
    await page.screenshot({ path: f });
    shots.push(f);
  };

  try {
    let i = 0;
    for (const s of proc.steps) {
      i++;
      switch (s.op) {
        case 'goto':
          if (!isAllowedUrl(s.url, spec.egressAllowlist)) throw new Error(`navigation to ${s.url} is not allow-listed`);
          await page.goto(s.url);
          break;
        case 'click':
        case 'submit':
          await page.click(s.selector);
          break;
        case 'fill':
          await page.fill(s.selector, spec.inputs[s.param]!);
          break;
        case 'select':
          await page.selectOption(s.selector, spec.inputs[s.param]!);
          break;
        case 'waitFor':
          await page.waitForSelector(s.selector);
          break;
        case 'extract':
          outputs[s.as] = ((await page.textContent(s.selector)) ?? '').trim();
          break;
        case 'assertText': {
          const t = ((await page.textContent(s.selector)) ?? '').trim();
          const want = s.equalsParam ? spec.inputs[s.equalsParam] : undefined;
          if (want !== undefined && t !== want) throw new Error(`read-back mismatch at ${s.selector}: expected "${want}", got "${t}"`);
          if (s.contains && !t.includes(s.contains)) throw new Error(`read-back mismatch at ${s.selector}: missing "${s.contains}"`);
          break;
        }
      }
      await shot(i);
    }
    return { runId: spec.runId, ok: true, outputs, blockedRequests: blocked, screenshots: shots };
  } catch (e) {
    return { runId: spec.runId, ok: false, outputs, blockedRequests: blocked, screenshots: shots, error: (e as Error).message };
  } finally {
    await browser.close();
  }
}

/** Entry for APP_ROLE=browser: spec arrives base64-encoded in RUN_SPEC; result is printed as one JSON line. */
export async function runFromEnv(env = process.env): Promise<void> {
  if (!env.RUN_SPEC) throw new Error('RUN_SPEC is not set');
  const spec = JSON.parse(Buffer.from(env.RUN_SPEC, 'base64').toString('utf8')) as RunSpec;
  const result = await runProcedure({ ...spec, screenshotDir: spec.screenshotDir ?? '/tmp/shots' });
  console.log(JSON.stringify({ msg: 'run_result', ...result }));
  if (!result.ok) process.exitCode = 2;
}
