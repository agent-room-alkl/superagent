import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { SopRuntime } from '../sop/sop.js';
import { sopState } from '../sop/index.js';
import { saveSopSnapshot } from '../sop/pg-sop.js';
import { SopExecutor } from '../execution/executor.js';
import { bindExecutionStore, executionState, runClaimedInstance } from '../execution/index.js';
import { bindGatewayStore, gatewayState } from '../gateway/index.js';
import { ToolGateway } from '../gateway/gateway.js';
import { bindInboxStore, inboxState } from '../humanwork/index.js';
import { WorkInbox } from '../humanwork/work-items.js';
import { loadWorkItemsForRun, updateWorkItem } from '../humanwork/pg-inbox.js';
import { LongWork, type MailSource } from './service.js';
import { PgLongWorkStore } from './store.js';
import { prepareMailSopStarts } from './sop-starts.js';

const live = process.env.DATABASE_URL ? it : it.skip;
live('a stale process cannot execute an approval after the original contract was withdrawn in PostgreSQL', async () => {
  const schema = `stale_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  const old = { sop: sopState.current, ex: executionState.current, inbox: inboxState.current, gateway: gatewayState.current };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const file of ['0005_longwork.sql', '0007_sop_runtime.sql', '0008_gateway_actions.sql', '0009_longwork_sop_starts.sql', '0010_inbox_and_runs.sql', '0011_execution_run.sql', '0012_work_item.sql'])
      await pool.query(fs.readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8').replace(/^GRANT .*$/gm, ''));
    let beforeDecisionSave: (() => Promise<void>) | undefined;
    const db = { query: async <T>(sql: string, params: readonly unknown[]) => {
      if (beforeDecisionSave && /^UPDATE work_item SET payload/.test(sql)) { const race = beforeDecisionSave; beforeDecisionSave = undefined; await race(); }
      return { rows: (await pool.query(sql, params as unknown[])).rows as T[] };
    } };
    bindExecutionStore(db); bindInboxStore(db); bindGatewayStore(db);
    const sop = new SopRuntime(); const version = sop.draft('s', { requiredFields: ['invoiceNo', 'amount'], threshold: { field: 'amount', max: 1000 }, employeeStatus: 'active', graph: {
      nodes: [{ id: 't', kind: 'trigger', label: 'mail' }, { id: 'e', kind: 'employee', label: 'employee', ref: 'employee' }, { id: 'h', kind: 'human_review', label: 'approval' }, { id: 'w', kind: 'tool', label: 'write', ref: 'fixture.write' }],
      edges: [{ from: 't', to: 'e' }, { from: 'e', to: 'h' }, { from: 'h', to: 'w' }] } });
    const context = { employees: { employee: { status: 'active' as const } }, tools: { 'fixture.write': { stage: 'available', effect: 'write' } } };
    expect(sop.validate(version.id, context).status).toBe('passed'); sop.publish(version.id, undefined, context); await saveSopSnapshot(db, sop.snapshot());
    sopState.current = sop; gatewayState.current = new ToolGateway(); inboxState.current = new WorkInbox(); let writes = 0;
    executionState.current = new SopExecutor({ sop: () => sopState.current, inbox: () => inboxState.current, gateway: gatewayState.current,
      tools: () => ({ effect: 'write', available: true }), connectors: new Map([['fixture.write', params => { writes++; return { actual: structuredClone(params) }; }]]),
      reviewerOf: run => run.startedBy, authorize: () => null });
    const source: MailSource = { id: 'source', tenant: 'tenant', mailbox: 'fixture@example.invalid', folder: 'inbox', sopId: 's', projectId: 'p', objectId: 'object', assignee: 'staff', reviewer: 'reviewer', reminderMs: 60000,
      fields: { end: '2026-12-01', invoiceNo: 'synthetic', amount: 10 }, dueRule: { id: 'd', version: 1, field: 'end', offsetDays: 0, businessDays: false, timeZone: 'Pacific/Auckland', hour: 9, minute: 0, holidays: [], weekend: [0, 6] } };
    const work = new LongWork(new PgLongWorkStore(pool, prepareMailSopStarts([source])));
    const open = async (event: string) => {
      const accepted = await work.ingest(source, { id: event, threadId: event, from: `${event}@example.invalid`, receivedAt: '2026-11-10T00:00:00Z', body: 'Synthetic data' });
      const run = await runClaimedInstance({ tenantId: 'tenant', versionId: version.id, instanceId: accepted.item!.sopStart!.instanceId!, eventId: event, startedBy: 'reviewer', data: { invoiceNo: event, amount: 10 } });
      return { run, approval: inboxState.current.all().find(i => i.kind === 'action_approval' && i.payload.executionId === run.id)! };
    };
    const { run, approval } = await open('before-refresh');
    expect(await updateWorkItem(db, { ...approval, payloadVersion: approval.payloadVersion + 1, status: 'withdrawn', decision: null })).toBe(true);
    // This process still has the v1 open item. No list/hydration request refreshes it before the decision.
    const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 'tenant' } });
    try {
      const decision = await app.inject({ method: 'POST', url: `/api/v1/work-items/${approval.id}/decide`, headers: { 'x-dev-user': 'reviewer|employee|p' }, payload: { expectedVersion: approval.payloadVersion } });
      const stored = (await loadWorkItemsForRun(db, run.id)).find(i => i.id === approval.id)!;
      expect(stored).toMatchObject({ payloadVersion: approval.payloadVersion + 1, status: 'withdrawn', decision: null });
      expect(writes).toBe(0); expect(decision.statusCode).toBe(409);
      expect(executionState.current.get('tenant', run.id).status).toBe('waiting_human');
      const race = await open('after-refresh');
      const revised = { ...race.approval, payloadVersion: race.approval.payloadVersion + 1, status: 'withdrawn', decision: null };
      beforeDecisionSave = async () => { await pool.query('UPDATE work_item SET payload=$2::jsonb WHERE id=$1', [revised.id, JSON.stringify(revised)]); };
      const rejected = await app.inject({ method: 'POST', url: `/api/v1/work-items/${race.approval.id}/decide`, headers: { 'x-dev-user': 'reviewer|employee|p' }, payload: { expectedVersion: race.approval.payloadVersion } });
      expect(rejected.statusCode).toBe(409); expect(writes).toBe(0);
      expect(executionState.current.get('tenant', race.run.id).status).toBe('waiting_human');
      expect(inboxState.current.get(revised.id)).toMatchObject({ payloadVersion: revised.payloadVersion, status: 'withdrawn', decision: null });
      const valid = () => app.inject({ method: 'POST', url: `/api/v1/work-items/${revised.id}/decide`, headers: { 'x-dev-user': 'reviewer|employee|p' }, payload: { expectedVersion: revised.payloadVersion } });
      expect((await valid()).json().ok).toBe(true); expect(writes).toBe(1);
      expect((await valid()).json().ok).toBe(false); expect(writes).toBe(1);
      const missing = await open('missing-row');
      await pool.query('DELETE FROM work_item WHERE id=$1', [missing.approval.id]);
      const absent = await app.inject({ method: 'POST', url: `/api/v1/work-items/${missing.approval.id}/decide`, headers: { 'x-dev-user': 'reviewer|employee|p' }, payload: { expectedVersion: missing.approval.payloadVersion } });
      expect(absent.statusCode).toBe(409); expect(writes).toBe(1);
      expect(executionState.current.get('tenant', missing.run.id).status).toBe('waiting_human');
      expect(inboxState.current.get(missing.approval.id)).toMatchObject({ status: 'open', decision: null, submitCount: 0 });
    } finally { await app.close(); }
  } finally {
    bindExecutionStore(null); bindInboxStore(null); bindGatewayStore(null);
    sopState.current = old.sop; executionState.current = old.ex; inboxState.current = old.inbox; gatewayState.current = old.gateway;
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end();
  }
}, 20000);
