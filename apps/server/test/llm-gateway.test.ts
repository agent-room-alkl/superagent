import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import type { ChatRequest, LlmProvider } from '@superagent/shared';
import { createLlmGateway, inputTokenUpperBound, LlmCallFailed, LlmUnavailable, StaticPriceBook, type PricedModel } from '../src/modules/setup/llm-gateway.js';
import { InMemoryBudgetStore } from '../src/modules/setup/budget.js';
import { InMemorySecretStore } from '../src/modules/setup/secrets.js';
import { InMemoryConfigRepo } from '../src/modules/setup/service.js';
import { ProviderHttpError } from '../src/modules/setup/providers.js';
import { PgBudgetStore, PgPriceBook } from '../src/modules/setup/pg-budget.js';
import { migrate } from '../src/migrate.js';

const T = 'tenant-1';
const overheadTokens = { perRequest: 50, perMessage: 10, perTool: 40 };
const price: PricedModel = { inputPerMTokMicroUsd: 3_000_000, outputPerMTokMicroUsd: 15_000_000, fullyBoundable: true, overheadTokens };
const now = () => new Date('2026-11-09T00:00:00Z');

let repo: InMemoryConfigRepo;
let secrets: InMemorySecretStore;
let budget: InMemoryBudgetStore;
let calls: { req: ChatRequest; apiKey: string }[];
let behave: (req: ChatRequest) => Promise<{ inputTokens: number; outputTokens: number }>;
let book: StaticPriceBook;

const fakeProvider = (apiKey: string): LlmProvider => ({
  id: 'anthropic',
  listModels: async () => [],
  structured: async () => {
    throw new Error('unused');
  },
  chat: async (req) => {
    calls.push({ req, apiKey });
    const usage = await behave(req);
    return { text: 'ok', toolCalls: [], usage, stopReason: 'end' };
  },
});

async function configure(over: Partial<Awaited<ReturnType<InMemoryConfigRepo['get']>>> = {}) {
  const ref = await secrets.put('llm-provider-key', 'sk-test-placeholder');
  const rec = await repo.get(T);
  await repo.save({ ...rec, provider: 'anthropic', secret: ref, keyLast4: 'lder', primaryModel: 'model-big', economyModel: 'model-small', status: 'configured', ...over });
}

const defaults = () => ({ 'anthropic/model-big': price, 'anthropic/model-small': { ...price, outputPerMTokMicroUsd: 1_000_000 } });
const gw = (prices: Record<string, PricedModel> = defaults(), timeoutMs?: number) => {
  book = new StaticPriceBook(prices);
  return createLlmGateway({ repo, secrets, budget, prices: book, providerFactory: (cfg) => fakeProvider(cfg.apiKey), now, timeoutMs });
};
const req = { messages: [{ role: 'user' as const, content: 'Summarise the approval policy' }], maxOutputTokens: 1000 };

beforeEach(() => {
  repo = new InMemoryConfigRepo();
  secrets = new InMemorySecretStore();
  budget = new InMemoryBudgetStore();
  calls = [];
  behave = async () => ({ inputTokens: 20, outputTokens: 300 });
});

const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e) => (e instanceof LlmUnavailable ? e.code : `other:${e?.message}`));

