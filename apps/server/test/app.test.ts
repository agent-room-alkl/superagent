import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import { InMemoryAuditSink, audit } from '../src/modules/audit/audit.js';
import { authConfigFromEnv, canAccessProject } from '../src/auth.js';

const owner = { 'x-dev-user': 'u1|owner|' };
const employee = { 'x-dev-user': 'u2|employee|P-1' };

describe('app scaffold', () => {
  it('serves health without auth and requires auth for /api', async () => {
    const app = await buildApp();
    expect((await app.inject('/healthz')).json()).toEqual({ ok: true });
    expect((await app.inject('/api/v1/setup/llm')).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/setup/llm', headers: owner })).json().status).toBe('unconfigured');
    expect((await app.inject({ url: '/api/v1/knowledge/status', headers: employee })).statusCode).toBe(200);
    await app.close();
  });

  it('restricts Setup to admin/owner on the server side', async () => {
    const app = await buildApp();
    expect((await app.inject({ url: '/api/v1/setup/llm', headers: employee })).statusCode).toBe(403);
    await app.close();
  });

  it('readiness reports failing dependencies with 503', async () => {
    const app = await buildApp({ readiness: [{ name: 'db', check: async () => false }, { name: 'vault', check: async () => true }] });
    const r = await app.inject('/readyz');
    expect(r.statusCode).toBe(503);
    expect(r.json().checks).toEqual([{ name: 'db', ok: false }, { name: 'vault', ok: true }]);
    await app.close();
  });

  it('never logs request bodies', async () => {
    const app = await buildApp();
    expect(app.initialConfig.disableRequestLogging).toBe(true);
    await app.close();
  });
});

describe('auth helpers', () => {
  it('refuses dev auth in production', () => {
    expect(() => authConfigFromEnv({ AUTH_MODE: 'dev', NODE_ENV: 'production' })).toThrow();
  });
  it('project scope check', () => {
    const u = { tenantId: 't', userId: 'u', roles: ['employee' as const], projectScopes: ['P-1'] };
    expect(canAccessProject(u, 'P-1')).toBe(true);
    expect(canAccessProject(u, 'P-2')).toBe(false);
  });
});

describe('audit', () => {
  it('redacts secrets in details before storage', async () => {
    const sink = new InMemoryAuditSink();
    await audit(sink, { tenantId: 't', actor: 'u1', action: 'setup.key.rotate', objectType: 'llm_config', objectId: 't', result: 'ok', detail: { apiKey: 'sk-ant-abcdef1234567890', note: 'used sk-proj-ABCDEFGH12345678' } });
    const s = JSON.stringify(sink.entries[0]);
    expect(s).not.toContain('abcdef1234567890');
    expect(s).not.toContain('ABCDEFGH12345678');
  });
});
