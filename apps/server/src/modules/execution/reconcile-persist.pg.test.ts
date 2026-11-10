import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import type { SopGraph, ToolContract } from '@superagent/shared';
import { OutcomeUnknownError, ToolGateway } from '../gateway/gateway.js';
import { saveGatewaySnapshot } from '../gateway/pg-gateway.js';
import { employeesState } from '../employees/index.js';
import { inboxState, bindInboxStore } from '../humanwork/index.js';
import { insertWorkItem, loadInbox, loadWorkItemsForRun, saveInbox, updateWorkItem } from '../humanwork/pg-inbox.js';
import { WorkInbox } from '../humanwork/work-items.js';
import { sopState } from '../sop/index.js';
import { SopRuntime } from '../sop/sop.js';
import { toolsState } from '../tools/index.js';
import { SopExecutor, type Connector } from './executor.js';
import { bindExecutionStore, connectors, executionState, readbacks, reconcile } from './index.js';
import { bindGatewayStore, gatewayState } from '../gateway/index.js';
import { insertRun, loadRunById, updateRun } from './pg-runs.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;

function bound(pool: pg.Pool, schema: string) {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}"`);
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as T[] };
      } finally {
        client.release();
      }
    },
  };
}

function bindTool(toolId: string, employeeId: string): void {
  const contract: ToolContract = {
    toolId, action: 'erp.pay', purpose: 'Record a payment', targetSystem: 'app.example.com', effect: 'write',
    input: { type: 'object', properties: { invoiceNo: { type: 'string' }, amount: { type: 'number' } } },
    output: { type: 'object', properties: {} }, risk: 'high', requiresExactApproval: true,
  };
  const svc = toolsState.current;
  svc.createPlaceholder({ name: 'Pay', contract, acceptanceCases: ['normal'], consumers: [employeeId], maintainer: 'm1' });
  svc.confirmContract(toolId);
  const artifact = JSON.stringify({ toolId, effect: 'write', params: ['invoiceNo'] });
  svc.acquire(toolId, { route: 'import', developer: 'd1', artifact });
  svc.recordTest(toolId, { normal: true });
  const released = svc.release(toolId, 'reviewer-1');
  svc.recordDeploy(toolId, released.version, true, artifact);
  svc.install(toolId, employeeId);
  svc.bind(toolId, employeeId, 'kv://cred', { projects: ['P-1'] }, () => true);
}