describe('budgeted LLM gateway: refusals happen before any model call', () => {
  it('not configured / key invalid / model not selected', async () => {
    expect(await code(gw().chat(T, 'primary', req))).toBe('llm_not_configured');
    await configure({ status: 'key_invalid' });
    expect(await code(gw().chat(T, 'primary', req))).toBe('llm_key_invalid');
    await configure({ primaryModel: null, economyModel: null });
    expect(await code(gw().chat(T, 'primary', req))).toBe('model_not_selected');
    expect(calls).toEqual([]);
  });

  it('price unknown, unboundable or malformed (negative, fractional, NaN, missing overhead) → refused (no soft cap)', async () => {
    await configure();
    budget.setCap(T, '2026-11', 1_000_000);
    const bad = (p: Partial<PricedModel>) => gw({ 'anthropic/model-big': { ...price, ...p } as PricedModel }).chat(T, 'primary', req);
    expect(await code(gw({}).chat(T, 'primary', req))).toBe('price_unknown');
    expect(await code(bad({ fullyBoundable: false }))).toBe('price_unknown');
    expect(await code(bad({ inputPerMTokMicroUsd: -1 }))).toBe('price_unknown');
    expect(await code(bad({ outputPerMTokMicroUsd: 1.5 }))).toBe('price_unknown');
    expect(await code(bad({ inputPerMTokMicroUsd: Number.NaN }))).toBe('price_unknown');
    expect(await code(bad({ overheadTokens: undefined as unknown as PricedModel['overheadTokens'] }))).toBe('price_unknown');
    expect(await code(bad({ overheadTokens: { perRequest: -5, perMessage: 0, perTool: 0 } }))).toBe('price_unknown');
    expect(calls).toEqual([]);
    expect(budget.snapshot(T, '2026-11')).toMatchObject({ reserved: 0, spent: 0 });
  });

  it('no budget set → budget_not_set; cap too small → budget_exhausted; check() reports the same codes', async () => {
    await configure();
    expect(await code(gw().chat(T, 'primary', req))).toBe('budget_not_set');
    budget.setCap(T, '2026-11', 100);
    expect(await code(gw().chat(T, 'primary', req))).toBe('budget_exhausted');
    expect(calls).toEqual([]);
    expect(await createLlmGateway({ repo: new InMemoryConfigRepo(), secrets, budget, prices: new StaticPriceBook({}) }).check(T, 'primary')).toEqual({ ok: false, code: 'llm_not_configured' });
    expect(await gw().check(T, 'economy')).toEqual({ ok: true, model: 'model-small' });
  });
});

