import { describe, it, expect, beforeEach } from 'vitest';
import type { SopGraph } from '@superagent/shared';
import { SopRuntime } from '../src/modules/sop/sop.js';
import { WorkInbox } from '../src/modules/humanwork/work-items.js';
import { OutcomeUnknownError, ToolGateway } from '../src/modules/gateway/gateway.js';
import { SopExecutor, stepOrder, type Connector, type ToolInfo } from '../src/modules/execution/executor.js';

const graph: SopGraph = {
  nodes: [
    { id: 't', kind: 'trigger', label: '收到发票', ref: 'mail:inbox' },
    { id: 'a', kind: 'agent', label: '超级智能体分派' },
    { id: 'e', kind: 'employee', label: '应付专员', ref: 'emp-1' },
    { id: 'r', kind: 'tool', label: '查询采购单', ref: 'erp.lookup' },
    { id: 'h', kind: 'human_review', label: '财务审核' },
    { id: 'w', kind: 'tool', label: '登记付款', ref: 'erp.pay' },
  ],
  edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'e' }, { from: 'e', to: 'r' }, { from: 'r', to: 'h' }, { from: 'h', to: 'w' }],
};
const ctx = { employees: { 'emp-1': { status: 'active' as const } }, tools: { 'erp.lookup': { stage: 'available' as const, effect: 'read' as const }, 'erp.pay': { stage: 'available' as const, effect: 'write' as const } } };
const input = { invoiceNo: 'INV-480', amount: 480 };

let sop: SopRuntime;
let inbox: WorkInbox;
let connectors: Map<string, Connector>;
let tools: Record<string, ToolInfo>;
let ledger: Map<string, Record<string, unknown>>;
let calls: string[];
let ex: SopExecutor;
let refuse: string | null;
let authCalls: [string, string | null][];
let versionId: string;

function publish(def: Record<string, unknown> = {}) {
  const v = sop.draft('invoice-intake', { requiredFields: ['invoiceNo', 'amount'], threshold: { field: 'amount', max: 5000 }, employeeStatus: 'active', graph, ...def } as never);
  expect(sop.validate(v.id, ctx).status).toBe('passed');
  return sop.publish(v.id, undefined, ctx).id;
}

beforeEach(() => {
  sop = new SopRuntime();
  inbox = new WorkInbox();
  ledger = new Map();
  calls = [];
  tools = { 'erp.lookup': { effect: 'read', available: true }, 'erp.pay': { effect: 'write', available: true } };
  connectors = new Map<string, Connector>([
    ['erp.lookup', (p) => (calls.push(`lookup:${p.invoiceNo}`), undefined)],
    ['erp.pay', (p) => { calls.push(`pay:${p.invoiceNo}`); ledger.set(String(p.invoiceNo), { ...p }); return { externalRef: `ERP-${p.invoiceNo}`, actual: { ...ledger.get(String(p.invoiceNo))! } }; }],
  ]);
  refuse = null;
  authCalls = [];
  ex = new SopExecutor({ sop: () => sop, inbox: () => inbox, gateway: new ToolGateway(), tools: (id) => tools[id] ?? null, connectors, reviewerOf: () => 'owner-1', authorize: (_r, toolId, emp) => (authCalls.push([toolId, emp]), refuse) });
  versionId = publish();
});

const approvalOf = (runId: string) => inbox.all().find((i) => i.kind === 'action_approval' && i.payload.executionId === runId)!;

