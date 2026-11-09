/**
 * Worker entry (APP_ROLE=worker). Must run with minReplicas >= 1 (PRD §5.1).
 * Starts through the same fail-closed bootstrap as the web role: with Entra every production dependency must be
 * configured, and PostgreSQL must answer before the loop starts. Job handlers (T-40 parse/analysis, T-41 queue)
 * register on the loop and receive the runtime (pool, llm, config); none run against in-memory stores in production.
 */
import type { Runtime } from './bootstrap.js';
import { claimTask, type ClaimedTaskRow, type Queryable } from './modules/runtime/pg-queue.js';
import { WORK_KINDS, type QueueTask, type TaskQueue } from './modules/runtime/queue.js';

export type WorkerTick = (runtime: Runtime, signal: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  signal?: AbortSignal;
  runtime?: Runtime; // injected in tests; otherwise createRuntime(process.env)
  ticks?: WorkerTick[];
  heartbeatMs?: number;
  log?: (o: Record<string, unknown>) => void;
}

export async function runWorker(opts: WorkerOptions = {}): Promise<void> {
  const log = opts.log ?? ((o) => console.log(JSON.stringify(o)));
  const signal = opts.signal ?? new AbortController().signal;
  const runtime = opts.runtime ?? (await (await import('./bootstrap.js')).createRuntime(process.env));
  try {
    if (runtime.pool) await runtime.pool.query('SELECT 1'); // fail fast when the database is unreachable
    const heartbeatMs = opts.heartbeatMs ?? Number(process.env.WORKER_HEARTBEAT_MS ?? 15000);
    log({ msg: 'worker started', mode: runtime.config.mode, heartbeatMs, ticks: opts.ticks?.length ?? 0 });
    while (!signal.aborted) {
      for (const tick of opts.ticks ?? []) {
        try {
          await tick(runtime, signal);
        } catch (e) {
          log({ msg: 'worker tick failed', error: e instanceof Error ? e.message : String(e) });
        }
      }
      await new Promise((r) => setTimeout(r, heartbeatMs));
      log({ msg: 'worker heartbeat', at: new Date().toISOString() });
    }
  } finally {
    await runtime.close();
  }
}

// ---- T-41 runtime queue dispatch (ported from feat/runtime, author Grok) ----
const LEASE_MS = 60_000;

export function dispatchReady(queue: TaskQueue, workerId: string, now: number): QueueTask | null {
  const kinds = WORK_KINDS.filter((kind) => queue.handler(kind));
  if (!kinds.length) return null;
  const task = queue.claim(workerId, now, kinds);
  if (task?.kind) queue.handler(task.kind)?.(task);
  return task;
}

function registeredKinds(queue: TaskQueue): string[] {
  return WORK_KINDS.filter((kind) => queue.handler(kind));
}

/** One Postgres claim for a kind this process can run. No handler means no query and no attempt. */
export async function dispatchBound(db: Queryable, queue: TaskQueue, workerId: string): Promise<QueueTask | null> {
  const kinds = registeredKinds(queue);
  if (!kinds.length) return null;
  const row = await claimTask(db, workerId, LEASE_MS, 3, kinds);
  if (!row?.kind || !kinds.includes(row.kind)) return null;
  const task = claimedWork(row);
  queue.handler(row.kind)?.(task);
  return task;
}

function claimSnapshot(row: ClaimedTaskRow): Record<string, unknown> {
  const stored = row.identity_snapshot;
  if (stored && typeof stored === 'object') return { ...stored };
  return { workerId: row.lease_owner, attempt: row.attempt };
}

function claimedWork(row: ClaimedTaskRow): QueueTask {
  return {
    id: row.id,
    tenantId: row.tenant_id ?? '',
    instanceId: null,
    roomMessageId: null,
    employeeId: null,
    assigneeUserId: null,
    projectId: null,
    status: 'running',
    waitingReason: null,
    leaseOwner: row.lease_owner,
    leaseUntil: null,
    attempt: row.attempt,
    maxAttempts: row.max_attempts ?? 3,
    deadLetter: false,
    identitySnapshot: claimSnapshot(row),
    kind: row.kind ?? null,
    payload: row.payload ?? null,
    notBefore: null,
    createdAt: 0,
  };
}

/** T-41 queue loop (Grok): one claim per tick for registered kinds; used by tests and by the worker tick. */
export async function runQueueLoop(
  signal?: AbortSignal,
  queue?: TaskQueue,
  db?: Queryable | null | (() => Queryable | null),
): Promise<void> {
  const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS ?? 15000);
  const workerId = process.env.WORKER_ID ?? 'worker';
  const currentDb = () => (typeof db === 'function' ? db() : db);
  console.log(JSON.stringify({ msg: 'worker started', heartbeatMs }));
  while (!signal?.aborted) {
    try {
      const bound = currentDb();
      if (bound && queue) await dispatchBound(bound, queue, workerId);
      else if (queue) dispatchReady(queue, workerId, Date.now());
    } catch (error) {
      console.log(JSON.stringify({ msg: 'worker tick failed', error: error instanceof Error ? error.message : 'unknown' }));
    }
    await new Promise((r) => setTimeout(r, heartbeatMs));
    if (signal?.aborted) break;
    console.log(JSON.stringify({ msg: 'worker heartbeat', at: new Date().toISOString() }));
  }
}
