import type { FastifyPluginAsync } from 'fastify';
import { inboxState } from '../humanwork/index.js';
import { openDeadLetterItem } from './dead-letter.js';
import { claimTask, deadLetterTask, enqueueWork, heartbeatTask, releaseTask, succeedTask, type Queryable } from './pg-queue.js';
import { TaskQueue, WORK_KINDS, type WorkRef } from './queue.js';
import { CLAIM_TASK_SQL } from './sql.js';

const LEASE_MS = 60_000;

function newQueue(): TaskQueue {
  return new TaskQueue(LEASE_MS, (task) => openDeadLetterItem(inboxState.current, task));
}

export const runtimeState: { queue: TaskQueue; db: Queryable | null } = { queue: newQueue(), db: null };

/** When set, claim, heartbeat, succeed, fail, and enqueue use the Postgres statements. */
export function bindRuntimeDb(db: Queryable | null): void {
  runtimeState.db = db;
}

export function resetRuntime(): void {
  runtimeState.queue = newQueue();
  runtimeState.db = null;
}

function attemptCeiling(value: unknown): number | null {
  if (value === undefined) return 3;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return null;
  return value;
}

export const runtimeModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({
    module: 'runtime',
    claim: CLAIM_TASK_SQL.includes('FOR UPDATE SKIP LOCKED'),
  }));

  app.post('/tasks', async (req, reply) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const body = (req.body ?? {}) as { id?: string; assigneeUserId?: string; projectId?: string; maxAttempts?: number };
    return runtimeState.queue.add({
      id: body.id,
      tenantId,
      assigneeUserId: body.assigneeUserId ?? null,
      projectId: body.projectId ?? null,
      maxAttempts: body.maxAttempts,
    });
  });

  app.post('/work', async (req, reply) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const body = (req.body ?? {}) as { kind?: string; payload?: WorkRef; notBefore?: number };
    if (!body.kind || !WORK_KINDS.includes(body.kind as (typeof WORK_KINDS)[number]) || !body.payload) {
      return reply.code(400).send({ error: 'bad_work' });
    }
    // The signed-in tenant wins. A tenant id in the payload cannot enqueue work for someone else.
    const payload = { ...body.payload, tenantId };
    try {
      if (runtimeState.db) return await enqueueWork(runtimeState.db, body.kind, payload, body.notBefore);
      return runtimeState.queue.enqueue(body.kind as (typeof WORK_KINDS)[number], payload, body.notBefore);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
  });

  app.post('/tasks/:id/succeed', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { workerId?: string };
    if (!body.workerId) return reply.code(400).send({ error: 'missing_worker' });
    if (runtimeState.db) {
      const ok = await succeedTask(runtimeState.db, params.id, body.workerId);
      if (!ok) return reply.code(409).send({ error: 'lease_lost' });
      return { id: params.id, status: 'reported' };
    }
    try {
      return runtimeState.queue.succeed(params.id, body.workerId, Date.now());
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });

  app.post('/claim', async (req, reply) => {
    const body = (req.body ?? {}) as { workerId?: string; maxAttempts?: number; kinds?: string[] };
    if (!body.workerId) return reply.code(400).send({ error: 'missing_worker' });
    const tenantId = req.user?.tenantId;
    if (!tenantId) return reply.code(401).send({ error: 'unauthenticated' });
    const kinds = Array.isArray(body.kinds) ? body.kinds.filter((kind) => WORK_KINDS.includes(kind as (typeof WORK_KINDS)[number])) : undefined;
    if (runtimeState.db) {
      const maxAttempts = attemptCeiling(body.maxAttempts);
      if (maxAttempts === null) return reply.code(400).send({ error: 'bad_attempts' });
      return { task: await claimTask(runtimeState.db, body.workerId, LEASE_MS, maxAttempts, tenantId, kinds) };
    }
    return { task: runtimeState.queue.claim(body.workerId, Date.now(), kinds, tenantId) };
  });

  app.post('/tasks/:id/heartbeat', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { workerId?: string };
    if (!body.workerId) return reply.code(400).send({ error: 'missing_worker' });
    if (runtimeState.db) {
      return { ok: await heartbeatTask(runtimeState.db, params.id, body.workerId, LEASE_MS) };
    }
    return { ok: runtimeState.queue.heartbeat(params.id, body.workerId, Date.now()) };
  });

  app.post('/tasks/:id/fail', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { workerId?: string; reason?: string; maxAttempts?: number };
    if (!body.workerId || !body.reason) return reply.code(400).send({ error: 'missing_fail' });
    if (runtimeState.db) {
      const maxAttempts = attemptCeiling(body.maxAttempts);
      if (maxAttempts === null) return reply.code(400).send({ error: 'bad_attempts' });
      if (await releaseTask(runtimeState.db, params.id, body.workerId, maxAttempts)) {
        return { deadLettered: false };
      }
      if (await deadLetterTask(runtimeState.db, params.id, body.workerId, maxAttempts, body.reason)) {
        return { deadLettered: true };
      }
      return reply.code(409).send({ error: 'lease_lost' });
    }
    try {
      return runtimeState.queue.fail(params.id, body.workerId, Date.now(), body.reason);
    } catch (error) {
      return reply.code(409).send({ error: (error as Error).message });
    }
  });
};
