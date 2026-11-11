import { normalizeWork, requireTenantUuid, type WorkRef } from './queue.js';
import { CLAIM_TASK_KIND_SQL, CLAIM_TASK_SQL, DEAD_LETTER_SQL, FIND_OPEN_WORK_SQL, HEARTBEAT_TASK_SQL, INSERT_WORK_SQL, RELEASE_TASK_SQL, SUCCEED_TASK_SQL, UPDATE_NOT_BEFORE_SQL } from './sql.js';

export interface Queryable {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface ClaimedTaskRow {
  id: string;
  attempt: number;
  lease_owner: string;
  kind?: string | null;
  tenant_id?: string;
  payload?: WorkRef | null;
  max_attempts?: number;
  identity_snapshot?: Record<string, unknown> | null;
}

/** One round-trip claim. The SKIP LOCKED subquery is the only thing that may take the row. */
export async function claimTask(
  db: Queryable,
  workerId: string,
  leaseMs: number,
  maxAttempts: number,
  tenantId: string,
  kinds?: readonly string[],
): Promise<ClaimedTaskRow | null> {
  const filtered = kinds !== undefined;
  const result = await db.query<ClaimedTaskRow>(
    filtered ? CLAIM_TASK_KIND_SQL : CLAIM_TASK_SQL,
    filtered ? [workerId, leaseMs, maxAttempts, tenantId, [...kinds]] : [workerId, leaseMs, maxAttempts, tenantId],
  );
  return result.rows[0] ?? null;
}

export async function heartbeatTask(db: Queryable, taskId: string, workerId: string, leaseMs: number): Promise<boolean> {
  const result = await db.query<{ id: string }>(HEARTBEAT_TASK_SQL, [taskId, workerId, leaseMs]);
  return result.rows.length === 1;
}

export async function succeedTask(db: Queryable, taskId: string, workerId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(SUCCEED_TASK_SQL, [taskId, workerId]);
  return result.rows.length === 1;
}

export async function releaseTask(
  db: Queryable,
  taskId: string,
  workerId: string,
  maxAttempts: number,
): Promise<boolean> {
  const result = await db.query<{ id: string }>(RELEASE_TASK_SQL, [taskId, workerId, maxAttempts]);
  return result.rows.length === 1;
}

/** Marks the leased task dead and inserts one exception work item. Returns false if the lease or ceiling does not match. */
export async function deadLetterTask(
  db: Queryable,
  taskId: string,
  workerId: string,
  maxAttempts: number,
  reason: string,
): Promise<boolean> {
  const result = await db.query<{ task_id: string }>(DEAD_LETTER_SQL, [taskId, workerId, maxAttempts, reason]);
  return result.rows.length === 1;
}

interface OpenWorkRow {
  id: string;
  status: string;
  lease_owner: string | null;
}

/**
 * One poll step in Postgres. A live lease keeps its not_before.
 * The same open identity returns the same id. Reported rows are not open, so the next enqueue inserts.
 */
export async function enqueueWork(
  db: Queryable,
  kind: string,
  payload: WorkRef,
  notBefore?: number,
): Promise<{ id: string }> {
  const ref = normalizeWork(kind, payload, notBefore);
  requireTenantUuid(ref.tenantId);
  const found = await db.query<OpenWorkRow>(FIND_OPEN_WORK_SQL, [kind, ref.tenantId, ref.operationId ?? '', ref.runId ?? '']);
  const open = found.rows[0];
  if (open) {
    const leased = open.status === 'running' && open.lease_owner !== null;
    if (!leased && notBefore !== undefined) {
      const updated = await db.query<{ id: string }>(UPDATE_NOT_BEFORE_SQL, [open.id, new Date(notBefore).toISOString()]);
      return { id: updated.rows[0]?.id ?? open.id };
    }
    return { id: open.id };
  }
  const inserted = await db.query<{ id: string }>(INSERT_WORK_SQL, [
    ref.tenantId,
    kind,
    JSON.stringify(ref),
    notBefore === undefined ? null : new Date(notBefore).toISOString(),
  ]).catch(async (error: unknown) => {
    if ((error as { code?: string }).code !== '23505') throw error;
    const again = await db.query<{ id: string }>(FIND_OPEN_WORK_SQL, [kind, ref.tenantId, ref.operationId ?? '', ref.runId ?? '']);
    return { rows: again.rows[0] ? [again.rows[0]] : [] };
  });
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error('enqueue_failed');
  return { id };
}
