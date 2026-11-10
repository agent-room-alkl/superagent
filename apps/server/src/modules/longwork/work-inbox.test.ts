import { expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { LongWork, type ActionDriver } from './service.js';
import { MemoryLongWorkStore } from './store.js';
import type { LongWorkDeps } from './http.js';

const owner = { 'x-dev-user': 'owner|owner|' };
const assigned = { 'x-dev-user': 'staff|employee|p' };
const other = { 'x-dev-user': 'other|employee|p' };

it('serves an assigned durable batch, rejects conflict rows/other actors, and never resends success or unknown rows', async () => {
  const work = new LongWork(new MemoryLongWorkStore()); const writes: string[] = []; const reads: string[] = [];
  const driver: ActionDriver = { authorize: async () => true,
    execute: async a => { writes.push(a.rowId); if (a.rowId === 'two') throw Error('lost response'); return { status: 'succeeded', evidence: 'submitted' }; },
    readback: async a => { reads.push(a.rowId); return { status: 'succeeded', evidence: 'exact stored value matched' }; } };
  const deps: LongWorkDeps = { work, driver, ready: async () => true, tick: async () => {} };
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 't' }, longWorkDeps: deps });
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/long-items/batches', headers: owner, payload: { id: 'b', projectId: 'p', assigneeUserId: 'staff', rows: [
      { id: 'conflict', clean: false, payload: { amount: -1 } }, { id: 'one', payload: { amount: 10 } }, { id: 'two', payload: { amount: 20 } }, { id: 'three', payload: { amount: 30 } },
    ] } }); expect(created.statusCode).toBe(200); const actions = created.json() as Array<{ rowId: string; hash: string }>;
    const command = (path: string, data: object, headers = assigned) => app.inject({ method: 'POST', url: `/api/v1/long-items/batches/b/${path}`, headers, payload: { projectId: 'p', ...data } });
    expect((await app.inject({ url: '/api/v1/work-items', headers: other })).json().items).toHaveLength(0);
    const visible = (await app.inject({ url: '/api/v1/work-items', headers: assigned })).json().items[0];
    expect(visible.longwork.type).toBe('batch'); expect(visible.payload.actionRows[0].id).toBe('conflict'); expect(visible.canAct).toBe(true);
    expect((await app.inject({ url: '/api/v1/work-items', headers: owner })).json().items[0].canAct).toBe(false);
    expect((await command('selection', { selected: ['one'] }, owner)).statusCode).toBe(403);
    expect((await command('selection', { selected: ['one'] }, other)).statusCode).toBe(404);
    expect((await command('selection', { selected: ['conflict'] })).statusCode).toBe(409);
    expect((await command('selection', { selected: ['one', 'two'] })).statusCode).toBe(200);
    const selected = actions.filter(a => ['one', 'two'].includes(a.rowId)).map(a => ({ id: a.rowId, hash: a.hash }));
    expect((await command('approve', { selected })).statusCode).toBe(200);
    expect((await command('run-selected', {})).statusCode).toBe(200); expect(writes).toEqual(['one', 'two']); expect(reads).toEqual(['one']);
    await command('run-selected', {}); expect(writes).toEqual(['one', 'two']);
    await command('readback', {}); expect(writes).toEqual(['one', 'two']); expect(reads).toEqual(['one', 'two']);
    expect((await command('selection', { selected: ['one'] })).statusCode).toBe(409);
    await command('selection', { selected: ['three'] }); await command('approve', { selected: [{ id: 'three', hash: actions.find(a => a.rowId === 'three')!.hash }] }); await command('run-selected', {});
    expect(writes).toEqual(['one', 'two', 'three']);
    const exceptionList = (await app.inject({ url: '/api/v1/work-items?exceptions=1', headers: assigned })).json().items;
    expect(exceptionList).toHaveLength(1); expect(exceptionList[0].payload.hasExceptions).toBe(true);
  } finally { await app.close(); }
});

