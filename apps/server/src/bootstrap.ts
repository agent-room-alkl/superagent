/**
 * Production bootstrap: the single place where real adapters are wired (Entra, PostgreSQL, Key Vault, Blob,
 * Document Intelligence). Fail closed: with a real identity provider every dependency must be configured, otherwise
 * the process refuses to start and names the missing settings (never their values). In-memory stores exist only in
 * AUTH_MODE=dev, which authConfigFromEnv already refuses when NODE_ENV=production.
 */
import type pg from 'pg';
import { authConfigFromEnv, type AuthConfig } from './auth.js';
import type { AppOptions, ReadinessCheck } from './app.js';
import type { SetupDeps } from './modules/setup/service.js';
import { parseSourceDatabaseConfig, type SourceDatabaseConfig } from './modules/knowledge/database-config.js';
import { createLlmGateway, StaticPriceBook, type LlmGateway } from './modules/setup/llm-gateway.js';

export class BootstrapError extends Error {
  constructor(public missing: string[], detail?: string) {
    super(detail ?? `Refusing to start: missing or invalid settings: ${missing.join(', ')}`);
    this.name = 'BootstrapError';
  }
}

/** Shared runtime endpoints modules read from here instead of from process.env directly. */
export interface RuntimeConfig {
  mode: 'production' | 'dev';
  platformTenantId: string;
  blobUrl: string | null;
  docIntelEndpoint: string | null;
  sourceDatabases?: SourceDatabaseConfig[];
}

export interface Runtime {
  config: RuntimeConfig;
  /** The one PostgreSQL pool for this process (null in AUTH_MODE=dev). Modules receive it from here, never create their own. */
  pool: pg.Pool | null;
  /** Budgeted model access for every module (analysis, employees). Refuses with LlmUnavailable codes; never fakes. */
  llm: LlmGateway;
  app: AppOptions & { auth: AuthConfig; setupDeps: SetupDeps; readiness: ReadinessCheck[] };
  close(): Promise<void>;
}

export interface Factories {
  pool(env: NodeJS.ProcessEnv): pg.Pool;
  keyVault(url: string): Promise<SetupDeps['secrets']>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function checkProductionEnv(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  for (const k of ['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'KEY_VAULT_URL', 'BLOB_URL', 'DOC_INTEL_ENDPOINT']) if (!env[k]) missing.push(k);
  if (!env.DATABASE_URL && !(env.PG_HOST && env.PG_USER)) missing.push('DATABASE_URL or PG_HOST+PG_USER');
  if (!env.PLATFORM_TENANT_ID || !UUID.test(env.PLATFORM_TENANT_ID)) missing.push('PLATFORM_TENANT_ID (uuid)');
  if (env.KEY_VAULT_URL && !/^https:\/\//.test(env.KEY_VAULT_URL)) missing.push('KEY_VAULT_URL (https)');
  return missing;
}

export async function createRuntime(env: NodeJS.ProcessEnv = process.env, factories?: Partial<Factories>): Promise<Runtime> {
  const auth = authConfigFromEnv(env); // throws for AUTH_MODE=dev in production
  const sourceDatabases = parseSourceDatabaseConfig(env.SOURCE_DATABASES_JSON);
  if (auth.mode === 'dev') { const runtime = await devRuntime(auth); if (sourceDatabases.length) runtime.config.sourceDatabases = sourceDatabases; return runtime; }

  const missing = checkProductionEnv(env);
  if (missing.length) throw new BootstrapError(missing);

  const pool = factories?.pool ? factories.pool(env) : (await import('./db/client.js')).createDb(env).pool;
  const secrets = factories?.keyVault
    ? await factories.keyVault(env.KEY_VAULT_URL!)
    : await (await import('./modules/setup/secrets.js')).createKeyVaultStore(env.KEY_VAULT_URL!);
  const { PgAllowlist, PgConfigRepo } = await import('./modules/setup/pg-repo.js');
  const { PgBudgetStore, PgPriceBook } = await import('./modules/setup/pg-budget.js');
  const repo = new PgConfigRepo(pool);
  return {
    pool,
    llm: createLlmGateway({ repo, secrets, budget: new PgBudgetStore(pool), prices: new PgPriceBook(pool) }),
    config: { mode: 'production', platformTenantId: env.PLATFORM_TENANT_ID!, blobUrl: env.BLOB_URL!, docIntelEndpoint: env.DOC_INTEL_ENDPOINT!, ...(sourceDatabases.length ? { sourceDatabases } : {}) },
    app: {
      auth: { ...auth, platformTenantId: env.PLATFORM_TENANT_ID! },
      setupDeps: { repo, secrets, allowlist: new PgAllowlist(pool) },
      readiness: [{ name: 'postgres', check: async () => (await pool.query('SELECT 1 AS ok')).rows[0]?.ok === 1 }],
    },
    close: () => pool.end(),
  };
}

async function devRuntime(auth: AuthConfig): Promise<Runtime> {
  const { InMemoryConfigRepo, StaticAllowlist } = await import('./modules/setup/service.js');
  const { InMemorySecretStore } = await import('./modules/setup/secrets.js');
  const { InMemoryBudgetStore } = await import('./modules/setup/budget.js');
  const repo = new InMemoryConfigRepo();
  const secrets = new InMemorySecretStore();
  console.warn(JSON.stringify({ msg: 'AUTH_MODE=dev: in-memory stores, x-dev-user header accepted. Never use outside local development.' }));
  return {
    pool: null,
    // Dev: calls are refused (budget_not_set / price_unknown) until a cap is set in Setup and a priced model exists.
    llm: createLlmGateway({ repo, secrets, budget: new InMemoryBudgetStore({ capOf: async (t) => (await repo.get(t)).monthlyCapMicroUsd }), prices: new StaticPriceBook({}) }),
    config: { mode: 'dev', platformTenantId: auth.platformTenantId, blobUrl: null, docIntelEndpoint: null },
    app: { auth, setupDeps: { repo, secrets, allowlist: new StaticAllowlist({}) }, readiness: [] },
    close: async () => undefined,
  };
}