describe('budgeted LLM gateway: reservation, settlement, release, freeze', () => {
  beforeEach(async () => {
    await configure();
    budget.setCap(T, '2026-11', 1_000_000);
  });

  it('reserves a provable upper bound, calls with the key from the secret store, settles actual usage', async () => {
    const r = await gw().chat(T, 'primary', req);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.model).toBe('model-big');
    expect(calls[0]!.apiKey).toBe('sk-test-placeholder');
    const bound = inputTokenUpperBound(req, overheadTokens);
    expect(bound).toBe(Buffer.byteLength(JSON.stringify({ messages: req.messages, tools: [] }), 'utf8') + 50 + 10 * 1);
    expect(r.reservedMicroUsd).toBe(Math.ceil((bound * 3_000_000) / 1e6) + Math.ceil((1000 * 15_000_000) / 1e6));
    expect(r.costMicroUsd).toBe(60 + 4500);
    expect(budget.snapshot(T, '2026-11')).toEqual({ cap: 1_000_000, reserved: 0, spent: 4560 });
  });

  it('the input bound never undercounts: UTF-8 bytes ≥ tokens, including CJK text', () => {
    const cjk = { messages: [{ role: 'user' as const, content: '请根据审批制度总结报销流程' }], maxOutputTokens: 1 };
    expect(inputTokenUpperBound(cjk, overheadTokens)).toBeGreaterThanOrEqual(Buffer.byteLength('请根据审批制度总结报销流程', 'utf8') + 60);
    const withTools = { ...cjk, tools: [{ name: 'lookup', description: 'd', inputSchema: {} }, { name: 'save', description: 'd', inputSchema: {} }] };
    expect(inputTokenUpperBound(withTools, overheadTokens) - inputTokenUpperBound(cjk, overheadTokens)).toBeGreaterThanOrEqual(80);
  });

  it('economy tier uses the economy model and its price; falls back to primary when unset', async () => {
    await gw().chat(T, 'economy', req);
    expect(calls.at(-1)!.req.model).toBe('model-small');
    await configure({ economyModel: null });
    await gw().chat(T, 'economy', req);
    expect(calls.at(-1)!.req.model).toBe('model-big');
  });

  it('provider refusal (4xx) releases the reservation; 401 surfaces as llm_key_invalid', async () => {
    behave = async () => {
      throw new ProviderHttpError(400, 'other', 'bad request');
    };
    const e = await gw().chat(T, 'primary', req).catch((x) => x);
    expect(e).toBeInstanceOf(LlmCallFailed);
    expect(e.billing).toBe('released');
    expect(budget.snapshot(T, '2026-11')).toMatchObject({ reserved: 0, spent: 0 });
    behave = async () => {
      throw new ProviderHttpError(401, 'auth', 'unauthorized');
    };
    expect(await code(gw().chat(T, 'primary', req))).toBe('llm_key_invalid');
    expect(budget.snapshot(T, '2026-11')).toMatchObject({ reserved: 0, spent: 0 });
  });

  it('network error / 5xx → reservation frozen (unknown outcome keeps holding budget)', async () => {
    behave = async () => {
      throw new TypeError('fetch failed');
    };
    const e = await gw().chat(T, 'primary', req).catch((x) => x);
    expect(e).toMatchObject({ billing: 'frozen_unknown', providerStatus: null });
    const held = budget.snapshot(T, '2026-11').reserved;
    expect(held).toBeGreaterThan(0);
    behave = async () => {
      throw new ProviderHttpError(503, 'transient', 'unavailable');
    };
    await gw().chat(T, 'primary', req).catch(() => undefined);
    expect(budget.snapshot(T, '2026-11').reserved).toBe(held * 2);
  });

  it('cost above the reservation is never truncated: reservation frozen, model record suspended, next call refused', async () => {
    behave = async (r) => ({ inputTokens: 1_000_000, outputTokens: r.maxOutputTokens }); // provider overran the stated bound
    const e = await gw().chat(T, 'primary', req).catch((x) => x);
    expect(e).toBeInstanceOf(LlmCallFailed);
    expect(e.billing).toBe('frozen_unknown');
    expect(e.message).toMatch(/exceeded the reserved upper bound/);
    expect(budget.snapshot(T, '2026-11').spent).toBe(0);
    expect(budget.snapshot(T, '2026-11').reserved).toBeGreaterThan(0);
    expect(book.violations.map((v) => v.key)).toEqual(['anthropic/model-big']);
    expect(await code(createLlmGateway({ repo, secrets, budget, prices: book, providerFactory: (cfg) => fakeProvider(cfg.apiKey), now }).chat(T, 'primary', req))).toBe('price_unknown');
  });

  it('unusable usage figures (negative / fractional / missing) freeze the reservation', async () => {
    for (const usage of [{ inputTokens: -1, outputTokens: 5 }, { inputTokens: 1.5, outputTokens: 5 }, undefined]) {
      behave = async () => usage as unknown as { inputTokens: number; outputTokens: number };
      const e = await gw().chat(T, 'primary', req).catch((x) => x);
      expect(e).toMatchObject({ billing: 'frozen_unknown' });
    }
    expect(budget.snapshot(T, '2026-11').spent).toBe(0);
  });

  it('a provider call that never returns hits the deadline and freezes its reservation', async () => {
    behave = () => new Promise(() => undefined);
    const e = await gw(defaults(), 20).chat(T, 'primary', req).catch((x) => x);
    expect(e).toMatchObject({ billing: 'frozen_unknown' });
    expect(e.message).toMatch(/exceeded 20 ms/);
    expect(budget.snapshot(T, '2026-11').reserved).toBeGreaterThan(0);
  });

  it('rejects requests without a positive maxOutputTokens', async () => {
    await expect(gw().chat(T, 'primary', { ...req, maxOutputTokens: 0 })).rejects.toThrow(/maxOutputTokens/);
  });
});