it('does not turn approved rows into fake success without a driver, and sanitizes adapter authorization errors', async () => {
  const work = new LongWork(new MemoryLongWorkStore()); const deps: LongWorkDeps = { work, ready: async () => true, tick: async () => {} };
  const [a] = await work.createBatch('t', 'b', 'p', [{ id: 'r', payload: { amount: 10 } }], 'staff');
  await work.approve('t', 'b', 'p', [{ id: 'r', hash: a!.hash }], 'staff');
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 't' }, longWorkDeps: deps });
  const call = () => app.inject({ method: 'POST', url: '/api/v1/long-items/batches/b/run-selected', headers: assigned, payload: { projectId: 'p' } });
  try {
    expect((await call()).statusCode).toBe(503); expect((await work.snapshot('t')).actions[0]!.status).toBe('approved');
    deps.driver = { authorize: async () => { throw Error('private backend detail'); }, execute: async () => { throw Error('must not call'); }, readback: async () => { throw Error('must not call'); } };
    const response = await call(); expect(response.body).not.toContain('private backend detail'); expect(response.json().results[0].error).toBe('connector_unavailable');
  } finally { await app.close(); }
});

it('separates recipient evidence, real request-delivery status and the collector deadline summary', async () => {
  let now = Date.now(); const work = new LongWork(new MemoryLongWorkStore(), () => now);
  await work.collect('t', { id: 'c', projectId: 'p', deadline: new Date(now + 60000).toISOString(), recipients: ['staff', 'other'], assigneeUserId: 'collector', approverUserId: 'sender' });
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 't' }, longWorkDeps: { work, ready: async () => true, tick: async () => {} } });
  try {
    const staffView = (await app.inject({ url: '/api/v1/work-items', headers: assigned })).json().items;
    expect(staffView).toHaveLength(1); expect(staffView[0].longwork.type).toBe('collection-response'); expect(staffView[0].payload).not.toHaveProperty('responses');
    const reply = await app.inject({ method: 'POST', url: '/api/v1/long-items/collections/c/reply', headers: assigned, payload: { projectId: 'p', person: 'other', evidence: 'staff private evidence' } }); expect(reply.statusCode).toBe(200);
    expect(reply.json().recipients).toEqual(['staff']);
    await app.inject({ method: 'POST', url: '/api/v1/long-items/collections/c/reply', headers: other, payload: { projectId: 'p', evidence: 'other private evidence' } });
    const update = await app.inject({ method: 'POST', url: '/api/v1/long-items/collections/c/reply', headers: assigned, payload: { projectId: 'p', evidence: 'staff private evidence' } });
    expect(update.body).not.toContain('other private evidence'); expect(update.json().replies).toEqual({ staff: 'staff private evidence' });
    const otherView = (await app.inject({ url: '/api/v1/work-items', headers: other })).body;
    expect(otherView).not.toContain('staff private evidence');
    const rawOther = (await app.inject({ url: '/api/v1/long-items', headers: other })).body; expect(rawOther).not.toContain('staff private evidence');
    const collector = { 'x-dev-user': 'collector|employee|p' };
    const before = (await app.inject({ url: '/api/v1/work-items', headers: collector })).json().items[0];
    expect(before.payload.verifiedSends).toBe(0); expect(before.payload.responses).toEqual({ staff: 'staff private evidence', other: 'other private evidence' });
    now += 60001; await work.tick('t');
    const after = (await app.inject({ url: '/api/v1/work-items', headers: collector })).json().items[0];
    expect(after.payload.collectionState).toBe('summarized'); expect(after.payload.missing).toEqual([]);
    expect((await app.inject({ method: 'POST', url: '/api/v1/long-items/collections/c/reply', headers: other, payload: { projectId: 'p', evidence: 'late' } })).statusCode).toBe(409);
    expect((await work.snapshot('t')).actions.every(a => a.status === 'failed')).toBe(true); // unsent requests are canceled at the deadline
  } finally { await app.close(); }
});
