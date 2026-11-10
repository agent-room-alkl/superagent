/**
 * SOP executions (T-56): start a run of a published SOP version, list and inspect runs. Approvals arrive through
 * 待我处理 (work-items decide) and resume the run; this module never writes without one.
 */
import type { FastifyPluginAsync } from 'fastify';
import { flushGateway, gatewayState, hydrateGateway } from '../gateway/index.js';
import { employeesState } from '../employees/index.js';
import { flushInbox, inboxState, workItemEvents } from '../humanwork/index.js';
import { insertWorkItem, loadWorkItemsForRun, updateWorkItem } from '../humanwork/pg-inbox.js';
import { insertRun, loadClaimedRuns, loadRunById, loadRunByInstance, loadRuns, saveRuns, updateRun, type Queryable } from './pg-runs.js';
import { flushSop, sopState } from '../sop/index.js';
import { loadVersionById } from '../sop/pg-sop.js';
import { toolsState } from '../tools/index.js';
import { ExecutionError, SopExecutor, type Connector, type Execution } from './executor.js';

/** Installed connectors by tool id. Production registers real ones; none registered means tool steps block. */
export const connectors = new Map<string, Connector>();
/** Read-only probes for an unknown write. Never the write connector. */
export const readbacks = new Map<string, (params: Record<string, unknown>) => Record<string, unknown> | null>();

function toolInfo(toolId: string) {
  try {
    const t = toolsState.current.get(toolId);
    const p = toolsState.current.stage(toolId, t.consumers[0]);
    return { effect: t.contract.effect, available: t.state === 'active' && p.done.length === 7 };
  } catch {
    return null;
  }
}

/** Call-time authorisation: the performing employee is online and the tool is installed and bound for it. */
function authorize(_run: unknown, toolId: string, employeeId: string | null): string | null {
  if (!employeeId) return '流程里没有负责执行这一步的数字员工';
  let status: string;
  try {
    status = employeesState.current.get(employeeId).status;
  } catch {
    return `数字员工 ${employeeId} 不存在`;
  }
  if (status !== 'online' && status !== 'busy') return `数字员工当前状态为 ${status}，不能执行`;
  if (!toolsState.current.callable(employeeId).some((t) => t.toolId === toolId)) return `工具 ${toolId} 没有为该数字员工安装并绑定账号`;
  return null;
}

export const executionState = {
  current: new SopExecutor({
    sop: () => sopState.current,
    inbox: () => inboxState.current,
    gateway: gatewayState.current,
    tools: toolInfo,
    connectors,
    reviewerOf: (run) => run.startedBy,
    authorize,
    identityOf: (employeeId, toolId) => {
      const bound = toolsState.current.callable(employeeId).find((t) => t.toolId === toolId);
      if (!bound) return null;
      try {
        return { userId: employeesState.current.get(employeeId).owner, toolInstallationId: `${toolId}:${employeeId}@${bound.version}+${bound.bindingVersion}` };
      } catch {
        return null;
      }
    },
    commitBeforeCall: () => flushGateway(),
    readBackActual: (toolId, params) => {
      const read = readbacks.get(toolId);
      if (!read) throw new ExecutionError('readback_unavailable', '只读核对暂不可用，没有重新提交外部动作', 503);
      return read(params);
    },
  }),
};

let runStore: Queryable | null = null;

export function bindExecutionStore(db: Queryable | null): void {
  runStore = db;
}

export async function flushExecutions(): Promise<void> {
  if (!runStore) return;
  const snapshot = executionState.current.snapshot();
  await saveRuns(runStore, snapshot);
  for (const run of snapshot.runs) {
    if (run.id.startsWith('run_')) await updateRun(runStore, run);
  }
}

export async function hydrateExecutions(): Promise<void> {
  if (!runStore) return;
  const saved = await loadRuns(runStore);
  if (saved) executionState.current.load(saved);
  for (const run of await loadClaimedRuns(runStore)) executionState.current.remember(run);
}

class ClaimLost extends Error {
  constructor(readonly winner: Execution) {
    super('claim_lost');
  }
}

/** The inserted row is all-pending until the first process finishes the step. Do not cache that transient copy. */
function settled(run: Execution): boolean {
  return run.status !== 'running' || run.steps.some((step) => step.status !== 'pending');
}

function keep(run: Execution): Execution {
  return settled(run) ? executionState.current.remember(run) : run;
}

/** Load the instance's pinned version into this process. Does not replace a version already in memory. */
async function ensurePinned(versionId: string): Promise<void> {
  try {
    if (sopState.current.get(versionId).status === 'published') return;
  } catch {
    /* This process has not hydrated the SOP runtime. */
  }
  if (!runStore) throw new ExecutionError('not_published', 'the pinned version is not loaded');
  const version = await loadVersionById(runStore, versionId);
  if (!version || version.status !== 'published') throw new ExecutionError('not_published', 'the pinned version is not published');
  sopState.current.pin(version);
}

/** Write only the items of this run. The shared inbox snapshot is left alone. */
async function persistClaimedItems(run: Execution): Promise<void> {
  if (!runStore) return;
  for (const item of inboxState.current.all()) {
    if (item.payload.executionId !== run.id) continue;
    await insertWorkItem(runStore, item);
  }
}

async function restoreClaimedItems(executionId: string): Promise<void> {
  if (!runStore) return;
  for (const item of await loadWorkItemsForRun(runStore, executionId)) inboxState.current.remember(item);
}

/**
 * Entry for a SOP instance that long-work already claimed and inserted.
 * Does not call manualStart or claim the event again.
 * The run is stored on its own row before any tool call. A second caller gets that row and does not advance.
 */