const url = process.env.DATABASE_URL;
(url ? describe : describe.skip)('PgBudgetStore against PostgreSQL', () => {
  const pool = new pg.Pool({ connectionString: url, max: 8 });
  afterAll(() => pool.end());
  const tenant = '00000000-0000-0000-0000-0000000000b1';

  it('opens the month from llm_config cap; concurrent reservations never exceed it; settle/release/freeze are recorded', async () => {
    await migrate(pool, undefined, () => undefined);
    await pool.query('DELETE FROM llm_budget WHERE tenant_id = $1', [tenant]);
    await pool.query('DELETE FROM llm_config WHERE tenant_id = $1', [tenant]);
    const store = new PgBudgetStore(pool);
    expect(await store.capFor(tenant, '2026-11')).toBeNull();
    await pool.query("INSERT INTO llm_config (tenant_id, status, monthly_cap_micro_usd) VALUES ($1, 'configured', 1000000)", [tenant]);
    expect(await store.capFor(tenant, '2026-11')).toBe(1_000_000);

    const ids = await Promise.all(Array.from({ length: 30 }, () => store.reserve(tenant, '2026-11', 60_000, { provider: 'anthropic', model: 'm' })));
    const granted = ids.filter((x): x is string => !!x);
    expect(granted).toHaveLength(16);
    const b = (await pool.query('SELECT reserved_micro_usd::int r, spent_micro_usd::int s, cap_micro_usd::int c FROM llm_budget WHERE tenant_id = $1', [tenant])).rows[0];
    expect(b.r + b.s).toBeLessThanOrEqual(b.c);

    expect(await store.settle(granted[0]!, 99_999_999, { inputTokens: 10, outputTokens: 5 })).toBe(0); // capped at the reservation
    await store.release(granted[1]!);
    await store.freeze(granted[2]!);
    await expect(store.release(granted[0]!)).rejects.toThrow(/not in/);
    const rows = (await pool.query('SELECT id, status, cost_micro_usd::int cost, month FROM llm_usage WHERE id = ANY($1)', [granted.slice(0, 3)])).rows;
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by[granted[0]!]).toMatchObject({ status: 'settled', cost: 60_000, month: '2026-11' });
    expect(by[granted[1]!]).toMatchObject({ status: 'released', cost: 0 });
    expect(by[granted[2]!]).toMatchObject({ status: 'frozen_unknown' });
    const after = (await pool.query('SELECT reserved_micro_usd::int r, spent_micro_usd::int s FROM llm_budget WHERE tenant_id = $1', [tenant])).rows[0];
    expect(after).toEqual({ r: 14 * 60_000, s: 60_000 });
  });

  it('price book returns valid verified records only; a bound violation suspends the record', async () => {
    const oh = '"overheadTokens":{"perRequest":50,"perMessage":10,"perTool":40}';
    await pool.query(
      `INSERT INTO model_capabilities (provider, model_id, capabilities, status) VALUES
       ('anthropic','priced','{"price":{"inputPerMTokMicroUsd":3000000,"outputPerMTokMicroUsd":15000000,"fullyBoundable":true,${oh}}}','verified'),
       ('anthropic','no-overhead','{"price":{"inputPerMTokMicroUsd":3000000,"outputPerMTokMicroUsd":15000000,"fullyBoundable":true}}','verified'),
       ('anthropic','negative','{"price":{"inputPerMTokMicroUsd":-3,"outputPerMTokMicroUsd":15000000,"fullyBoundable":true,${oh}}}','verified'),
       ('anthropic','unpriced','{}','verified'),
       ('anthropic','pending','{"price":{"inputPerMTokMicroUsd":1,"outputPerMTokMicroUsd":1,"fullyBoundable":true,${oh}}}','unverified')
       ON CONFLICT (provider, model_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, status = EXCLUDED.status`,
    );
    const pgBook = new PgPriceBook(pool);
    expect(await pgBook.price('anthropic', 'priced')).toEqual({ inputPerMTokMicroUsd: 3_000_000, outputPerMTokMicroUsd: 15_000_000, fullyBoundable: true, overheadTokens: { perRequest: 50, perMessage: 10, perTool: 40 } });
    for (const m of ['no-overhead', 'negative', 'unpriced', 'pending']) expect(await pgBook.price('anthropic', m)).toBeNull();
    await pgBook.markUnbounded('anthropic', 'priced', { reserved: 10, cost: 99 });
    expect(await pgBook.price('anthropic', 'priced')).toBeNull();
    const row = (await pool.query("SELECT status, capabilities->'boundViolation'->>'cost' AS cost FROM model_capabilities WHERE provider = 'anthropic' AND model_id = 'priced'")).rows[0];
    expect(row).toEqual({ status: 'unverified', cost: '99' });
  });
});
