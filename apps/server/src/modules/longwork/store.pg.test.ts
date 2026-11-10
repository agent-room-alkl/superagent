import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { PgLongWorkStore } from './store.js';
import { LongWork, type MailSource, type ActionDriver } from './service.js';

const live = process.env.DATABASE_URL ? it : it.skip;
live('real PostgreSQL serializes duplicate mail, persists restart recovery and rolls back failed mutations', async () => {
  const schema = `t45_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 6 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const migration = fs.readFileSync(new URL('../../../migrations/0005_longwork.sql', import.meta.url), 'utf8');
    // The CI/app role may not exist on a pristine local test cluster; DDL is otherwise the actual migration.
    await pool.query(migration.replace(/^GRANT .*$/m, ''));
    const source: MailSource = { id: 's', tenant: 't', mailbox: 'mail@example.invalid', folder: 'inbox', sopId: 'sop', projectId: 'p', objectId: 'o', assignee: 'staff', reviewer: 'reviewer', reminderMs: 60000,
      fields: { end: '2026-09-26' }, dueRule: { id: 'r', version: 1, field: 'end', offsetDays: 1, businessDays: false, timeZone: 'Pacific/Auckland', hour: 9, minute: 0, holidays: [], weekend: [0, 6] } };
    const mail = { id: 'm', threadId: 'th', from: 'person@example.invalid', receivedAt: '2026-09-26T00:00:00Z', body: 'Data only' };
    const store = new PgLongWorkStore(pool); const work = new LongWork(store);
    await Promise.all(Array.from({ length: 12 }, () => new LongWork(new PgLongWorkStore(pool)).ingest(source, mail)));
    expect((await work.snapshot('t')).items).toHaveLength(1);
    expect((await work.snapshot('t')).receipts).toHaveLength(1);
    const waits = await Promise.all(Array.from({ length: 8 }, () => work.openWaiting(source, { requestId: 'wait-two', threadId: 'second-thread', person: mail.from, evidence: 'Synthetic prior request' })));
    expect(new Set(waits.map(w => w.id)).size).toBe(1);
    const changedThread = await work.ingest(source, { ...mail, id: 'changed-thread-mail', threadId: 'third-thread' });
    expect(changedThread.exception!.candidates).toHaveLength(2);
    const newCases = await Promise.all(Array.from({ length: 6 }, () => work.resolveAsNew(source, changedThread.exception!.id)));
    expect(new Set(newCases.map(i => i.id)).size).toBe(1);
    await expect(store.change('t', s => { s.items.length = 0; throw Error('rollback'); })).rejects.toThrow('rollback');
    expect((await work.snapshot('t')).items).toHaveLength(3);
    const [a] = await work.createBatch('t', 'b', 'p', [{ id: 'one', payload: { amount: 10 } }, { id: 'two', payload: { amount: 20 } }]);
    await work.approve('t', 'b', 'p', [{ id: 'one', hash: a!.hash }], 'reviewer');
    let writes = 0; let reads = 0;
    const driver: ActionDriver = { authorize: async () => true, execute: async () => { writes++; throw Error('lost response'); },
      readback: async () => { reads++; return { status: 'succeeded', evidence: 'External record matched' }; } };
    await work.run('t', a!.id, 'p', driver);
    const restarted = new LongWork(new PgLongWorkStore(pool));
    await restarted.run('t', a!.id, 'p', driver); await restarted.run('t', a!.id, 'p', driver);
    expect({ writes, reads }).toEqual({ writes: 1, reads: 1 });
    const state = await restarted.snapshot('t'); expect(state.actions.filter(a => a.batchId === 'b').map(a => a.status)).toEqual(['succeeded', 'pending']);
    expect((await restarted.snapshot('other-tenant')).items).toHaveLength(0);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
}, 20000);