live('a read-back confirms the original approval row after the process cache is gone', async () => {
  const schema = `t70read_${randomUUID().replace(/-/g, '')}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const admin = await pool.connect();
  const toolId = `erp.pay.${schema.slice(-8)}`;
  const writes: string[] = [];
  const input = { invoiceNo: 'INV-480', amount: 480 };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of ['0008_gateway_actions.sql', '0010_inbox_and_runs.sql', '0011_execution_run.sql', '0012_work_item.sql']) {
      const sql = fs.readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8');
      await admin.query(sql.replace(/^GRANT .*$/gm, ''));
    }
    const db = bound(pool, schema);
    const employee = employeesState.current.create({ name: '应付专员', duty: '登记付款', prompt: '按批准的金额登记', owner: 'owner-1' });
    employeesState.current.connect(employee.id);
    bindTool(toolId, employee.id);
    const graph: SopGraph = {
      nodes: [
        { id: 't', kind: 'trigger', label: '收到发票', ref: 'mail:inbox' },
        { id: 'a', kind: 'agent', label: '分派' },
        { id: 'e', kind: 'employee', label: '应付专员', ref: employee.id },
        { id: 'h', kind: 'human_review', label: '财务审核' },
        { id: 'w', kind: 'tool', label: '登记付款', ref: toolId },
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'e' }, { from: 'e', to: 'h' }, { from: 'h', to: 'w' }],
    };
    const sop = new SopRuntime();
    const drafted = sop.draft('invoice-intake', { requiredFields: ['invoiceNo', 'amount'], threshold: { field: 'amount', max: 5000 }, employeeStatus: 'active', graph } as never);
    const graphContext = { employees: { [employee.id]: { status: 'active' as const } }, tools: { [toolId]: { stage: 'available' as const, effect: 'write' as const } } };
    expect(sop.validate(drafted.id, graphContext).status).toBe('passed');
    const version = sop.publish(drafted.id, undefined, graphContext);
    sopState.current.pin(version);
    const inbox = new WorkInbox();
    const gateway = new ToolGateway();
    const localConnectors = new Map<string, Connector>([
      [toolId, () => { writes.push('pay'); throw new OutcomeUnknownError('timeout'); }],
    ]);
    const ex = new SopExecutor({
      sop: () => sop,
      inbox: () => inbox,
      gateway,
      tools: () => ({ effect: 'write', available: true }),
      connectors: localConnectors,
      reviewerOf: () => 'owner-1',
      authorize: () => null,
    });
    const instanceId = `mail_${schema.slice(-6)}`;
    await ex.runClaimed(
      { tenantId: 't', versionId: version.id, instanceId, eventId: 'mail-unknown', startedBy: 'owner-1', data: input },
      async (draft) => { expect(await insertRun(db, draft)).toBe(true); },
    );
    const approval = inbox.all().find((item) => item.kind === 'action_approval')!;
    const openCopy = structuredClone(approval);
    const hash = approval.payloadHash;
    const decided = inbox.decide(approval.id, 'owner-1', approval.payloadVersion);
    expect(decided.ok).toBe(true);
    const unknown = (await ex.onDecided(decided.item))!;
    expect(unknown.status).toBe('outcome_unknown');
    expect(writes).toEqual(['pay']);
    const stored = inbox.all().find((item) => item.id === approval.id)!;
    expect(stored.submitCount).toBe(1);
    await updateRun(db, unknown);
    await insertWorkItem(db, openCopy);
    await updateWorkItem(db, stored);
    await saveInbox(db, { seq: 1, items: [openCopy] });
    await saveGatewaySnapshot(db, gateway.snapshot());
    const callsBefore = gateway.snapshot().actions.reduce((n, action) => n + action.calls, 0);
    expect(callsBefore).toBe(1);

    executionState.current.load({ runs: [], seq: 0 });
    inboxState.current.load({ items: [], seq: 0 });
    gatewayState.current.load({ actions: [] });
    bindExecutionStore(db);
    bindInboxStore(db);
    bindGatewayStore(db);
    connectors.set(toolId, () => { writes.push('again'); throw new Error('write connector must not run'); });
    readbacks.set(toolId, (params) => ({ ...params }));

    const matched = await reconcile('t', unknown.id, 'owner-1');
    expect(matched.status).toBe('completed');
    expect(writes).toEqual(['pay']);
    expect(gatewayState.current.snapshot().actions.reduce((n, action) => n + action.calls, 0)).toBe(1);

    await saveInbox(db, { seq: 1, items: [openCopy] });
    await insertWorkItem(db, openCopy);
    const restored = new WorkInbox();
    restored.load((await loadInbox(db))!);
    for (const row of await loadWorkItemsForRun(db, unknown.id)) restored.remember(row);
    const again = restored.all().find((item) => item.id === approval.id)!;
    expect(again).toMatchObject({ actionStatus: 'confirmed', systemVerified: true, evidenceSource: 'system', payloadHash: hash, submitCount: 1 });
    expect(again.payload).toMatchObject({ invoiceNo: 'INV-480', amount: 480 });

    executionState.current.load({ runs: [], seq: 0 });
    inboxState.current.load({ items: [], seq: 0 });
    gatewayState.current.load({ actions: [] });
    const second = await reconcile('t', unknown.id, 'owner-1');
    expect(second.status).toBe('completed');
    expect(writes).toEqual(['pay']);
    expect((await loadRunById(db, unknown.id))?.status).toBe('completed');
    expect(gatewayState.current.snapshot().actions.reduce((n, action) => n + action.calls, 0)).toBe(1);
  } finally {
    readbacks.delete(toolId);
    connectors.delete(toolId);
    bindExecutionStore(null);
    bindInboxStore(null);
    bindGatewayStore(null);
    executionState.current.load({ runs: [], seq: 0 });
    inboxState.current.load({ items: [], seq: 0 });
    gatewayState.current.load({ actions: [] });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    admin.release();
    await pool.end();
  }
});
