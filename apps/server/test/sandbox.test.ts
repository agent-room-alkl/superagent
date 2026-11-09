import { describe, it, expect } from 'vitest';
import { assertNoLoginState, digestOf, GrantStore, isAllowedUrl, verifyArtifact, DigestMismatchError } from '../src/modules/sandbox/guards.js';
import { parameterize, validateProcedure, type Procedure } from '../src/modules/sandbox/replay.js';
import { ComputerUsePolicy, actionHash, assertComputerUseCapable } from '../src/modules/sandbox/computer-use.js';
import { AzureJobLauncher } from '../src/modules/sandbox/launcher.js';

describe('artifact digest', () => {
  it('rejects a tampered artifact', () => {
    const released = digestOf('{"steps":[1]}');
    expect(() => verifyArtifact('{"steps":[1]}', released)).not.toThrow();
    expect(() => verifyArtifact('{"steps":[1,2]}', released)).toThrow(DigestMismatchError);
  });
});

describe('egress allowlist', () => {
  const allow = ['app.example.com', '*.vendor.example'];
  it('allows only listed https hosts and local test hosts', () => {
    expect(isAllowedUrl('https://app.example.com/x', allow)).toBe(true);
    expect(isAllowedUrl('https://a.vendor.example/', allow)).toBe(true);
    expect(isAllowedUrl('https://vendor.example/', allow)).toBe(false);
    expect(isAllowedUrl('https://evil.com/?u=app.example.com', allow)).toBe(false);
    expect(isAllowedUrl('http://app.example.com/', allow)).toBe(false);
    expect(isAllowedUrl('https://app.example.com.evil.com/', allow)).toBe(false);
  });
});

describe('credential grants', () => {
  it('are single-use, bound to run and tool, and expire', () => {
    let t = 1000;
    const g = new GrantStore(() => t);
    const id = g.issue('run-1', 'tool-a', 'secret-value', 60_000);
    expect(() => g.redeem(id, 'run-2', 'tool-a')).toThrow(/not valid/);
    expect(g.redeem(id, 'run-1', 'tool-a')).toBe('secret-value');
    expect(() => g.redeem(id, 'run-1', 'tool-a')).toThrow(/already used/);
    const id2 = g.issue('run-1', 'tool-a', 's', 1000);
    t += 2000;
    expect(() => g.redeem(id2, 'run-1', 'tool-a')).toThrow(/expired/);
  });
});

describe('recorded procedures', () => {
  const base: Procedure = { toolId: 'lookup', effect: 'read', params: ['lot'], steps: [{ op: 'goto', url: 'https://app.example.com' }, { op: 'fill', selector: '#lot', param: 'lot' }, { op: 'extract', selector: '#balance', as: 'balance' }] };
  it('rejects login state in the artifact', () => {
    expect(() => assertNoLoginState({ steps: [], storageState: { cookies: [] } })).toThrow(/storageState/);
    expect(() => validateProcedure({ ...base, ...({ cookies: [] } as object) } as Procedure)).toThrow(/cookies/);
  });
  it('read procedures cannot submit; write procedures need read-back', () => {
    expect(() => validateProcedure(base)).not.toThrow();
    expect(() => validateProcedure({ ...base, steps: [...base.steps, { op: 'submit', selector: '#save' }] })).toThrow(/read procedure/);
    expect(() => validateProcedure({ ...base, effect: 'write', steps: [{ op: 'submit', selector: '#save' }] })).toThrow(/read-back/);
  });
  it('parameterizes recorded literals and refuses to keep business values', () => {
    expect(parameterize([{ op: 'fill', selector: '#lot', value: 'LOT-7' }], { '#lot': 'lot' })).toEqual([{ op: 'fill', selector: '#lot', param: 'lot' }]);
    expect(() => parameterize([{ op: 'fill', selector: '#amount', value: '480' }], {})).toThrow(/literal/);
  });
});

describe('computer use policy', () => {
  const policy = () => new ComputerUsePolicy((u) => isAllowedUrl(u, ['app.example.com']));
  it('allows observation and labeled navigation, blocks writes without approval', () => {
    const p = policy();
    expect(p.decide({ kind: 'screenshot' }).allowed).toBe(true);
    expect(p.decide({ kind: 'click', x: 1, y: 2, label: 'Invoices' }).reason).toBe('navigate');
    const d = p.decide({ kind: 'click', x: 1, y: 2, label: '保存' });
    expect(d.allowed).toBe(false);
    expect(d.workItem?.kind).toBe('action_approval');
    expect(p.decide({ kind: 'click', x: 9, y: 9 }).allowed).toBe(false); // unlabeled = write
    expect(p.decide({ kind: 'type', text: '480' }).allowed).toBe(false);
    expect(p.decide({ kind: 'navigate', url: 'https://evil.com' }).reason).toBe('egress_blocked');
  });
  it('approval is bound to the exact action and consumed once', () => {
    const p = policy();
    const a = { kind: 'type' as const, text: '480' };
    p.approve(actionHash(a));
    expect(p.decide({ kind: 'type', text: '481' }).allowed).toBe(false);
    expect(p.decide(a).reason).toBe('approved_write');
    expect(p.decide(a).allowed).toBe(false);
  });
  it('requires a model verified for computer use', () => {
    expect(() => assertComputerUseCapable({ computerUse: false })).toThrow();
    expect(() => assertComputerUseCapable({ computerUse: true })).not.toThrow();
  });
});

describe('job launcher', () => {
  it('starts one Job execution with the spec passed as an env override', async () => {
    let called: { url: string; body: any } | null = null;
    const l = new AzureJobLauncher({
      jobResourceId: '/subscriptions/s/resourceGroups/r/providers/Microsoft.App/jobs/sa-staging-sandbox',
      image: 'acr/superagent-browser:abc',
      getToken: async () => 't',
      fetchFn: (async (url: string, init: RequestInit) => {
        called = { url, body: JSON.parse(String(init.body)) };
        return Response.json({ name: 'exec-1' });
      }) as typeof fetch,
    });
    const r = await l.start({ runId: 'r1', artifact: '{}', releasedDigest: 'sha256:x', inputs: {}, egressAllowlist: [] });
    expect(r.executionName).toBe('exec-1');
    expect(called!.url).toMatch(/jobs\/sa-staging-sandbox\/start/);
    expect(called!.body.containers[0].env[0]).toEqual({ name: 'APP_ROLE', value: 'browser' });
  });
});
