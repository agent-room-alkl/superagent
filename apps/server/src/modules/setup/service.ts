/**
 * Setup service (PRD §3.1): test → write Key Vault → atomic activation → disable old version.
 * The raw key never reaches the database, logs, or responses; only the secret reference and last 4 chars.
 */
import type { LlmProviderId, ModelInfo } from '@superagent/shared';
import { createProvider, ProviderHttpError, type FetchLike } from './providers.js';
import type { SecretStore, SecretVersion } from './secrets.js';

export const SECRET_NAME = 'llm-provider-key';

export interface LlmConfigRecord {
  tenantId: string;
  provider: LlmProviderId | null;
  endpoint: string | null;
  secret: SecretVersion | null;
  keyLast4: string | null;
  primaryModel: string | null;
  economyModel: string | null;
  status: 'unconfigured' | 'configured' | 'revoked' | 'key_invalid';
  /** Hard monthly model budget in micro-USD; null = not set (model calls are refused with budget_not_set). */
  monthlyCapMicroUsd: number | null;
  history: { at: string; event: string; detail: Record<string, unknown> }[];
}

export interface ConfigRepo {
  get(tenantId: string): Promise<LlmConfigRecord>;
  /** Must be a single transaction in production (one UPDATE). */
  save(rec: LlmConfigRecord): Promise<void>;
}

export interface Allowlist {
  /** Models the platform has capability-tested, with results. */
  verified(provider: LlmProviderId): Promise<Map<string, ModelInfo['verified']>>;
}

export interface TestResult {
  auth: 'ok' | 'invalid_key' | 'quota' | 'network' | 'error';
  listing: 'ok' | 'not_permitted' | 'failed';
  tools: 'ok' | 'failed' | 'skipped';
  models: ModelInfo[];
  message: string;
}

export interface SetupDeps {
  repo: ConfigRepo;
  secrets: SecretStore;
  allowlist: Allowlist;
  fetchFn?: FetchLike;
  /** Called after activation so every process drops its cached key. */
  invalidateKeyCache?: () => Promise<void>;
  now?: () => Date;
}

export interface CandidateKey {
  provider: LlmProviderId;
  apiKey: string;
  endpoint?: string;
  probeModel: string; // a model/deployment id used for the minimal auth call
  deployments?: string[];
}

/** Three separate checks. Only an authentication failure marks the key invalid (PRD §3.1). */
export async function testKey(c: CandidateKey, deps: Pick<SetupDeps, 'allowlist' | 'fetchFn'>): Promise<TestResult> {
  const p = createProvider({ provider: c.provider, apiKey: c.apiKey, endpoint: c.endpoint, deployments: c.deployments }, deps.fetchFn);
  const result: TestResult = { auth: 'error', listing: 'failed', tools: 'skipped', models: [], message: '' };
  try {
    await p.chat({ model: c.probeModel, messages: [{ role: 'user', content: 'ping' }], maxOutputTokens: 16 });
    result.auth = 'ok';
  } catch (e) {
    result.auth = e instanceof ProviderHttpError ? (e.kind === 'auth' ? 'invalid_key' : e.kind === 'quota' ? 'quota' : 'error') : 'network';
    result.message = e instanceof ProviderHttpError ? `provider ${e.status}` : 'network error';
    return result;
  }
  try {
    const listed = await p.listModels();
    const verified = await deps.allowlist.verified(c.provider);
    result.models = listed.map((m) => ({ ...m, verified: verified.get(m.id) ?? null }));
    result.listing = 'ok';
  } catch (e) {
    result.listing = e instanceof ProviderHttpError && (e.kind === 'forbidden' || e.kind === 'auth') ? 'not_permitted' : 'failed';
    result.message = 'Cannot list models automatically; enter an allowlisted model id.';
  }
  try {
    const r = await p.chat({
      model: c.probeModel,
      messages: [{ role: 'user', content: 'Call the echo tool with value "ok".' }],
      tools: [{ name: 'echo', description: 'Echo a value', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }],
      maxOutputTokens: 64,
    });
    result.tools = r.toolCalls.some((t) => t.name === 'echo') ? 'ok' : 'failed';
  } catch {
    result.tools = 'failed';
  }
  return result;
}

/** Selectable = listed by provider ∩ verified allowlist. Unverified models are visible but not selectable. */
export function selectableModels(models: ModelInfo[]): { selectable: ModelInfo[]; unverified: ModelInfo[] } {
  const selectable = models.filter((m) => m.verified?.chat && m.verified.tools);
  return { selectable, unverified: models.filter((m) => !selectable.includes(m)) };
}

function stamp(rec: LlmConfigRecord, event: string, detail: Record<string, unknown>, now: Date) {
  rec.history.push({ at: now.toISOString(), event, detail });
}

/**
 * Activate (first time) or rotate a key:
 * 1) caller has already run testKey with auth === 'ok'
 * 2) write new Key Vault version (throws → nothing changes)
 * 3) one save() switches config to the new version, then caches are invalidated
 * 4) old version is disabled (not deleted)
 */
