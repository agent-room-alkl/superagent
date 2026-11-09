import { describe, it, expect } from 'vitest';
import { ComputerUsePolicy, actionHash, type CuAction } from '../src/modules/sandbox/computer-use.js';
import { anthropicComputerUse, runComputerUse, testComputerUseCapability, toAction, type Screen } from '../src/modules/sandbox/computer-use-session.js';
import { InMemoryScreenshotStore } from '../src/modules/sandbox/screenshots.js';
import { isAllowedUrl } from '../src/modules/sandbox/guards.js';

const PNG = new Uint8Array([137, 80, 78, 71]);

/** Fake Anthropic endpoint returning a scripted sequence of computer actions; records each request. */
function fakeAnthropic(script: (Record<string, unknown> | null)[]) {
  const requests: any[] = [];
  let i = 0;
  const fetchFn = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const next = script[i++] ?? null;
    return Response.json({ content: next ? [{ type: 'tool_use', name: 'computer', id: `t${i}`, input: next }] : [{ type: 'text', text: 'done' }] });
  }) as typeof fetch;
  return { requests, model: anthropicComputerUse({ apiKey: 'sk-ant-test-x', model: 'claude-sonnet-5-5', toolType: 'computer_tool_vX', display: { width: 1280, height: 800 }, fetchFn }) };
}

class FakeScreen implements Screen {
  performed: CuAction[] = [];
  async screenshot() {
    return PNG;
  }
  async perform(a: CuAction) {
    this.performed.push(a);
  }
}

const policy = () => new ComputerUsePolicy((u) => isAllowedUrl(u, ['app.example.com']));

describe('computer-use session', () => {
  it('calls the configured model with the screenshot and tool version, and stores every screenshot', async () => {
    const { requests, model } = fakeAnthropic([{ action: 'scroll', scroll_direction: 'down', scroll_amount: 2 }, { action: 'left_click', coordinate: [10, 20], label: 'Invoices' }, null]);
    const screen = new FakeScreen();
    const shots = new InMemoryScreenshotStore();
    const r = await runComputerUse({ runId: 'cu-1', goal: 'Find invoice', model, screen, policy: policy(), screenshots: shots });
    expect(r.status).toBe('finished');
    expect(screen.performed.map((a) => a.kind)).toEqual(['scroll', 'click']);
    expect(requests[0].tools[0].type).toBe('computer_tool_vX');
    expect(requests[0].messages[0].content[1].type).toBe('image');
    const stored = await shots.list('cu-1');
    expect(stored.length).toBe(3); // initial + after each performed action
    expect(stored.every((s) => s.key.startsWith('screenshots/cu-1/') && s.expiresAt)).toBe(true);
  });

  it('stops at an unapproved write and returns an approval work item; nothing is typed', async () => {
    const { model } = fakeAnthropic([{ action: 'type', text: '480.00' }]);
    const screen = new FakeScreen();
    const r = await runComputerUse({ runId: 'cu-2', goal: 'Enter amount', model, screen, policy: policy(), screenshots: new InMemoryScreenshotStore() });
    expect(r.status).toBe('needs_approval');
    expect(r.workItem?.actionHash).toBe(actionHash({ kind: 'type', text: '480.00' }));
    expect(screen.performed).toEqual([]);
  });

  it('runs the write only after the exact action is approved', async () => {
    const p = policy();
    p.approve(actionHash({ kind: 'type', text: '480.00' }));
    const { model } = fakeAnthropic([{ action: 'type', text: '480.00' }, null]);
    const screen = new FakeScreen();
    const r = await runComputerUse({ runId: 'cu-3', goal: 'Enter amount', model, screen, policy: p, screenshots: new InMemoryScreenshotStore() });
    expect(r.status).toBe('finished');
    expect(screen.performed).toEqual([{ kind: 'type', text: '480.00' }]);
  });

  it('capability test passes only when the model returns a well-formed computer action', async () => {
    expect(await testComputerUseCapability(fakeAnthropic([{ action: 'screenshot' }]).model, PNG)).toBe(true);
    const broken = anthropicComputerUse({ apiKey: 'k', model: 'm', toolType: 't', display: { width: 1, height: 1 }, fetchFn: (async () => new Response('{}', { status: 400 })) as typeof fetch });
    expect(await testComputerUseCapability(broken, PNG)).toBe(false);
  });

  it('maps unknown provider actions to write-classified key presses', () => {
    expect(toAction({ action: 'triple_click' })).toEqual({ kind: 'key', keys: 'triple_click' });
  });
});
