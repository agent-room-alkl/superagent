/**
 * Real-browser replay test. Runs when RUN_BROWSER_TESTS=1 (CI "browser" job installs Chromium). Serves a small form on
 * localhost, replays a released write procedure with read-back, and proves non-allow-listed requests are blocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runProcedure } from '../src/browser/runner.js';
import { digestOf } from '../src/modules/sandbox/guards.js';
import { InMemoryScreenshotStore } from '../src/modules/sandbox/screenshots.js';
import type { Procedure } from '../src/modules/sandbox/replay.js';

const d = process.env.RUN_BROWSER_TESTS === '1' ? describe : describe.skip;

const PAGE = `<!doctype html><html><body>
<form id="f"><input id="amount"><button id="save" type="button" onclick="document.getElementById('saved').textContent=document.getElementById('amount').value">Save</button></form>
<div id="saved"></div>
<img src="https://tracker.invalid/pixel.gif">
</body></html>`;

d('browser replay', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end(PAGE));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(() => server.close());

  const proc = (): Procedure => ({
    toolId: 'enter-amount',
    effect: 'write',
    params: ['amount'],
    steps: [
      { op: 'goto', url: base },
      { op: 'fill', selector: '#amount', param: 'amount' },
      { op: 'submit', selector: '#save' },
      { op: 'assertText', selector: '#saved', equalsParam: 'amount' },
      { op: 'extract', selector: '#saved', as: 'saved' },
    ],
  });

  it('replays with parameters, reads back, and blocks other hosts', async () => {
    const artifact = JSON.stringify(proc());
    const shots = new InMemoryScreenshotStore();
    const r = await runProcedure({ runId: 'r1', artifact, releasedDigest: digestOf(artifact), inputs: { amount: '480.00' }, egressAllowlist: ['127.0.0.1'] }, { screenshots: shots });
    expect(r.error).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.outputs.saved).toBe('480.00');
    expect(r.blockedRequests.some((u) => u.includes('tracker.invalid'))).toBe(true);
    const stored = await shots.list('r1');
    expect(stored.length).toBe(5); // one screenshot per step, all in restricted retention
    expect(stored.every((s) => s.bytes > 0 && s.key.startsWith('screenshots/r1/'))).toBe(true);
  }, 60_000);

  it('refuses to run a tampered artifact', async () => {
    const artifact = JSON.stringify(proc());
    await expect(runProcedure({ runId: 'r2', artifact: artifact + ' ', releasedDigest: digestOf(artifact), inputs: { amount: '1' }, egressAllowlist: ['127.0.0.1'] })).rejects.toThrow(/digest/);
  });
});
