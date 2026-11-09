import { describe, it, expect, afterAll, afterEach } from 'vitest';
import pg from 'pg';
import { BootstrapError, checkProductionEnv, createRuntime } from '../src/bootstrap.js';
import { buildApp } from '../src/app.js';
import { InMemorySecretStore } from '../src/modules/setup/secrets.js';
import { PgAllowlist, PgConfigRepo } from '../src/modules/setup/pg-repo.js';
import { migrate } from '../src/migrate.js';

const prodEnv = {
  NODE_ENV: 'production',
  AUTH_MODE: 'entra',
  ENTRA_TENANT_ID: '00000000-0000-0000-0000-000000000001',
  ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000002',
  PLATFORM_TENANT_ID: '00000000-0000-0000-0000-000000000003',
  KEY_VAULT_URL: 'https://kv.invalid/',
  DATABASE_URL: 'postgres://app@pg.invalid:5432/superagent',
  BLOB_URL: 'https://blob.invalid/',
  DOC_INTEL_ENDPOINT: 'https://di.invalid/',
};

const fakePool = (ok = true) => ({ query: async () => (ok ? { rows: [{ ok: 1 }] } : Promise.reject(new Error('down'))), end: async () => undefined }) as unknown as pg.Pool;

describe('production bootstrap fails closed', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = saved;
  });

  it('refuses AUTH_MODE=dev in production', async () => {
    await expect(createRuntime({ ...prodEnv, AUTH_MODE: 'dev' })).rejects.toThrow(/not allowed in production/);
  });

  it('names every missing setting and never echoes values', async () => {
    const err = await createRuntime({ NODE_ENV: 'production' }).catch((e) => e);
    expect(err).toBeInstanceOf(BootstrapError);
    expect(err.missing).toEqual(['ENTRA_TENANT_ID', 'ENTRA_CLIENT_ID', 'KEY_VAULT_URL', 'BLOB_URL', 'DOC_INTEL_ENDPOINT', 'DATABASE_URL or PG_HOST+PG_USER', 'PLATFORM_TENANT_ID (uuid)']);
    const partial = await createRuntime({ ...prodEnv, PLATFORM_TENANT_ID: 'default', KEY_VAULT_URL: 'http://plain' }).catch((e) => e);
    expect(partial.missing).toEqual(['PLATFORM_TENANT_ID (uuid)', 'KEY_VAULT_URL (https)']);
    expect(partial.message).not.toContain('http://plain');
  });

  it('accepts PG_HOST+PG_USER (Entra token password) instead of DATABASE_URL', () => {
    const { DATABASE_URL: _, ...rest } = prodEnv;
    expect(checkProductionEnv({ ...rest, PG_HOST: 'h', PG_USER: 'u' })).toEqual([]);
  });

  it('wires PostgreSQL + Key Vault adapters, the platform tenant and a postgres readiness check', async () => {
    const vaults: string[] = [];
    const pool = fakePool();
    const rt = await createRuntime(prodEnv, { pool: () => pool, keyVault: async (u) => (vaults.push(u), new InMemorySecretStore()) });
    expect(rt.pool).toBe(pool); // shared with modules (knowledge, runtime) instead of each creating its own
    expect(rt.config).toEqual({ mode: 'production', platformTenantId: prodEnv.PLATFORM_TENANT_ID, blobUrl: prodEnv.BLOB_URL, docIntelEndpoint: prodEnv.DOC_INTEL_ENDPOINT });
    expect(rt.app.auth).toMatchObject({ mode: 'entra', tenantId: prodEnv.ENTRA_TENANT_ID, clientId: prodEnv.ENTRA_CLIENT_ID, platformTenantId: prodEnv.PLATFORM_TENANT_ID });
    expect(rt.app.setupDeps.repo).toBeInstanceOf(PgConfigRepo);
    expect(rt.app.setupDeps.allowlist).toBeInstanceOf(PgAllowlist);
    expect(vaults).toEqual(['https://kv.invalid/']);
    expect(await rt.app.readiness[0]!.check()).toBe(true);
  });

  it('production app: dev header is rejected, readiness is 503 when postgres is down', async () => {
    const rt = await createRuntime(prodEnv, { pool: () => fakePool(false), keyVault: async () => new InMemorySecretStore() });
    process.env.NODE_ENV = 'production';
    const app = await buildApp(rt.app);
    expect((await app.inject({ url: '/api/v1/setup/llm', headers: { 'x-dev-user': 'u|owner|' } })).statusCode).toBe(401);
    expect((await app.inject('/readyz')).statusCode).toBe(503);
    await app.close();
  });

  it('buildApp refuses to start in production without explicit auth or persistent Setup deps', async () => {
    process.env.NODE_ENV = 'production';
    await expect(buildApp()).rejects.toThrow(/explicit Entra auth/);
    await expect(buildApp({ auth: { mode: 'entra', tenantId: 't', clientId: 'c', platformTenantId: 'p' } })).rejects.toThrow(/persistent Setup/);
  });

  it('dev mode keeps in-memory stores for local development only', async () => {
    const rt = await createRuntime({ AUTH_MODE: 'dev' });
    expect(rt.config.mode).toBe('dev');
    expect(rt.pool).toBeNull();
  });
});

const url = process.env.DATABASE_URL;
(url ? describe : describe.skip)('PgConfigRepo against PostgreSQL', () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());
  const tenant = '00000000-0000-0000-0000-0000000000aa';

  it('round-trips config without the key, and appends history to the audit log exactly once', async () => {
    await migrate(pool, undefined, () => undefined);
    await pool.query('DELETE FROM llm_config WHERE tenant_id = $1', [tenant]);
    const repo = new PgConfigRepo(pool);
    const empty = await repo.get(tenant);
    expect(empty.status).toBe('unconfigured');
    const before = (await pool.query("SELECT count(*)::int n FROM audit_log WHERE tenant_id = $1 AND object_type = 'llm_config'", [tenant])).rows[0].n;

    const rec = { ...empty, provider: 'anthropic' as const, secret: { name: 'llm-provider-key', version: 'v9' }, keyLast4: 'wxyz', primaryModel: 'm-1', status: 'configured' as const, history: [...empty.history, { at: new Date().toISOString(), event: 'key_activated', detail: { apiKey: 'should-be-redacted', model: 'm-1' } }] };
    await repo.save(rec);
    await repo.save(rec); // idempotent: history already persisted
    const got = await repo.get(tenant);
    expect(got).toMatchObject({ provider: 'anthropic', secret: { name: 'llm-provider-key', version: 'v9' }, keyLast4: 'wxyz', primaryModel: 'm-1', status: 'configured' });
    expect(got.history.length).toBe(before + 1);
    expect(got.history.at(-1)!.detail).toEqual({ apiKey: '[redacted]', model: 'm-1' });
    const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'llm_config'")).rows.map((r) => r.column_name);
    expect(cols.some((c) => /api_?key$|secret_value|password/.test(c))).toBe(false);
  });

  it('allowlist returns only verified models', async () => {
    await pool.query("INSERT INTO model_capabilities(provider, model_id, capabilities, status) VALUES ('openai','vx','{\"chat\":true,\"tools\":true,\"structured\":true,\"stream\":true}','verified'),('openai','ux','{}','unverified') ON CONFLICT (provider, model_id) DO UPDATE SET status = EXCLUDED.status");
    const m = await new PgAllowlist(pool).verified('openai');
    expect(m.has('vx')).toBe(true);
    expect(m.has('ux')).toBe(false);
  });
});
