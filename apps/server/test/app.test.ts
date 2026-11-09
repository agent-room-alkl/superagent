import { describe, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';

describe('app scaffold', () => {
  it('serves health and module mount points', async () => {
    const app = await buildApp();
    expect((await app.inject('/healthz')).json()).toEqual({ ok: true });
    expect((await app.inject('/api/v1/setup/llm')).json().status).toBe('unconfigured');
    expect((await app.inject('/api/v1/knowledge/status')).statusCode).toBe(200);
    expect((await app.inject('/api/v1/room/status')).statusCode).toBe(200);
    await app.close();
  });

  it('never echoes request bodies in logs (logging disabled for requests)', async () => {
    const app = await buildApp();
    expect(app.initialConfig.disableRequestLogging).toBe(true);
    await app.close();
  });
});
