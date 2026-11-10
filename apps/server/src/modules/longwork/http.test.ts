import { expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { LongWork } from './service.js';
import { MemoryLongWorkStore } from './store.js';
import type { LongWorkDeps } from './http.js';

it('enforces identity, tenant/project boundaries, reviewer-only approval and responder identity', async () => {
  const work = new LongWork(new MemoryLongWorkStore(), () => Date.parse('2026-09-01T00:00:00Z'));
  const deps: LongWorkDeps = { work, ready: async () => true, tick: async () => {} };
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 't' }, longWorkDeps: deps });
  const owner = { 'x-dev-user': 'owner|owner|' }; const staff = { 'x-dev-user': 'staff|employee|p' }; const reviewer = { 'x-dev-user': 'reviewer|reviewer|p' };
  try {
    expect((await app.inject('/api/v1/long-items')).statusCode).toBe(401);
    const created = await app.inject({ method: 'POST', url: '/api/v1/long-items/batches', headers: owner, payload: { id: 'batch', projectId: 'p', rows: [{ id: 'r', payload: { amount: 42 } }] } });
    expect(created.statusCode).toBe(200); const action = created.json()[0];
    expect((await app.inject({ url: '/api/v1/long-items', headers: staff })).json().actions).toEqual([]);
    expect((await app.inject({ url: '/api/v1/long-items', headers: { 'x-dev-user': 'other|reviewer|other-project' } })).json().actions).toEqual([]);
    expect((await work.snapshot('other-tenant')).actions).toEqual([]);
    const approval = { method: 'POST' as const, url: '/api/v1/long-items/batches/batch/approve', payload: { projectId: 'p', selected: [{ id: 'r', hash: action.hash }] } };
    expect((await app.inject({ ...approval, headers: staff })).statusCode).toBe(403);
    expect((await app.inject({ ...approval, headers: { 'x-dev-user': 'other|reviewer|other-project' } })).statusCode).toBe(404);
    expect((await app.inject({ ...approval, headers: reviewer })).statusCode).toBe(200);
    const run = await app.inject({ method: 'POST', url: `/api/v1/long-items/actions/${action.id}/run`, headers: reviewer, payload: { projectId: 'p' } });
    expect(run.statusCode).toBe(503); expect(run.json().error).toBe('connector_not_configured');
    expect((await work.snapshot('t')).actions[0]!.status).toBe('approved');
    await app.inject({ method: 'POST', url: '/api/v1/long-items/collections', headers: owner, payload: { id: 'c', projectId: 'p', recipients: ['staff'], deadline: '2026-10-01T00:00:00Z' } });
    expect((await app.inject({ method: 'POST', url: '/api/v1/long-items/collections/c/reply', headers: staff, payload: { projectId: 'p', evidence: 'response', person: 'someone-else' } })).statusCode).toBe(200);
    expect((await work.snapshot('t')).collections[0]!.replies).toEqual({ staff: 'response' });
  } finally { await app.close(); }
});
it('returns unavailable without dependencies rather than using an accidental production memory store', async () => {
  const app = await buildApp(); try {
    expect((await app.inject({ url: '/api/v1/long-items', headers: { 'x-dev-user': 'owner|owner|' } })).statusCode).toBe(503);
    expect((await app.inject({ method: 'POST', url: '/integrations/mail', payload: { value: [] } })).statusCode).toBe(503);
  } finally { await app.close(); }
});
