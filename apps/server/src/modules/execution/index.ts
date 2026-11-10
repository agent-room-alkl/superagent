/**
 * SOP executions (T-56): start a run of a published SOP version, list and inspect runs. Approvals arrive through
 * 待我处理 (work-items decide) and resume the run; this module never writes without one.
 */
import type { FastifyPluginAsync } from 'fastify';
import { flushGateway, gatewayState } from '../gateway/index.js';
import { employeesState } from '../employees/index.js';
import { flushInbox, inboxState, workItemEvents } from '../humanwork/index.js';
import { loadRuns, saveRuns, type Queryable } from './pg-runs.js';
import { flushSop, sopState } from '../sop/index.js';
import { toolsState } from '../tools/index.js';
import { ExecutionError, SopExecutor, type Connector } from './executor.js';

/** Installed connectors by tool id. Production registers real ones; none registered means tool steps block. */
export const connectors = new Map<string, Connector>();

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
  }),
};

let runStore: Queryable | null = null;

export function bindExecutionStore(db: Queryable | null): void {
  runStore = db;
}

export async function flushExecutions(): Promise<void> {
  if (runStore) await saveRuns(runStore, executionState.current.snapshot());
}

export async function hydrateExecutions(): Promise<void> {
  if (!runStore) return;
  const saved = await loadRuns(runStore);
  if (saved) executionState.current.load(saved);
}

workItemEvents.decided.push(async (item) => {
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

  app.get<{ Querystring: { sopId?: string } }>('/', async (req) => ({ executions: executionState.current.list(req.user!.tenantId, req.query.sopId) }));
  app.get<{ Params: { id: string } }>('/:id', async (req) => executionState.current.get(req.user!.tenantId, req.params.id));
};
