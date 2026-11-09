import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { setupModule } from '../src/modules/setup/index.js';
import { activateKey, InMemoryConfigRepo, publicView, revokeKey, StaticAllowlist, testKey, type SetupDeps } from '../src/modules/setup/service.js';
import { InMemorySecretStore, redact } from '../src/modules/setup/secrets.js';
import { InMemoryBudgetStore, maxBillableMicroUsd, actualMicroUsd, type Price } from '../src/modules/setup/budget.js';
import type { FetchLike } from '../src/modules/setup/providers.js';

const GOOD = 'sk-ant-test-GOODKEY1234';
const BAD = 'sk-ant-test-BADKEY99999';

/** Fake Anthropic API: 401 for BAD, optional 403 on /models, tool_use when tools are passed. */
function fakeAnthropic(opts: { listForbidden?: boolean } = {}): FetchLike {
  return async (url, init) => {
    const key = (init.headers as Record<string, string>)['x-api-key'];
    if (key !== GOOD) return new Response('{}', { status: 401 });
    if (url.includes('/v1/models')) {
      if (opts.listForbidden) return new Response('{}', { status: 403 });
      return Response.json({ data: [{ id: 'claude-sonnet-5-5' }, { id: 'claude-haiku-5-5' }, { id: 'claude-new-unverified' }] });
    }
    const body = JSON.parse(String(init.body));
    const content = body.tools ? [{ type: 'tool_use', id: 't1', name: 'echo', input: { value: 'ok' } }] : [{ type: 'text', text: 'pong' }];
    return Response.json({ content, usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: 'end_turn' });
  };
}

const allow = new StaticAllowlist({
  anthropic: {
    'claude-sonnet-5-5': { chat: true, tools: true, structured: true, stream: true },
    'claude-haiku-5-5': { chat: true, tools: true, structured: true, stream: true },
  },
});

function deps(fetchFn: FetchLike): SetupDeps & { secrets: InMemorySecretStore } {
  return { repo: new InMemoryConfigRepo(), secrets: new InMemorySecretStore(), allowlist: allow, fetchFn };
}
const cand = (apiKey: string) => ({ provider: 'anthropic' as const, apiKey, probeModel: 'claude-haiku-5-5' });

describe('Setup: key test', () => {
  it('only authentication failure marks the key invalid', async () => {
    expect((await testKey(cand(BAD), deps(fakeAnthropic()))).auth).toBe('invalid_key');
    const forbidden = await testKey(cand(GOOD), deps(fakeAnthropic({ listForbidden: true })));
    expect(forbidden.auth).toBe('ok');
    expect(forbidden.listing).toBe('not_permitted');
  });

  it('marks listed-but-unverified models as not selectable and verifies tool calling', async () => {
    const r = await testKey(cand(GOOD), deps(fakeAnthropic()));
    expect(r.tools).toBe('ok');
    const unverified = r.models.find((m) => m.id === 'claude-new-unverified');
    expect(unverified?.verified).toBeNull();
  });
});

