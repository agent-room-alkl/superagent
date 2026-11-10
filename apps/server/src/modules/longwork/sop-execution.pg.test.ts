import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { SopRuntime } from '../sop/sop.js';
import { saveSopSnapshot, type Queryable } from '../sop/pg-sop.js';
import { sopState } from '../sop/index.js';
import { executionState, bindExecutionStore } from '../execution/index.js';
import { loadRunByInstance } from '../execution/pg-runs.js';
import { inboxState, bindInboxStore } from '../humanwork/index.js';
import { WorkInbox } from '../humanwork/work-items.js';
import { LongWork, type MailSource } from './service.js';
import { PgLongWorkStore } from './store.js';
import { prepareMailSopStarts } from './sop-starts.js';
import { MailSopBridge, type MailSopConsumer } from './sop-execution.js';
import { pgMailSopConsumer } from './execution-adapter.js';

const live = process.env.DATABASE_URL ? it : it.skip;
live('concurrent real PG consumers reuse the claimed instance and expose the same pinned run after reconstruction', async () => {
  const schema = `mail_run_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  const oldSop = sopState.current; const oldInbox = inboxState.current; const oldRuns = executionState.current.snapshot();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const file of ['0005_longwork.sql', '0007_sop_runtime.sql', '0009_longwork_sop_starts.sql', '0010_inbox_and_runs.sql', '0011_execution_run.sql', '0012_work_item.sql'])
      await pool.query(fs.readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8').replace(/^GRANT .*$/gm, ''));
    const db: Queryable = { query: async <T>(sql: string, params: readonly unknown[]) => ({ rows: (await pool.query(sql, params as unknown[])).rows as T[] }) };
    const source: MailSource = { id: 'source', tenant: 'tenant', mailbox: 'mail@example.invalid', folder: 'inbox', sopId: 's', projectId: 'p', objectId: 'object', assignee: 'staff', reviewer: 'reviewer', reminderMs: 60000,
      fields: { end: '2026-12-01', title: 'Synthetic request', amount: 10 }, dueRule: { id: 'd', version: 1, field: 'end', offsetDays: 0, businessDays: false, timeZone: 'Pacific/Auckland', hour: 9, minute: 0, holidays: [], weekend: [0, 6] } };
    const sop = new SopRuntime(); const version = sop.draft('s', { requiredFields: ['title', 'amount'], threshold: { field: 'amount', max: 1000 }, employeeStatus: 'active', graph: {
      nodes: [{ id: 't', kind: 'trigger', label: 'mail' }, { id: 'h', kind: 'human_review', label: 'review' }], edges: [{ from: 't', to: 'h' }] } });
    const context = { employees: {}, tools: {} };
    expect(sop.validate(version.id, context)).toMatchObject({ status: 'passed', issues: [] }); sop.publish(version.id, undefined, context); await saveSopSnapshot(db, sop.snapshot());
    sopState.current = new SopRuntime(); inboxState.current = new WorkInbox(); executionState.current.load({ seq: 0, runs: [] }); bindExecutionStore(db); bindInboxStore(db);
    const makeStore = () => new PgLongWorkStore(pool, prepareMailSopStarts([source])); const work = new LongWork(makeStore());
    const mail = { id: 'mail', threadId: 'thread', from: 'person@example.invalid', receivedAt: '2026-11-10T00:00:00Z', body: 'Synthetic data only' };
    const accepted = await work.ingest(source, mail); let starts = 0;
    const adapter = pgMailSopConsumer(pool);
    const consumer: MailSopConsumer = { ...adapter,
      start: async input => { starts++; await adapter.start(input); throw Error('Synthetic lost response after durable execution commit'); } };
    await Promise.all(Array.from({ length: 12 }, () => new MailSopBridge(makeStore(), [source], consumer).tick('tenant')));
    // The first wave may all observe the active lease. A reconstructed tick resolves the intentionally lost reply.
    await new MailSopBridge(makeStore(), [source], consumer).tick('tenant');
    const item = (await work.snapshot('tenant')).items[0]!;
    expect(starts).toBe(1); expect(item.sopExecution).toMatchObject({ status: 'waiting_human', runId: `run_${item.sopStart!.instanceId}` });
    expect((await pool.query('SELECT * FROM execution_run')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM sop_events')).rows).toHaveLength(1); expect((await pool.query('SELECT * FROM sop_instances')).rows).toHaveLength(1);
    executionState.current.load({ seq: 0, runs: [] }); sopState.current = new SopRuntime(); inboxState.current = new WorkInbox();
    await new MailSopBridge(makeStore(), [source], consumer).tick('tenant'); expect(starts).toBe(1);
    const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 'tenant' }, longWorkDeps: { work: new LongWork(makeStore()), ready: async () => true, tick: async () => {} } });
    try {
      const list = (await app.inject({ url: '/api/v1/work-items', headers: { 'x-dev-user': 'staff|employee|p' } })).json().items;
      expect(list.find((i: { id: string }) => i.id === `long-item:${accepted.item!.id}`).payload.sopExecution).toMatchObject({ status: 'waiting_human', runId: item.sopExecution!.runId });
      expect(JSON.stringify(list)).not.toContain('leaseOwner');
      const reviewer = { 'x-dev-user': 'reviewer|employee|p' };
      const assigned = (await app.inject({ url: '/api/v1/work-items', headers: reviewer })).json().items;
      const approval = assigned.find((i: { kind: string }) => i.kind === 'action_approval'); expect(approval).toBeDefined();
      expect(executionState.current.list('tenant')).toHaveLength(0); // web had already started before the worker created this run
      const decided = await app.inject({ method: 'POST', url: `/api/v1/work-items/${approval.id}/decide`, headers: reviewer, payload: { expectedVersion: approval.payloadVersion } });
      expect(decided.statusCode).toBe(200); expect(decided.json().ok).toBe(true);
      expect((await loadRunByInstance(db, 'tenant', item.sopStart!.instanceId!))?.status).toBe('completed');
      await new MailSopBridge(makeStore(), [source], consumer).tick('tenant');
      expect((await work.snapshot('tenant')).items[0]!.sopExecution?.status).toBe('completed'); expect(starts).toBe(1);
      expect((await pool.query('SELECT status FROM sop_instances')).rows[0].status).toBe('completed');
      await work.close('tenant', item.id, 'p', 'staff');
      expect((await pool.query('SELECT status FROM sop_instances')).rows[0].status).toBe('completed');
      expect((await work.snapshot('tenant')).items[0]!.sopStart?.reason).not.toContain('未执行外部动作');
    } finally { await app.close(); }
  } finally {
    bindExecutionStore(null); bindInboxStore(null); sopState.current = oldSop; inboxState.current = oldInbox; executionState.current.load(oldRuns);
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  }
}, 20000);
