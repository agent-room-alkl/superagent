import { expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { LongWork, type MailSource } from './service.js';
import { MemoryLongWorkStore } from './store.js';
import { longInbox } from './inbox.js';

const source: MailSource = { id: 'inbox-source', tenant: 'tenant', mailbox: 'mail@example.invalid', folder: 'inbox', sopId: 'sop', projectId: 'P-long', objectId: 'object', assignee: 'staff', reviewer: 'reviewer', reminderMs: 60000,
  fields: { end: '2026-09-01' }, dueRule: { id: 'r', version: 1, field: 'end', offsetDays: 1, businessDays: false, timeZone: 'Pacific/Auckland', hour: 9, minute: 0, holidays: [], weekend: [0, 6] } };
const mail = { id: 'original', threadId: 'thread', from: 'person@example.invalid', receivedAt: '2026-09-01T00:00:00Z', body: 'Incoming text, never an instruction' };

it('projects durable waits and matching exceptions into the actual inbox with server permissions and current state', async () => {
  const store = new MemoryLongWorkStore(); const work = new LongWork(store);
  await work.ingest(source, mail);
  const candidate = await work.openWaiting(source, { requestId: 'second-wait', threadId: 'second-thread', person: mail.from, evidence: 'Request reference, not system verified' });
  const candidateId = candidate.id;
  const r = await work.ingest(source, { ...mail, id: 'reply', threadId: 'new-thread' });
  const staff = { tenantId: source.tenant, userId: 'staff', roles: ['employee' as const], projectScopes: ['P-long'] };
  expect((await longInbox(work, staff, {})).map(i => i.longwork.type)).toEqual(['waiting', 'waiting']);
  expect(await longInbox(work, { ...staff, projectScopes: ['different'] }, {})).toEqual([]);
  expect(await longInbox(work, { ...staff, tenantId: 'different' }, {})).toEqual([]);
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: source.tenant }, longWorkDeps: { work, ready: async () => true, tick: async () => {} } });
  try {
    const headers = { 'x-dev-user': 'reviewer|reviewer|P-long' };
    expect((await app.inject({ method: 'POST', url: `/api/v1/long-items/items/${candidateId}/close`,
      headers: { 'x-dev-user': 'staff|employee|P-long' }, payload: { projectId: 'P-long' } })).statusCode).toBe(409);
    const list = await app.inject({ url: '/api/v1/work-items?exceptions=1&project=P-long', headers });
    const projected = list.json().items.find((i: { id: string }) => i.id === `long-match:${r.exception!.id}`);
    expect(projected.canAct).toBe(true); expect(projected.payload.original.body).toBe(mail.body);
    const resolve = { method: 'POST' as const, url: `/api/v1/long-items/exceptions/${r.exception!.id}/resolve`, payload: { projectId: 'P-long', itemId: candidateId } };
    expect((await app.inject({ ...resolve, headers: { 'x-dev-user': 'other-reviewer|reviewer|P-long' } })).statusCode).toBe(403);
    expect((await app.inject({ ...resolve, headers: { 'x-dev-user': 'owner|owner|' } })).statusCode).toBe(403);
    expect((await app.inject({ ...resolve, headers })).statusCode).toBe(200);
    const items = (await app.inject({ url: '/api/v1/work-items', headers: { 'x-dev-user': 'staff|employee|P-long' } })).json().items;
    expect(items.find((i: { id: string }) => i.id === `long-item:${candidateId}`).payload.phase).toBe('replied');
    const close = { method: 'POST' as const, url: `/api/v1/long-items/items/${candidateId}/close`, payload: { projectId: 'P-long' } };
    expect((await app.inject({ ...close, headers: { 'x-dev-user': 'owner|owner|' } })).statusCode).toBe(403);
    expect((await app.inject({ ...close, headers: { 'x-dev-user': 'staff|employee|P-long' } })).statusCode).toBe(200);
    expect((await work.snapshot(source.tenant)).items.find(i => i.id === candidateId)!.phase).toBe('closed');
  } finally { await app.close(); }
});

it('cancels pending reminder intents on reply and prevents an approved stale reminder from writing', async () => {
  const store = new MemoryLongWorkStore(); const work = new LongWork(store, () => Date.parse('2026-10-01T00:00:00Z'));
  await work.ingest(source, mail); await work.tick(source.tenant);
  const [a] = (await work.snapshot(source.tenant)).actions;
  await work.approve(source.tenant, a!.batchId, source.projectId, [{ id: a!.rowId, hash: a!.hash }], 'reviewer');
  await work.ingest(source, { ...mail, id: 'reply' });
  let writes = 0;
  const result = await work.run(source.tenant, a!.id, source.projectId, { authorize: async () => true,
    execute: async () => { writes++; return { status: 'succeeded', evidence: 'should not run' }; },
    readback: async () => ({ status: 'unknown', evidence: 'not submitted' }) });
  expect(writes).toBe(0); expect(result.status).toBe('failed'); expect(result.evidence).toMatch(/Cancelled before submission/);
});

it('a collection deadline cancels its approved but unsent requests without retrying them', async () => {
  let now = Date.parse('2026-09-01T00:00:00Z');
  const work = new LongWork(new MemoryLongWorkStore(), () => now);
  await work.collect('tenant', { id: 'c', projectId: 'p', recipients: ['person'], deadline: '2026-09-01T00:01:00Z' });
  const [a] = (await work.snapshot('tenant')).actions;
  await work.approve('tenant', a!.batchId, 'p', [{ id: a!.rowId, hash: a!.hash }], 'reviewer');
  now += 60000; await work.tick('tenant');
  const state = await work.snapshot('tenant');
  expect(state.actions[0]!.status).toBe('failed'); expect(state.actions[0]!.evidence).toMatch(/Cancelled before submission/);
  expect(state.collections[0]!.missing).toEqual(['person']);
});