describe('Setup: activation and rotation', () => {
  it('activates only after Key Vault write, never exposes the key, and rotates atomically', async () => {
    const d = deps(fakeAnthropic());
    let invalidations = 0;
    d.invalidateKeyCache = async () => void invalidations++;
    const t1 = await testKey(cand(GOOD), d);
    const rec1 = await activateKey('t1', cand(GOOD), { primary: 'claude-sonnet-5-5', economy: 'claude-haiku-5-5' }, t1, d);
    expect(rec1.status).toBe('configured');
    expect(JSON.stringify(publicView(rec1))).not.toContain(GOOD);
    expect(publicView(rec1).keyLast4).toBe('1234');

    const rec2 = await activateKey('t1', cand(GOOD), { primary: 'claude-haiku-5-5' }, t1, d);
    expect(rec2.secret?.version).not.toBe(rec1.secret?.version);
    expect(d.secrets.isEnabled(rec1.secret!)).toBe(false); // old version disabled, not deleted
    expect(d.secrets.isEnabled(rec2.secret!)).toBe(true);
    expect(invalidations).toBe(2);
    expect(rec2.history.some((h) => h.event === 'model_changed' && h.detail.publishedSopsNeedReview)).toBe(true);
    expect(publicView(rec2).reminder).toMatch(/provider console/);
  });

  it('does not activate when Key Vault write fails', async () => {
    const d = deps(fakeAnthropic());
    d.secrets.put = async () => {
      throw new Error('vault down');
    };
    const t = await testKey(cand(GOOD), d);
    await expect(activateKey('t1', cand(GOOD), { primary: 'claude-sonnet-5-5' }, t, d)).rejects.toThrow('vault down');
    expect((await d.repo.get('t1')).status).toBe('unconfigured');
  });

  it('refuses models that are not on the verified allowlist', async () => {
    const d = deps(fakeAnthropic());
    const t = await testKey(cand(GOOD), d);
    await expect(activateKey('t1', cand(GOOD), { primary: 'claude-new-unverified' }, t, d)).rejects.toThrow(/allowlist/);
  });

  it('revocation disables the version and reminds provider-side revocation', async () => {
    const d = deps(fakeAnthropic());
    const t = await testKey(cand(GOOD), d);
    const rec = await activateKey('t1', cand(GOOD), { primary: 'claude-sonnet-5-5' }, t, d);
    const rev = await revokeKey('t1', d);
    expect(rev.status).toBe('revoked');
    expect(d.secrets.isEnabled(rec.secret!)).toBe(false);
  });
});

describe('Setup routes', () => {
  it('rejects a bad key with 422 and never echoes the key', async () => {
    const app = Fastify();
    await app.register(setupModule, { prefix: '/api/v1/setup', deps: deps(fakeAnthropic()) });
    const res = await app.inject({ method: 'PUT', url: '/api/v1/setup/llm', payload: { ...cand(BAD), primaryModel: 'claude-sonnet-5-5' } });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(BAD);
    const ok = await app.inject({ method: 'PUT', url: '/api/v1/setup/llm', payload: { ...cand(GOOD), primaryModel: 'claude-sonnet-5-5' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).not.toContain(GOOD);
    expect(ok.json().keyLast4).toBe('1234');
  });
});

describe('Budget: bounded reservation keeps the cap hard under concurrency', () => {
  const price: Price = { inputPerMTokMicroUsd: 3_000_000, outputPerMTokMicroUsd: 15_000_000, fullyBoundable: true };

  it('never lets concurrent reservations exceed the cap, and frozen unknowns hold budget', async () => {
    const store = new InMemoryBudgetStore();
    store.setCap('t', '2026-11', 1_000_000); // $1.00
    const per = maxBillableMicroUsd(10_000, 2_000, price); // 0.03 + 0.03 = $0.06
    expect(per).toBe(60_000);
    const results = await Promise.all(Array.from({ length: 40 }, () => store.reserve('t', '2026-11', per)));
    const granted = results.filter(Boolean) as string[];
    expect(granted.length).toBe(16); // floor(1.00 / 0.06)
    // settle half with real usage, freeze one as unknown
    for (const id of granted.slice(0, 8)) await store.settle(id, actualMicroUsd(10_000, 1_000, price));
    await store.freeze(granted[8]!);
    const snap = store.snapshot('t', '2026-11');
    expect(snap.spent + snap.reserved).toBeLessThanOrEqual(snap.cap);
    expect(snap.reserved).toBeGreaterThanOrEqual(per); // frozen reservation still counted
  });

  it('settlement cannot charge above the reservation', async () => {
    const store = new InMemoryBudgetStore();
    store.setCap('t', 'm', 100_000);
    const id = (await store.reserve('t', 'm', 50_000))!;
    expect(await store.settle(id, 80_000)).toBe(0);
    expect(store.snapshot('t', 'm').spent).toBe(50_000);
  });
});

describe('redaction', () => {
  it('redacts key-like strings', () => {
    expect(redact(`failed with ${GOOD}`)).not.toContain('GOODKEY1234');
  });
});
