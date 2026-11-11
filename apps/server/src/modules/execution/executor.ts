/**
 * SOP instance executor (T-56): connects the T-41 pieces into the main line
 *   trigger → SOP instance → (supply info?) → steps → human review → approval → gateway write → read-back.
 * Rules, in order of importance:
 *  - a write only happens through ToolGateway with an approval bound to the exact parameters (payload hash);
 *  - an unknown outcome (timeout) or a read-back mismatch freezes the run; nothing is retried automatically, the
 *    approval cannot be re-submitted, and an exception item is opened that links back to the run;
 *  - missing pieces (connector, available tool, authorisation, required input) block honestly — never a fake success.
 */
import type { SopGraph, ToolEffect } from '@superagent/shared';
import { OutcomeUnknownError, payloadHash, type ToolGateway } from '../gateway/gateway.js';
import type { WorkInbox, WorkItem } from '../humanwork/work-items.js';
import type { SopRuntime, SopVersion } from '../sop/sop.js';

/** A tool implementation (installed connector / replayed procedure). Synchronous like the gateway's call. */
export type Connector = (params: Record<string, unknown>) => { externalRef?: string; actual?: Record<string, unknown> } | void;

export interface ToolInfo {
  effect: ToolEffect;
  available: boolean;
}

export type StepStatus = 'pending' | 'done' | 'waiting_human' | 'blocked' | 'outcome_unknown';
export type ExecutionStatus = 'running' | 'waiting_human' | 'completed' | 'blocked' | 'outcome_unknown';

export interface ExecutionStep {
  nodeId: string;
  kind: string;
  label: string;
  status: StepStatus;
  detail: string | null;
  workItemId: string | null;
  actionId: string | null;
  readback: unknown | null;
}

export interface Execution {
  id: string;
  tenantId: string;
  sopId: string;
  versionId: string;
  versionNumber: number;
  instanceId: string;
  eventId: string;
  startedBy: string;
  input: Record<string, unknown>;
  status: ExecutionStatus;
  steps: ExecutionStep[];
  exceptionItemId: string | null;
}

export interface ExecutorDeps {
  sop: () => SopRuntime;
  inbox: () => WorkInbox;
  gateway: ToolGateway;
  tools: (toolId: string) => ToolInfo | null;
  connectors: Map<string, Connector>;
  /** Who receives approvals and exceptions (the SOP owner by default). */
  reviewerOf: (execution: Execution) => string;
  /**
   * Re-authorisation at the moment of the call (PRD §5.7), not at trigger time: may this employee call this tool now?
   * Returns null when allowed, otherwise the reason. The gateway refuses and nothing is invoked when it is not null.
   */
  authorize: (execution: Execution, toolId: string, employeeId: string | null) => string | null;
  /** Who is bound to this tool at the moment of the call. Omitted in tests that do not check the snapshot. */
  identityOf?: (employeeId: string, toolId: string) => { userId: string; toolInstallationId: string } | null;
  /**
   * Persist the gateway snapshot after a row is marked executing and before the connector runs.
   * Absent in unit tests, which call the tool without a database.
   */
  commitBeforeCall?: () => Promise<void>;
  /**
   * Fresh external values for an unknown write. This is a read, not the write connector.
   * Absent or throwing means reconcile refuses without calling gateway.readBack.
   */
  readBackActual?: (toolId: string, params: Record<string, unknown>) => Record<string, unknown> | null;
}

export class ExecutionError extends Error {
  constructor(public code: string, message: string, public statusCode = 409) {
    super(message);
  }
}

