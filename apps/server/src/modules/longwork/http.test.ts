import { expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { LongWork } from './service.js';
import { MemoryLongWorkStore } from './store.js';
import type { LongWorkDeps } from './http.js';
import { MailTrigger, type GraphSource } from './graph.js';

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
    expect((await app.inject({ ...approval, headers: staff })).statusCode).toBe(404); // unassigned legacy batch is hidden from staff
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

it('registers real waiting items through approved sources, deduplicates request keys and produces changed-thread ambiguity', async () => {
  const work = new LongWork(new MemoryLongWorkStore());
  const source: GraphSource = { id: 'approved', tenant: 't', mailbox: 'mail@example.invalid', folder: 'inbox', sopId: 'sop', projectId: 'p', objectId: 'object', assignee: 'staff', reviewer: 'reviewer', reminderMs: 60000,
    fields: { end: '2026-09-01' }, startAt: '2026-09-01T00:00:00Z', clientStateRef: { name: 'fixture', version: 'v1' },
    dueRule: { id: 'r', version: 1, field: 'end', offsetDays: 1, businessDays: false, timeZone: 'Pacific/Auckland', hour: 9, minute: 0, holidays: [], weekend: [0, 6] } };
  const mail = new MailTrigger(work, [source], 'https://receiver.invalid/integrations/mail', { token: async () => { throw Error('No networking'); }, secret: async () => { throw Error('No secrets'); } });
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 't' }, longWorkDeps: { work, mail, ready: async () => true, tick: async () => {} } });
  try {
    const input = { method: 'POST' as const, url: '/api/v1/long-items/items/waits', headers: { 'x-dev-user': 'owner|owner|' },
      payload: { sourceId: 'approved', requestId: 'wait-one', person: 'person@example.invalid', threadId: 'thread-one', evidence: 'Human supplied reference, not system verified' } };
    expect((await app.inject({ ...input, headers: { 'x-dev-user': 'staff|employee|p' } })).statusCode).toBe(403);
    expect((await app.inject({ ...input, payload: { ...input.payload, sourceId: 'not-approved' } })).statusCode).toBe(404);
    const first = await app.inject(input); expect(first.statusCode).toBe(200);
    expect((await app.inject(input)).json().id).toBe(first.json().id);
    expect((await app.inject({ ...input, payload: { ...input.payload, threadId: 'changed' } })).statusCode).toBe(409);
    const second = await app.inject({ ...input, payload: { ...input.payload, requestId: 'wait-two', threadId: 'thread-two' } }); expect(second.statusCode).toBe(200);
    const result = await work.ingest(source, { id: 'new-mail', threadId: 'new-thread', from: input.payload.person, receivedAt: '2026-09-02T00:00:00Z', body: 'Incoming data' });
    expect(result.exception!.candidates.sort()).toEqual([first.json().id, second.json().id].sort());
    expect((await work.snapshot('t')).items).toHaveLength(2);
    const newCase = { method: 'POST' as const, url: `/api/v1/long-items/exceptions/${result.exception!.id}/new-item`, payload: { projectId: 'p' } };
    expect((await app.inject({ ...newCase, headers: { 'x-dev-user': 'owner|owner|' } })).statusCode).toBe(403);
    expect((await app.inject({ ...newCase, headers: { 'x-dev-user': 'reviewer|reviewer|different' } })).statusCode).toBe(404);
    const created = await app.inject({ ...newCase, headers: { 'x-dev-user': 'reviewer|reviewer|p' } }); expect(created.statusCode).toBe(200);
    expect((await app.inject({ ...newCase, headers: { 'x-dev-user': 'reviewer|reviewer|p' } })).json().id).toBe(created.json().id);
    expect((await work.snapshot('t')).items).toHaveLength(3);
  } finally { await app.close(); }
});
