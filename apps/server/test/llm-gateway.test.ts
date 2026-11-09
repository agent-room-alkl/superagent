import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import pg from 'pg';
import type { ChatRequest, LlmProvider } from '@superagent/shared';
import { createLlmGateway, inputTokenUpperBound, LlmCallFailed, LlmUnavailable, StaticPriceBook } from '../src/modules/setup/llm-gateway.js';
import { InMemoryBudgetStore, type Price } from '../src/modules/setup/budget.js';
import { InMemorySecretStore } from '../src/modules/setup/secrets.js';
import { InMemoryConfigRepo } from '../src/modules/setup/service.js';
import { ProviderHttpError } from '../src/modules/setup/providers.js';
import { PgBudgetStore, PgPriceBook } from '../src/modules/setup/pg-budget.js';
import { migrate } from '../src/migrate.js';

const T = 'tenant-1';
const price: Price = { inputPerMTokMicroUsd: 3_000_000, outputPerMTokMicroUsd: 15_000_000, fullyBoundable: true };
const now = () => new Date('2026-11-09T00:00:00Z');

let repo: InMemoryConfigRepo;
let secrets: InMemorySecretStore;
let budget: InMemoryBudgetStore;
let calls: { req: ChatRequest; apiKey: string }[];
let behave: (req: ChatRequest) => Promise<{ inputTokens: number; outputTokens: number }>;

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

const gw = (prices: Record<string, Price> = { 'anthropic/model-big': price, 'anthropic/model-small': { ...price, outputPerMTokMicroUsd: 1_000_000 } }) =>
  createLlmGateway({ repo, secrets, budget, prices: new StaticPriceBook(prices), providerFactory: (cfg) => fakeProvider(cfg.apiKey), now });
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

  it('price unknown or unboundable → refused (no soft cap)', async () => {
    await configure();
    budget.setCap(T, '2026-11', 1_000_000);
    expect(await code(gw({}).chat(T, 'primary', req))).toBe('price_unknown');
    expect(await code(gw({ 'anthropic/model-big': { ...price, fullyBoundable: false } }).chat(T, 'primary', req))).toBe('price_unknown');
    expect(calls).toEqual([]);
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
    const bound = inputTokenUpperBound(req);
    expect(bound).toBeGreaterThanOrEqual(20);
    expect(r.reservedMicroUsd).toBe(Math.ceil((bound * 3_000_000) / 1e6) + Math.ceil((1000 * 15_000_000) / 1e6));
    expect(r.costMicroUsd).toBe(60 + 4500);
    expect(budget.snapshot(T, '2026-11')).toEqual({ cap: 1_000_000, reserved: 0, spent: 4560 });
  });

  it('the input bound never undercounts: UTF-8 bytes ≥ tokens, including CJK text', () => {
    const cjk = { messages: [{ role: 'user' as const, content: '请根据审批制度总结报销流程' }], maxOutputTokens: 1 };
    expect(inputTokenUpperBound(cjk)).toBeGreaterThanOrEqual(Buffer.byteLength('请根据审批制度总结报销流程', 'utf8'));
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

  it('price book returns verified prices only', async () => {
    await pool.query(
      `INSERT INTO model_capabilities (provider, model_id, capabilities, status) VALUES
       ('anthropic','priced','{"price":{"inputPerMTokMicroUsd":3000000,"outputPerMTokMicroUsd":15000000,"fullyBoundable":true}}','verified'),
       ('anthropic','unpriced','{}','verified'),
       ('anthropic','pending','{"price":{"inputPerMTokMicroUsd":1,"outputPerMTokMicroUsd":1,"fullyBoundable":true}}','unverified')
       ON CONFLICT (provider, model_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, status = EXCLUDED.status`,
    );
    const book = new PgPriceBook(pool);
    expect(await book.price('anthropic', 'priced')).toEqual({ inputPerMTokMicroUsd: 3_000_000, outputPerMTokMicroUsd: 15_000_000, fullyBoundable: true });
    expect(await book.price('anthropic', 'unpriced')).toBeNull();
    expect(await book.price('anthropic', 'pending')).toBeNull();
  });
});