export async function runClaimedInstance(input: {
  tenantId: string;
  versionId: string;
  instanceId: string;
  eventId: string;
  startedBy: string;
  data: Record<string, unknown>;
}): Promise<Execution> {
  if (runStore) await ensurePinned(input.versionId);
  const local = executionState.current.byInstance(input.tenantId, input.instanceId);
  if (local) {
    await restoreClaimedItems(local.id);
    return local;
  }
  if (runStore) {
    const row = await runStore.query<{ sop_version_id: string; status: string }>(
      `SELECT sop_version_id, status FROM sop_instances WHERE id = $1 AND tenant_id = $2`,
      [input.instanceId, input.tenantId],
    );
    const claimed = row.rows[0];
    if (!claimed || claimed.status !== 'running' || claimed.sop_version_id !== input.versionId) {
      throw new ExecutionError('not_started', 'the instance is not a running claim for this version');
    }
    const saved = await loadRunByInstance(runStore, input.tenantId, input.instanceId);
    if (saved) {
      const kept = keep(saved);
      await restoreClaimedItems(kept.id);
      return kept;
    }
  }
  try {
    const run = await executionState.current.runClaimed(input, runStore ? async (draft) => {
      const won = await insertRun(runStore!, draft);
      if (won) return;
      const winner = await loadRunByInstance(runStore!, input.tenantId, input.instanceId);
      if (!winner) throw new ExecutionError('not_started', 'the claimed run disappeared before it could be read');
      throw new ClaimLost(winner);
    } : undefined);
    if (runStore) await updateRun(runStore, run);
    await persistClaimedItems(run);
    return run;
  } catch (error) {
    if (error instanceof ClaimLost) {
      const kept = keep(error.winner);
      await restoreClaimedItems(kept.id);
      return kept;
    }
    throw error;
  }
}

workItemEvents.decided.push(async (item) => {
  const executionId = item.payload.executionId;
  if (runStore && typeof executionId === 'string') {
    try {
      executionState.current.get(item.tenantId, executionId);
    } catch {
      const saved = await loadRunById(runStore, executionId);
      if (saved && saved.tenantId === item.tenantId) {
        await ensurePinned(saved.versionId);
        executionState.current.remember(saved);
      }
    }
  }
  const run = await executionState.current.onDecided(item);
  if (!run) return;
  await flushExecutions();
  await flushInbox();
  await flushGateway();
});

export const executionModule: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ExecutionError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err instanceof Error && /not_found|version_not_found/.test(err.message)) return reply.code(404).send({ error: 'not_found', message: err.message });
    return reply.send(err);
  });

  app.post<{ Body: { versionId?: string; eventId?: string; input?: Record<string, unknown> } }>('/', async (req, reply) => {
    const b = req.body ?? {};
    if (!b.versionId || !b.eventId || typeof b.input !== 'object' || b.input === null) return reply.code(400).send({ error: 'missing_fields' });
    const run = await executionState.current.start({ tenantId: req.user!.tenantId, versionId: b.versionId, eventId: b.eventId, startedBy: req.user!.userId, data: b.input });
    await flushSop();
    await flushExecutions();
    await flushInbox();
    await flushGateway();
    reply.code(201);
    return run;
  });

  app.get<{ Querystring: { sopId?: string } }>('/', async (req) => ({
    executions: executionState.current.list(req.user!.tenantId, req.query.sopId).map((run) => present(run, req.user!.userId)),
  }));
  app.post<{ Params: { id: string } }>('/:id/reconcile', async (req) => present(await reconcile(req.user!.tenantId, req.params.id, req.user!.userId), req.user!.userId));
  app.get<{ Params: { id: string } }>('/:id', async (req) => present(executionState.current.get(req.user!.tenantId, req.params.id), req.user!.userId));
};

function present(run: Execution, userId: string) {
  return { ...run, canReconcile: run.status === 'outcome_unknown' && run.startedBy === userId };
}

/** Test seam: runs after the approval is restored and before its row is written. */
export const beforeReadbackPersist: { current: (() => Promise<void>) | null } = { current: null };

/** Write the read-back onto the run's existing work-item rows. Does not insert, and does not rewrite another run or a newer contract. */
async function persistReadback(runId: string): Promise<void> {
  if (!runStore) return;
  for (const item of inboxState.current.all()) {
    if (item.payload.executionId !== runId) continue;
    const wrote = await updateWorkItem(runStore, item);
    if (wrote) continue;
    const fresh = (await loadWorkItemsForRun(runStore, runId)).find((row) => row.id === item.id);
    if (fresh) inboxState.current.remember(fresh);
  }
}

/** Load one existing run and read it back. Does not start, claim, or open a second run. */
export async function reconcile(tenantId: string, runId: string, actorUserId: string): Promise<Execution> {
  try {
    executionState.current.get(tenantId, runId);
  } catch {
    if (runStore) {
      const saved = await loadRunById(runStore, runId);
      if (saved && saved.tenantId === tenantId) {
        await ensurePinned(saved.versionId);
        executionState.current.remember(saved);
      }
    }
  }
  await restoreClaimedItems(runId);
  if (gatewayState.current.snapshot().actions.length === 0) await hydrateGateway();
  const run = executionState.current.reconcile(tenantId, runId, actorUserId);
  if (beforeReadbackPersist.current) await beforeReadbackPersist.current();
  await persistReadback(run.id);
  await flushExecutions();
  await flushInbox();
  await flushGateway();
  return run;
}