/** Topological order from the trigger (the graph is a DAG; publish already validated it). */
export function stepOrder(g: SopGraph): string[] {
  const indeg = new Map(g.nodes.map((n) => [n.id, 0]));
  for (const e of g.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = g.nodes.filter((n) => (indeg.get(n.id) ?? 0) === 0).map((n) => n.id);
  const out: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    out.push(id);
    for (const e of g.edges.filter((x) => x.from === id)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  return out;
}

export class SopExecutor {
  private readonly runs = new Map<string, Execution>();
  private seq = 0;

  constructor(private deps: ExecutorDeps) {}

  snapshot(): { runs: Execution[]; seq: number } {
    return { runs: [...this.runs.values()].map((run) => structuredClone(run)), seq: this.seq };
  }

  /** Replaces the in-memory runs. The inbox and SOP version must already be loaded. */
  load(saved: { runs: Execution[]; seq: number }): void {
    this.runs.clear();
    let seq = saved.seq;
    for (const run of saved.runs) {
      const copy = structuredClone(run);
      this.runs.set(copy.id, copy);
      const n = Number(/^ex_(\d+)$/.exec(copy.id)?.[1] ?? 0);
      if (n > seq) seq = n;
    }
    this.seq = seq;
  }

  /** Runs of one tenant only; another tenant's run is indistinguishable from a missing one. */
  list(tenantId: string, sopId?: string): Execution[] {
    return [...this.runs.values()].filter((r) => r.tenantId === tenantId && (!sopId || r.sopId === sopId)).map((r) => structuredClone(r));
  }

  get(tenantId: string, id: string): Execution {
    const r = this.runs.get(id);
    if (!r || r.tenantId !== tenantId) throw new ExecutionError('not_found', 'execution not found', 404);
    return structuredClone(r);
  }

  /**
   * Read back an existing unknown run. Loads that run only: no manualStart, no new instance, no write connector.
   * A refusal leaves the run and its gateway row unchanged.
   */
  reconcile(tenantId: string, runId: string, actorUserId: string): Execution {
    const run = this.runs.get(runId);
    if (!run || run.tenantId !== tenantId || actorUserId !== run.startedBy) throw new ExecutionError('not_found', '找不到可核对的原执行，或当前身份没有访问权限', 404);
    if (run.status !== 'outcome_unknown') return structuredClone(run);
    const step = run.steps.find((s) => s.status === 'outcome_unknown');
    if (!step) return structuredClone(run);
    const version = this.deps.sop().get(run.versionId);
    const definition = version.definition as { employeeStatus?: string; graph?: SopGraph };
    if (definition.employeeStatus === 'paused') throw new ExecutionError('not_authorized', '流程员工已暂停，未调用外部系统', 403);
    const toolId = definition.graph?.nodes.find((n) => n.id === step.nodeId)?.ref;
    if (!toolId) throw new ExecutionError('not_found', '找不到可核对的原执行', 404);
    const employeeId = this.employeeFor(run, step.nodeId);
    const refusal = this.deps.authorize(structuredClone(run), toolId, employeeId);
    if (refusal) throw new ExecutionError('not_authorized', refusal, 403);
    if (!this.deps.readBackActual) throw new ExecutionError('readback_unavailable', '只读核对暂不可用，没有重新提交外部动作', 503);
    let actual: Record<string, unknown> | null;
    try {
      actual = this.deps.readBackActual(toolId, this.paramsFor(run));
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      throw new ExecutionError('readback_unavailable', '只读核对暂不可用，没有重新提交外部动作', 503);
    }
    const key = [run.tenantId, run.instanceId, step.nodeId, run.eventId].join(':');
    const result = this.deps.gateway.readBack(key, actual);
    const confirmed = result.action.status === 'confirmed';
    step.readback = result.action.readback;
    if (confirmed) {
      step.status = 'done';
      step.detail = '已回读一致，没有再次提交外部动作';
      if (run.steps.every((s) => s.status === 'done')) run.status = 'completed';
    } else {
      step.detail = '回读与批准的值不一致，已停止，不会重复写入';
      run.status = 'outcome_unknown';
    }
    const approval = this.approvalFor(run, step.nodeId);
    if (approval) this.deps.inbox().noteReadback(approval.id, confirmed);
    return structuredClone(run);
  }

  /** The run already bound to this claimed instance, if this process has it. */
  byInstance(tenantId: string, instanceId: string): Execution | null {
    const found = [...this.runs.values()].find((run) => run.tenantId === tenantId && run.instanceId === instanceId);
    return found ? structuredClone(found) : null;
  }

  /** Keep a run loaded from storage. Does not resume it or open another instance. */
  remember(run: Execution): Execution {
    const existing = this.byInstance(run.tenantId, run.instanceId);
    if (existing) return existing;
    const copy = structuredClone(run);
    this.runs.set(copy.id, copy);
    return structuredClone(copy);
  }

  /** Trigger: open a SOP instance for a published version and run until a human step or the end. */
  async start(input: { tenantId: string; versionId: string; eventId: string; startedBy: string; data: Record<string, unknown> }): Promise<Execution> {
    const sop = this.deps.sop();
    const version = sop.get(input.versionId);
    if (version.status !== 'published') throw new ExecutionError('not_published', 'only a published SOP version can run');
    const graph = (version.definition as { graph?: SopGraph }).graph;
    if (!graph?.nodes.length) throw new ExecutionError('no_graph', 'the SOP version has no flow graph');
    const instance = sop.manualStart(input.tenantId, input.versionId, input.eventId, true);
    if (!instance) throw new ExecutionError('not_started', 'the same event already opened an instance, or the SOP is paused');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const run: Execution = {
      id: `ex_${++this.seq}`,
      tenantId: input.tenantId,
      sopId: version.sopId,
      versionId: version.id,
      versionNumber: version.number,
      instanceId: instance.id,
      eventId: input.eventId,
      startedBy: input.startedBy,
      input: structuredClone(input.data),
      status: 'running',
      steps: stepOrder(graph).map((id) => ({ nodeId: id, kind: byId.get(id)!.kind, label: byId.get(id)!.label, status: 'pending', detail: null, workItemId: null, actionId: null, readback: null })),
      exceptionItemId: null,
    };
    this.runs.set(run.id, run);
    return this.settle(run, version, graph);
  }

  /**
   * Run an instance another process already claimed and inserted.
   * Does not call manualStart. A second call for the same instance returns the existing run and does not advance.
   * commitRun is awaited before any tool call; if it throws, the local run is dropped and nothing is invoked.
   */
  async runClaimed(
    input: { tenantId: string; versionId: string; instanceId: string; eventId: string; startedBy: string; data: Record<string, unknown> },
    commitRun?: (run: Execution) => Promise<void>,
  ): Promise<Execution> {
    const existing = this.byInstance(input.tenantId, input.instanceId);
    if (existing) return existing;
    const sop = this.deps.sop();
    const version = sop.get(input.versionId);
    if (version.status !== 'published') throw new ExecutionError('not_published', 'only a published SOP version can run');
    const graph = (version.definition as { graph?: SopGraph }).graph;
    if (!graph?.nodes.length) throw new ExecutionError('no_graph', 'the SOP version has no flow graph');
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const run: Execution = {
      id: `run_${input.instanceId}`,
      tenantId: input.tenantId,
      sopId: version.sopId,
      versionId: version.id,
      versionNumber: version.number,
      instanceId: input.instanceId,
      eventId: input.eventId,
      startedBy: input.startedBy,
      input: structuredClone(input.data),
      status: 'running',
      steps: stepOrder(graph).map((id) => ({ nodeId: id, kind: byId.get(id)!.kind, label: byId.get(id)!.label, status: 'pending', detail: null, workItemId: null, actionId: null, readback: null })),
      exceptionItemId: null,
    };
    this.runs.set(run.id, run);
    if (commitRun) {
      try {
        await commitRun(structuredClone(run));
      } catch (error) {
        this.runs.delete(run.id);
        throw error;
      }
    }
    return this.settle(run, version, graph);
  }

  private async settle(run: Execution, version: SopVersion, graph: SopGraph): Promise<Execution> {
    const missing = (version.definition.requiredFields ?? []).filter((f) => run.input[f] === undefined || run.input[f] === '');
    if (missing.length) {
      const item = this.deps.inbox().create({ id: this.itemId(run, run.steps[0]?.nodeId ?? 'start', 'supply_info'), tenantId: run.tenantId, kind: 'supply_info', assigneeUserId: this.deps.reviewerOf(run), payload: { executionId: run.id, title: `补资料：缺少 ${missing.join('、')}（事件 ${run.eventId}）`, missingFields: missing } });
      run.status = 'blocked';
      run.steps[0]!.status = 'blocked';
      run.steps[0]!.detail = `缺少必填字段：${missing.join('，')}`;
      run.steps[0]!.workItemId = item.id;
      return structuredClone(run);
    }
    await this.advance(run, graph);
    return structuredClone(run);
  }

  /** Called when a work item is decided. Resumes the run whose approval it is; ignores everything else. */
  async onDecided(item: WorkItem): Promise<Execution | null> {
    const executionId = typeof item.payload.executionId === 'string' ? item.payload.executionId : null;
    if (!executionId || item.kind !== 'action_approval') return null;
    const run = this.runs.get(executionId);
    if (!run || run.tenantId !== item.tenantId || run.status !== 'waiting_human') return null;
    const graph = (this.deps.sop().get(run.versionId).definition as { graph?: SopGraph }).graph!;
    const review = run.steps.find((s) => s.workItemId === item.id && s.status === 'waiting_human');
    if (!review) return null;
    review.status = 'done';
    review.detail = `已由 ${item.decision?.by ?? '审核人'} 批准`;
    await this.advance(run, graph);
    return structuredClone(run);
  }

  private async advance(run: Execution, graph: SopGraph): Promise<void> {
    run.status = 'running';
    for (const step of run.steps) {
      if (step.status === 'done') continue;
      if (step.status !== 'pending') return; // waiting / blocked / unknown stop the run here
      const node = graph.nodes.find((n) => n.id === step.nodeId)!;
      if (node.kind === 'human_review') {
        const next = this.nextWriteTool(run, graph, step.nodeId);
        const params = this.paramsFor(run);
        const item = this.deps.inbox().create({
          id: this.itemId(run, step.nodeId, 'action_approval'),
          tenantId: run.tenantId,
          kind: 'action_approval',
          assigneeUserId: this.deps.reviewerOf(run),
          payload: { executionId: run.id, stepId: next?.id ?? step.nodeId, toolId: next?.ref ?? null, sop: `${run.sopId} v${run.versionNumber}`, title: next ? `批准写入「${next.label}」（事件 ${run.eventId}）` : `确认「${step.label}」（事件 ${run.eventId}）`, ...params },
        });
        step.status = 'waiting_human';
        step.workItemId = item.id;
        step.detail = next ? `等待批准写入「${next.label}」` : '等待人工确认';
        run.status = 'waiting_human';
        return;
      }
      if (node.kind === 'tool') {
        if (!(await this.runTool(run, step, node.ref ?? ''))) return;
        continue;
      }
      step.status = 'done'; // trigger / agent / employee: routing only
    }
    run.status = 'completed';
  }

  private async runTool(run: Execution, step: ExecutionStep, toolId: string): Promise<boolean> {
    const tool = this.deps.tools(toolId);
    const connector = this.deps.connectors.get(toolId);
    if (!tool || !tool.available) return this.block(run, step, `工具 ${toolId} 不可用（未发布、未部署或未完成账号绑定）`);
    if (!connector) return this.block(run, step, `工具 ${toolId} 没有已安装的连接器`);
    const params = this.paramsFor(run);
    const write = tool.effect === 'write' || tool.effect === 'external';
    let approvalHash: string | null = null;
    let approvalItem: WorkItem | null = null;
    if (write) {
      approvalItem = this.approvalFor(run, step.nodeId);
      // the approval must cover exactly these parameters (a revised item retires its decision)
      if (!approvalItem?.decision || approvalItem.decision.payloadHash !== approvalItem.payloadHash) return this.block(run, step, '写入没有有效的批准');
      const approved = this.paramsOf(approvalItem.payload);
      if (payloadHash(approved) !== payloadHash(params)) return this.block(run, step, '批准的参数与本次写入不一致');
      approvalHash = payloadHash(params);
    }
    const employeeId = this.employeeFor(run, step.nodeId);
    const bound = employeeId && this.deps.identityOf ? this.deps.identityOf(employeeId, toolId) : null;
    let refusal: string | null = null;
    const call = () => {
      const r = connector(params);
      return r ?? undefined;
    };
    const reserved = this.deps.gateway.reserve({
      tenantId: run.tenantId,
      instanceId: run.instanceId,
      stepId: step.nodeId,
      businessKey: run.eventId,
      effect: tool.effect,
      payload: params,
      intended: write ? params : undefined,
      approvalHash,
      identity: employeeId && bound ? { employeeId, userId: bound.userId, toolInstallationId: bound.toolInstallationId } : undefined,
      authorize: () => (refusal = this.deps.authorize(structuredClone(run), toolId, employeeId)) === null,
      call,
    });
    if (reserved.pending && this.deps.commitBeforeCall) {
      try {
        await this.deps.commitBeforeCall();
      } catch (error) {
        this.deps.gateway.abort(reserved.action.idempotencyKey);
        const message = error instanceof Error ? error.message : 'commit_failed';
        return this.block(run, step, `动作尚未落盘，未调用外部系统：${message}`);
      }
    }
    const result = reserved.pending ? this.deps.gateway.finish(reserved.action.idempotencyKey, call) : reserved;
    step.actionId = result.action.id;
    step.readback = result.action.readback;
    if (result.action.status === 'confirmed') {
      step.status = 'done';
      step.detail = write ? `已写入并回读一致（${result.action.externalRef ?? '无外部编号'}）` : '已读取';
      return true;
    }
    if (result.action.status === 'outcome_unknown') {
      step.status = 'outcome_unknown';
      step.detail = result.action.reason === 'readback_mismatch' ? '回读与批准的值不一致，已停止，不会重复写入' : '外部结果未知，已冻结，不会自动重试';
      run.status = 'outcome_unknown';
      if (approvalItem) this.deps.inbox().markOutcomeUnknown(approvalItem.id);
      const ex = this.deps.inbox().create({
        id: this.itemId(run, step.nodeId, 'exception_ruling'),
        tenantId: run.tenantId,
        kind: 'exception_ruling',
        assigneeUserId: this.deps.reviewerOf(run),
        payload: { executionId: run.id, stepId: step.nodeId, toolId, reason: result.action.reason, intended: params, readback: result.action.readback },
      });
      run.exceptionItemId = ex.id;
      return false;
    }
    if (result.action.reason === 'unauthorized') return this.block(run, step, `未授权，未写入：${refusal ?? '执行时鉴权未通过'}`);
    return this.block(run, step, result.action.reason === 'approval_mismatch' ? '批准与写入参数不匹配' : `未执行：${result.action.reason ?? result.action.status}`);
  }

  private itemId(run: Execution, nodeId: string, kind: string): string | undefined {
    return run.id.startsWith('run_') ? `wi_${run.id}_${nodeId}_${kind}` : undefined;
  }

  private block(run: Execution, step: ExecutionStep, why: string): false {
    step.status = 'blocked';
    step.detail = why;
    run.status = 'blocked';
    return false;
  }

  private nextWriteTool(run: Execution, graph: SopGraph, fromId: string) {
    const order = run.steps.map((s) => s.nodeId);
    for (const id of order.slice(order.indexOf(fromId) + 1)) {
      const n = graph.nodes.find((x) => x.id === id)!;
      if (n.kind === 'human_review') return null;
      if (n.kind === 'tool' && n.ref) {
        const t = this.deps.tools(n.ref);
        if (t && (t.effect === 'write' || t.effect === 'external')) return n;
      }
    }
    return null;
  }

  /** The digital employee that performs a tool step: the nearest employee node before it in run order. */
  private employeeFor(run: Execution, toolNodeId: string): string | null {
    const graph = (this.deps.sop().get(run.versionId).definition as { graph?: SopGraph }).graph!;
    const order = run.steps.map((s) => s.nodeId);
    for (const id of order.slice(0, order.indexOf(toolNodeId)).reverse()) {
      const n = graph.nodes.find((x) => x.id === id)!;
      if (n.kind === 'employee') return n.ref ?? null;
    }
    return null;
  }

  private approvalFor(run: Execution, toolNodeId: string): WorkItem | null {
    const toolAt = run.steps.findIndex((step) => step.nodeId === toolNodeId);
    const review = [...run.steps].reverse().find((step) => step.kind === 'human_review' && step.workItemId && run.steps.indexOf(step) < toolAt);
    const bound = review ?? run.steps.find((step) => step.nodeId === toolNodeId && step.workItemId);
    if (!bound?.workItemId) return null;
    const item = this.deps.inbox().all().find((candidate) => candidate.id === bound.workItemId) ?? null;
    if (!item || item.tenantId !== run.tenantId) return null;
    return item;
  }

  /** Business parameters of the run (the input), the same shape the approval shows. */
  private paramsFor(run: Execution): Record<string, unknown> {
    return structuredClone(run.input);
  }

  private paramsOf(payload: Record<string, unknown>): Record<string, unknown> {
    const { executionId: _e, stepId: _s, toolId: _t, sop: _p, title: _ti, ...rest } = payload;
    return rest;
  }
}

export { OutcomeUnknownError };