export async function activateKey(
  tenantId: string,
  c: CandidateKey,
  models: { primary: string; economy?: string },
  test: TestResult,
  deps: SetupDeps,
): Promise<LlmConfigRecord> {
  if (test.auth !== 'ok') throw new Error('key must pass the authentication test before activation');
  const verified = await deps.allowlist.verified(c.provider);
  for (const id of [models.primary, models.economy].filter(Boolean) as string[]) {
    const v = verified.get(id);
    if (!v?.chat || !v.tools) throw new Error(`model ${id} is not on the verified allowlist`);
  }
  const now = (deps.now ?? (() => new Date()))();
  const newRef = await deps.secrets.put(SECRET_NAME, c.apiKey); // throws on failure → no activation
  const rec = await deps.repo.get(tenantId);
  const oldRef = rec.secret;
  const modelChanged = rec.primaryModel !== null && rec.primaryModel !== models.primary;
  const next: LlmConfigRecord = {
    ...rec,
    provider: c.provider,
    endpoint: c.endpoint ?? null,
    secret: newRef,
    keyLast4: c.apiKey.slice(-4),
    primaryModel: models.primary,
    economyModel: models.economy ?? null,
    status: 'configured',
    history: [...rec.history],
  };
  stamp(next, oldRef ? 'key_rotated' : 'key_activated', { provider: c.provider, version: newRef.version }, now);
  if (modelChanged) stamp(next, 'model_changed', { from: rec.primaryModel, to: models.primary, publishedSopsNeedReview: true }, now);
  await deps.repo.save(next);
  await deps.invalidateKeyCache?.();
  if (oldRef) await deps.secrets.disable(oldRef);
  return next;
}

export async function revokeKey(tenantId: string, deps: SetupDeps): Promise<LlmConfigRecord> {
  const rec = await deps.repo.get(tenantId);
  const now = (deps.now ?? (() => new Date()))();
  const next: LlmConfigRecord = { ...rec, status: 'revoked', history: [...rec.history] };
  stamp(next, 'key_revoked', { remindProviderRevocation: true }, now);
  await deps.repo.save(next);
  await deps.invalidateKeyCache?.();
  if (rec.secret) await deps.secrets.disable(rec.secret);
  return next;
}

/** Upper limit for a monthly cap: 1,000,000 USD. */
export const MAX_MONTHLY_CAP_MICRO_USD = 1_000_000 * 1_000_000;

/** Sets the hard monthly budget (PRD §3.1). Takes effect for the current month immediately; lowering it below
 * what is already spent or reserved simply blocks further calls. */
export async function setMonthlyCap(tenantId: string, capMicroUsd: number, actor: string, deps: Pick<SetupDeps, 'repo' | 'now'>): Promise<LlmConfigRecord> {
  if (!Number.isSafeInteger(capMicroUsd) || capMicroUsd <= 0 || capMicroUsd > MAX_MONTHLY_CAP_MICRO_USD) throw new Error('cap must be a positive amount up to 1,000,000 USD');
  const rec = await deps.repo.get(tenantId);
  const now = (deps.now ?? (() => new Date()))();
  const next: LlmConfigRecord = { ...rec, monthlyCapMicroUsd: capMicroUsd, history: [...rec.history] };
  stamp(next, 'budget_cap_set', { from: rec.monthlyCapMicroUsd, to: capMicroUsd, actor }, now);
  await deps.repo.save(next);
  return next;
}

/** Public view: never includes the key or secret reference. */
export function publicView(rec: LlmConfigRecord) {
  return {
    status: rec.status,
    provider: rec.provider,
    keyLast4: rec.keyLast4,
    primaryModel: rec.primaryModel,
    economyModel: rec.economyModel,
    monthlyCapMicroUsd: rec.monthlyCapMicroUsd,
    reminder: rec.history.some((h) => h.event === 'key_rotated' || h.event === 'key_revoked')
      ? 'Disabling a version here does not revoke the old key at the provider. Revoke it in the provider console.'
      : null,
  };
}

export class InMemoryConfigRepo implements ConfigRepo {
  private recs = new Map<string, LlmConfigRecord>();
  async get(tenantId: string): Promise<LlmConfigRecord> {
    return structuredClone(
      this.recs.get(tenantId) ?? {
        tenantId,
        provider: null,
        endpoint: null,
        secret: null,
        keyLast4: null,
        primaryModel: null,
        economyModel: null,
        status: 'unconfigured',
        monthlyCapMicroUsd: null,
        history: [],
      },
    );
  }
  async save(rec: LlmConfigRecord): Promise<void> {
    this.recs.set(rec.tenantId, structuredClone(rec));
  }
}

export class StaticAllowlist implements Allowlist {
  constructor(private entries: Record<string, Record<string, ModelInfo['verified']>>) {}
  async verified(provider: LlmProviderId) {
    return new Map(Object.entries(this.entries[provider] ?? {}));
  }
}