describe('SOP executor main line', () => {
  it('runs to the human review, writes only after approval, reads back and completes', async () => {
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-1', startedBy: 'owner-1', data: input });
    expect(run.status).toBe('waiting_human');
    expect(run.steps.map((s) => [s.nodeId, s.status])).toEqual([['t', 'done'], ['a', 'done'], ['e', 'done'], ['r', 'done'], ['h', 'waiting_human'], ['w', 'pending']]);
    expect(calls).toEqual(['lookup:INV-480']); // read step ran; no write yet
    const item = approvalOf(run.id);
    expect(item.payload).toMatchObject({ executionId: run.id, stepId: 'w', toolId: 'erp.pay', invoiceNo: 'INV-480', amount: 480 });
    expect(item.assigneeUserId).toBe('owner-1');

    const decided = inbox.decide(item.id, 'owner-1', item.payloadVersion);
    expect(decided.ok).toBe(true);
    const done = (await ex.onDecided(decided.item))!;
    expect(done.status).toBe('completed');
    expect(calls).toEqual(['lookup:INV-480', 'pay:INV-480']);
    const w = done.steps.find((s) => s.nodeId === 'w')!;
    expect(w).toMatchObject({ status: 'done', readback: input });
    expect(w.detail).toContain('回读一致');
    expect(ledger.get('INV-480')).toEqual(input);
    // the same approval cannot make it write twice
    expect(await ex.onDecided(decided.item)).toBeNull();
    expect(calls.filter((c) => c.startsWith('pay'))).toHaveLength(1);
  });

  it('missing required input asks for it instead of running', async () => {
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-2', startedBy: 'owner-1', data: { invoiceNo: 'INV-1' } });
    expect(run.status).toBe('blocked');
    expect(run.steps[0]!.detail).toContain('缺少必填字段：amount');
    const supply = inbox.all().find((i) => i.kind === 'supply_info')!;
    expect(supply.payload).toMatchObject({ executionId: run.id, missingFields: ['amount'] });
    expect(calls).toEqual([]);
  });

  it('read-back mismatch: outcome unknown, frozen, exception opened, approval cannot be re-submitted, no second write', async () => {
    connectors.set('erp.pay', (p) => (calls.push(`pay:${p.invoiceNo}`), { externalRef: 'ERP-X', actual: { ...p, amount: 4800 } }));
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-3', startedBy: 'owner-1', data: input });
    const item = approvalOf(run.id);
    const after = (await ex.onDecided(inbox.decide(item.id, 'owner-1', 1).item))!;
    expect(after.status).toBe('outcome_unknown');
    expect(after.steps.find((s) => s.nodeId === 'w')!.detail).toContain('回读与批准的值不一致');
    const exc = inbox.all().find((i) => i.id === after.exceptionItemId)!;
    expect(exc).toMatchObject({ kind: 'exception_ruling', payload: { executionId: run.id, reason: 'readback_mismatch', intended: input, readback: { ...input, amount: 4800 } } });
    expect(inbox.all().find((i) => i.id === item.id)!.actionStatus).toBe('outcome_unknown');
    expect(inbox.decide(item.id, 'owner-1', 1)).toMatchObject({ ok: false, reason: 'no_resubmit' });
    expect(calls.filter((c) => c.startsWith('pay'))).toHaveLength(1);
  });

  it('timeout: outcome unknown, never retried automatically', async () => {
    connectors.set('erp.pay', () => { calls.push('pay'); throw new OutcomeUnknownError('timeout'); });
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-4', startedBy: 'owner-1', data: input });
    const after = (await ex.onDecided(inbox.decide(approvalOf(run.id).id, 'owner-1', 1).item))!;
    expect(after.status).toBe('outcome_unknown');
    expect(after.steps.find((s) => s.nodeId === 'w')!.detail).toContain('不会自动重试');
    expect(calls).toEqual(['lookup:INV-480', 'pay']); // one write attempt only
  });

  it('a revised approval no longer matches the run parameters: blocked, nothing written', async () => {
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-5', startedBy: 'owner-1', data: input });
    const item = approvalOf(run.id);
    const revised = inbox.revise(item.id, { amount: 9999 });
    const after = (await ex.onDecided(inbox.decide(item.id, 'owner-1', revised.payloadVersion).item))!;
    expect(after.status).toBe('blocked');
    expect(after.steps.find((s) => s.nodeId === 'w')!.detail).toBe('批准的参数与本次写入不一致');
    expect(calls.filter((c) => c.startsWith('pay'))).toEqual([]);
  });

  it('blocks honestly without a connector or an available tool; refuses unpublished versions and duplicate events', async () => {
    connectors.delete('erp.lookup');
    expect(await ex.start({ tenantId: 't', versionId, eventId: 'mail-6', startedBy: 'o', data: input })).toMatchObject({ status: 'blocked' });
    expect(ex.list('t').at(-1)!.steps.find((s) => s.nodeId === 'r')!.detail).toContain('没有已安装的连接器');
    connectors.set('erp.lookup', () => undefined);
    tools['erp.lookup'] = { effect: 'read', available: false };
    expect((await ex.start({ tenantId: 't', versionId, eventId: 'mail-7', startedBy: 'o', data: input })).steps.find((s) => s.nodeId === 'r')!.detail).toContain('不可用');
    const draft = sop.draft('other', { requiredFields: [], employeeStatus: 'active', graph } as never);
    await expect(ex.start({ tenantId: 't', versionId: draft.id, eventId: 'x', startedBy: 'o', data: {} })).rejects.toThrow(/published/);
    await expect(ex.start({ tenantId: 't', versionId, eventId: 'mail-7', startedBy: 'o', data: input })).rejects.toThrow(/already opened/);
  });

  it('re-authorises every call at execution time: a refusal blocks the run and nothing is written', async () => {
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-9', startedBy: 'owner-1', data: input });
    expect(authCalls).toEqual([['erp.lookup', 'emp-1']]); // the read step was authorised for the performing employee
    refuse = '数字员工当前状态为 paused，不能执行'; // e.g. the employee was paused after the approval was requested
    const item = approvalOf(run.id);
    const after = (await ex.onDecided(inbox.decide(item.id, 'owner-1', 1).item))!;
    expect(after.status).toBe('blocked');
    expect(after.steps.find((s) => s.nodeId === 'w')).toMatchObject({ status: 'blocked', detail: '未授权，未写入：数字员工当前状态为 paused，不能执行' });
    expect(authCalls.at(-1)).toEqual(['erp.pay', 'emp-1']);
    expect(calls.filter((c) => c.startsWith('pay'))).toEqual([]);
    expect(ledger.size).toBe(0);
  });

  it('a read step is refused too when not authorised', async () => {
    refuse = '工具 erp.lookup 没有为该数字员工安装并绑定账号';
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-10', startedBy: 'owner-1', data: input });
    expect(run.status).toBe('blocked');
    expect(run.steps.find((s) => s.nodeId === 'r')!.detail).toContain('未授权');
    expect(calls).toEqual([]);
    expect(inbox.all().filter((i) => i.kind === 'action_approval')).toEqual([]);
  });

  it('runs are tenant-scoped: another tenant cannot list, read or resume them', async () => {
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-8', startedBy: 'owner-1', data: input });
    expect(ex.list('other')).toEqual([]);
    expect(() => ex.get('other', run.id)).toThrow(/not found/);
    const item = approvalOf(run.id);
    expect(await ex.onDecided({ ...inbox.decide(item.id, 'owner-1', 1).item, tenantId: 'other' })).toBeNull();
    expect(ex.get('t', run.id).status).toBe('waiting_human');
    expect(calls.filter((c) => c.startsWith('pay'))).toEqual([]);
  });

  it('records the employee and tool installation on the gateway row at call time', async () => {
    const gateway = new ToolGateway();
    const watched = new SopExecutor({
      sop: () => sop,
      inbox: () => inbox,
      gateway,
      tools: (id) => tools[id] ?? null,
      connectors,
      reviewerOf: () => 'owner-1',
      authorize: () => null,
      identityOf: (employeeId, toolId) => ({ userId: 'owner-1', toolInstallationId: `${toolId}:${employeeId}@1.0.0+3` }),
    });
    await watched.start({ tenantId: 't', versionId, eventId: 'mail-identity', startedBy: 'owner-1', data: input });
    expect(gateway.snapshot().actions[0]?.identitySnapshot).toEqual({
      employeeId: 'emp-1',
      userId: 'owner-1',
      toolInstallationId: 'erp.lookup:emp-1@1.0.0+3',
    });
  });

  it('a restarted process resumes the same run from the saved inbox and does not write twice', async () => {
    const run = await ex.start({ tenantId: 't', versionId, eventId: 'mail-restart', startedBy: 'owner-1', data: input });
    const inbox2 = new WorkInbox();
    inbox2.load(inbox.snapshot());
    const resumed = new SopExecutor({
      sop: () => sop,
      inbox: () => inbox2,
      gateway: new ToolGateway(),
      tools: (id) => tools[id] ?? null,
      connectors,
      reviewerOf: () => 'owner-1',
      authorize: () => null,
    });
    resumed.load(ex.snapshot());
    const item = inbox2.all().find((i) => i.kind === 'action_approval' && i.payload.executionId === run.id)!;
    const done = (await resumed.onDecided(inbox2.decide(item.id, 'owner-1', item.payloadVersion).item))!;
    expect(done.id).toBe(run.id);
    expect(done.status).toBe('completed');
    expect(calls.filter((c) => c.startsWith('pay'))).toHaveLength(1);
    expect(await resumed.onDecided(inbox2.all().find((i) => i.id === item.id)!)).toBeNull();
  });

  it('runs in graph order', () => {
    expect(stepOrder(graph)).toEqual(['t', 'a', 'e', 'r', 'h', 'w']);
  });

  it('commits the executing row before the connector runs, and a failed commit does not call', async () => {
    const gateway = new ToolGateway();
    let committedCalls = -1;
    const watched = new SopExecutor({
      sop: () => sop,
      inbox: () => inbox,
      gateway,
      tools: (id) => tools[id] ?? null,
      connectors,
      reviewerOf: () => 'owner-1',
      authorize: () => null,
      commitBeforeCall: async () => {
        committedCalls = calls.length;
        const row = gateway.snapshot().actions.at(-1);
        expect(row?.status).toBe('executing');
        expect(row?.calls).toBe(0);
      },
    });
    await watched.start({ tenantId: 't', versionId, eventId: 'mail-commit', startedBy: 'owner-1', data: input });
    expect(committedCalls).toBe(0);
    expect(calls).toEqual(['lookup:INV-480']);

    calls.length = 0;
    const failing = new SopExecutor({
      sop: () => sop,
      inbox: () => inbox,
      gateway: new ToolGateway(),
      tools: (id) => tools[id] ?? null,
      connectors,
      reviewerOf: () => 'owner-1',
      authorize: () => null,
      commitBeforeCall: async () => {
        throw new Error('db down');
      },
    });
    const blocked = await failing.start({ tenantId: 't', versionId, eventId: 'mail-commit-fail', startedBy: 'owner-1', data: input });
    expect(blocked.status).toBe('blocked');
    expect(blocked.steps.find((s) => s.nodeId === 'r')!.detail).toContain('尚未落盘');
    expect(calls).toEqual([]);
  });

  it('runs an already claimed instance once, and persists that run before the tool call', async () => {
    const order: string[] = [];
    const run = await ex.runClaimed(
      { tenantId: 't', versionId, instanceId: 'mail_1', eventId: 'mail-1', startedBy: 'owner-1', data: input },
      async () => { order.push('commit'); expect(calls).toEqual([]); },
    );
    order.push('done');
    expect(order).toEqual(['commit', 'done']);
    expect(sop.instancesOf('invoice-intake')).toEqual([]);
    expect(run.id).toBe('run_mail_1');
    expect(run.instanceId).toBe('mail_1');
    expect(run.status).toBe('waiting_human');
    expect(calls).toEqual(['lookup:INV-480']);

    const again = await ex.runClaimed(
      { tenantId: 't', versionId, instanceId: 'mail_1', eventId: 'mail-1', startedBy: 'owner-1', data: input },
      async () => { throw new Error('must not commit twice'); },
    );
    expect(again.id).toBe(run.id);
    expect(calls).toEqual(['lookup:INV-480']);
  });

  it('drops the claimed run and does not call the tool when the run row loses the insert', async () => {
    await expect(ex.runClaimed(
      { tenantId: 't', versionId, instanceId: 'mail_2', eventId: 'mail-2', startedBy: 'owner-1', data: input },
      async () => { throw new Error('lost'); },
    )).rejects.toThrow('lost');
    expect(calls).toEqual([]);
    expect(ex.byInstance('t', 'mail_2')).toBeNull();
    expect(sop.instancesOf('invoice-intake')).toEqual([]);
  });
});
