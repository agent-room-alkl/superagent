import type { TaskStatus } from '@superagent/shared';

export interface QueueTask {
  id: string;
  tenantId: string;
  instanceId: string | null;
  roomMessageId: string | null;
  employeeId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  status: TaskStatus;
  waitingReason: string | null;
  leaseOwner: string | null;
  leaseUntil: number | null;
  attempt: number;
  maxAttempts: number;
  deadLetter: boolean;
  identitySnapshot: Record<string, unknown> | null;
  kind: string | null;
  payload: WorkRef | null;
  /** Epoch ms. claim skips this row until now >= notBefore. A poll wait is not a failure. */
  notBefore: number | null;
  createdAt: number;
}

/** Ids only. Handlers load the body; the queue never stores document text or credentials. */
export interface WorkRef {
  tenantId: string;
  connectionId?: string;
  itemId?: string;
  runId?: string;
  operationId?: string;
}

export const WORK_KINDS = ['knowledge.parse', 'knowledge.sync', 'analysis.run'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shared check for the memory queue and the Postgres insert. Extra keys never reach storage. */
export function normalizeWork(kind: string, payload: WorkRef, notBefore?: number): WorkRef {
  if (!WORK_KINDS.includes(kind as (typeof WORK_KINDS)[number])) throw new Error('bad_work');
  const extra = Object.keys(payload).filter((key) => !WORK_REF_KEYS.has(key));
  if (extra.length > 0) throw new Error('payload_not_a_ref');
  if (!payload.tenantId) throw new Error('missing_tenant');
  if (notBefore !== undefined && (!Number.isFinite(notBefore) || notBefore < 0)) throw new Error('not_before_invalid');
  const ref: WorkRef = { tenantId: payload.tenantId };
  if (payload.connectionId) ref.connectionId = payload.connectionId;
  if (payload.itemId) ref.itemId = payload.itemId;
  if (payload.runId) ref.runId = payload.runId;
  if (payload.operationId) ref.operationId = payload.operationId;
  return ref;
}

export function requireTenantUuid(tenantId: string): string {
  if (!UUID_RE.test(tenantId)) throw new Error('tenant_not_uuid');
  return tenantId;
}

const WORK_REF_KEYS = new Set(['tenantId', 'connectionId', 'itemId', 'runId', 'operationId']);

export interface NewTask {
  id?: string;
  tenantId: string;
  instanceId?: string | null;
  roomMessageId?: string | null;
  employeeId?: string | null;
  assigneeUserId?: string | null;
  projectId?: string | null;
  maxAttempts?: number;
  kind?: string | null;
  payload?: WorkRef | null;
  notBefore?: number | null;
  status?: TaskStatus;
  waitingReason?: string | null;
  createdAt?: number;
}

/**
 * In-process queue with the same claim rules as CLAIM_TASK_SQL:
 * one worker, SKIP LOCKED style (a claimed row is invisible until the lease expires),
 * attempt ceiling, then dead-letter plus a human work item.
 */
export class TaskQueue {
  private readonly tasks = new Map<string, QueueTask>();
  private seq = 0;
  private readonly leaseMs: number;
  private readonly onDeadLetter: ((task: QueueTask) => void) | undefined;
  private readonly handlers = new Map<string, (task: QueueTask) => void>();

  constructor(leaseMs: number, onDeadLetter?: (task: QueueTask) => void) {
    this.leaseMs = leaseMs;
    this.onDeadLetter = onDeadLetter;
  }

  /** Worker-side handler. enqueue does not call it; claim does not call it. */
  register(kind: string, handler: (task: QueueTask) => void): void {
    this.handlers.set(kind, handler);
  }

  handler(kind: string): ((task: QueueTask) => void) | undefined {
    return this.handlers.get(kind);
  }

  /**
   * One poll step. Pass notBefore so the next claim waits without fail().
   * The same kind + tenant + operationId + runId, while still open, updates
   * notBefore and returns the same id. A live lease is left to its owner.
   */
  enqueue(kind: (typeof WORK_KINDS)[number], payload: WorkRef, notBefore?: number): QueueTask {
    const ref = normalizeWork(kind, payload, notBefore);
    const open = this.openMatch(kind, ref);
    if (open) {
      const leased = open.leaseUntil !== null && open.leaseOwner !== null && open.status === 'running';
      if (!leased && notBefore !== undefined) open.notBefore = notBefore;
      return this.clone(open);
    }
    return this.add({ tenantId: payload.tenantId, kind, payload: ref, notBefore: notBefore ?? null });
  }

  add(input: NewTask): QueueTask {
    const task: QueueTask = {
      id: input.id ?? `task_${++this.seq}`,
      tenantId: input.tenantId,
      instanceId: input.instanceId ?? null,
      roomMessageId: input.roomMessageId ?? null,
      employeeId: input.employeeId ?? null,
      assigneeUserId: input.assigneeUserId ?? null,
      projectId: input.projectId ?? null,
      status: input.status ?? 'assigned',
      waitingReason: input.waitingReason ?? null,
      leaseOwner: null,
      leaseUntil: null,
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      deadLetter: false,
      identitySnapshot: null,
      kind: input.kind ?? null,
      payload: input.payload ? { ...input.payload } : null,
      notBefore: input.notBefore ?? null,
      createdAt: input.createdAt ?? this.seq,
    };
    this.tasks.set(task.id, task);
    return this.clone(task);
  }

  claim(workerId: string, now: number, kinds?: readonly string[]): QueueTask | null {
    const allowed = kinds ? new Set(kinds) : null;
    const eligible = [...this.tasks.values()]
      .filter((task) => this.claimable(task, now) && (allowed === null || (task.kind !== null && allowed.has(task.kind))))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const task = eligible[0];
    if (!task) return null;
    task.attempt += 1;
    task.leaseOwner = workerId;
    task.leaseUntil = now + this.leaseMs;
    task.status = 'running';
    task.identitySnapshot = { workerId, claimedAt: now, attempt: task.attempt };
    return this.clone(task);
  }

  heartbeat(taskId: string, workerId: string, now: number): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.deadLetter || task.leaseOwner !== workerId) return false;
    if (task.leaseUntil === null || task.leaseUntil <= now) return false;
    task.leaseUntil = now + this.leaseMs;
    return true;
  }

  succeed(taskId: string, workerId: string, now: number): QueueTask {
    const task = this.requireOwner(taskId, workerId, now);
    task.status = 'reported';
    task.leaseOwner = null;
    task.leaseUntil = null;
    task.waitingReason = null;
    return this.clone(task);
  }

  fail(taskId: string, workerId: string, now: number, reason: string): { task: QueueTask; deadLettered: boolean } {
    const task = this.requireOwner(taskId, workerId, now);
    task.leaseOwner = null;
    task.leaseUntil = null;
    if (task.attempt >= task.maxAttempts) {
      task.deadLetter = true;
      task.status = 'waiting';
      task.waitingReason = `dead_letter:${reason}`;
      const snapshot = this.clone(task);
      this.onDeadLetter?.(snapshot);
      return { task: snapshot, deadLettered: true };
    }
    task.status = 'assigned';
    task.waitingReason = reason;
    return { task: this.clone(task), deadLettered: false };
  }

  get(id: string): QueueTask | undefined {
    const task = this.tasks.get(id);
    return task ? this.clone(task) : undefined;
  }

  private claimable(task: QueueTask, now: number): boolean {
    if (task.deadLetter || task.attempt >= task.maxAttempts) return false;
    if (task.notBefore !== null && task.notBefore > now) return false;
    if (task.status !== 'assigned' && task.status !== 'running') return false;
    return task.leaseUntil === null || task.leaseUntil <= now;
  }

  /** Open row for this poll identity. Reported and dead-letter rows do not match. */
  private openMatch(kind: string, ref: WorkRef): QueueTask | undefined {
    const key = this.refKey(kind, ref);
    return [...this.tasks.values()].find((task) => {
      if (task.deadLetter || !task.payload || !task.kind) return false;
      if (task.status !== 'assigned' && task.status !== 'running') return false;
      return this.refKey(task.kind, task.payload) === key;
    });
  }

  private refKey(kind: string, ref: WorkRef): string {
    return [kind, ref.tenantId, ref.operationId ?? '', ref.runId ?? ''].join('\0');
  }

  private requireOwner(taskId: string, workerId: string, now: number): QueueTask {
    const task = this.tasks.get(taskId);
    if (!task || task.leaseOwner !== workerId) throw new Error('lease_lost');
    if (task.leaseUntil === null || task.leaseUntil <= now) throw new Error('lease_expired');
    return task;
  }

  private clone(task: QueueTask): QueueTask {
    return {
      ...task,
      identitySnapshot: task.identitySnapshot ? { ...task.identitySnapshot } : null,
      payload: task.payload ? { ...task.payload } : null,
    };
  }
}
