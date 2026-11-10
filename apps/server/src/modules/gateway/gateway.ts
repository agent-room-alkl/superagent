import { createHash } from 'node:crypto';
import type { ActionStatus, ToolEffect } from '@superagent/shared';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function payloadHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class OutcomeUnknownError extends Error {
  constructor(message = 'external outcome unknown') {
    super(message);
    this.name = 'OutcomeUnknownError';
  }
}

export interface IdentitySnapshot {
  employeeId: string;
  userId: string;
  toolInstallationId: string;
}

export interface ActionRecord {
  id: string;
  tenantId: string;
  instanceId: string;
  stepId: string;
  businessKey: string;
  idempotencyKey: string;
  effect: ToolEffect;
  payload: unknown;
  payloadHash: string;
  approvalHash: string | null;
  identitySnapshot: IdentitySnapshot | null;
  intended: Record<string, unknown> | null;
  status: ActionStatus;
  externalRef: string | null;
  readback: unknown | null;
  calls: number;
  inconsistent: boolean;
  reason: string | null;
}

export interface ExecuteInput {
  tenantId: string;
  instanceId: string;
  stepId: string;
  businessKey: string;
  effect: ToolEffect;
  payload: unknown;
  /** Values the write claims it will persist. Compared with read-back. */
  intended?: Record<string, unknown>;
  approvalHash?: string | null;
  identity?: IdentitySnapshot;
  authorize: () => boolean;
  /** Synchronous on purpose: the outbox row is committed before this runs. */
  call: () => { externalRef?: string; actual?: Record<string, unknown> } | void;
}

export interface ExecuteResult {
  action: ActionRecord;
  submitted: boolean;
  invoked: boolean;
  /** True when the row is executing and the external call has not run yet. */
  pending: boolean;
}

/** Process restart contract for the outbox. The idempotency key is the stable action identity. */
export interface GatewaySnapshot {
  actions: ActionRecord[];
}

const WRITE_EFFECTS = new Set<ToolEffect>(['write', 'external']);

/**
 * Tool gateway (PRD §5.7): re-authorize, bind the approval to the payload hash,
 * persist the outbox row before the call, and never auto-retry a write whose
 * outcome is unknown.
 */
export class ToolGateway {
  private readonly byKey = new Map<string, ActionRecord>();
  private seq = 0;

  /**
   * Records the decision and, when a call is still allowed, marks the row executing.
   * Does not call the tool. The caller commits this snapshot, then finish().
   */
  reserve(input: ExecuteInput): ExecuteResult {
    const hash = payloadHash(input.payload);
    const idempotencyKey = [input.tenantId, input.instanceId, input.stepId, input.businessKey].join(':');
    const existing = this.byKey.get(idempotencyKey);
    if (existing && this.mustNotCallAgain(existing)) {
      return { action: this.clone(existing), submitted: existing.status !== 'not_submitted', invoked: false, pending: false };
    }

    const action = existing ?? this.create(input, idempotencyKey, hash);
    action.payload = input.payload;
    action.payloadHash = hash;
    action.approvalHash = input.approvalHash ?? null;
    action.identitySnapshot = input.identity ?? action.identitySnapshot;
    action.intended = input.intended ?? action.intended;
    action.effect = input.effect;

    if (!input.authorize()) {
      action.status = 'not_submitted';
      action.reason = 'unauthorized';
      return { action: this.clone(action), submitted: false, invoked: false, pending: false };
    }

    if (WRITE_EFFECTS.has(input.effect) && action.approvalHash !== hash) {
      action.status = 'not_submitted';
      action.reason = 'approval_mismatch';
      return { action: this.clone(action), submitted: false, invoked: false, pending: false };
    }

    action.status = 'executing';
    action.reason = null;
    this.byKey.set(idempotencyKey, action);
    return { action: this.clone(action), submitted: true, invoked: false, pending: true };
  }

  /** Runs the call for a row that reserve() left executing. */
  finish(idempotencyKey: string, call: ExecuteInput['call']): ExecuteResult {
    const action = this.byKey.get(idempotencyKey);
    if (!action || action.status !== 'executing') throw new Error('action_not_armed');
    try {
      const result = call();
      action.calls += 1;
      action.externalRef = result?.externalRef ?? null;
      if (action.intended) {
        const actual = result?.actual ?? null;
        action.readback = actual;
        if (payloadHash(action.intended) !== payloadHash(actual)) {
          action.status = 'outcome_unknown';
          action.inconsistent = true;
          action.reason = 'readback_mismatch';
          return { action: this.clone(action), submitted: true, invoked: true, pending: false };
        }
      }
      action.status = 'confirmed';
      action.inconsistent = false;
      return { action: this.clone(action), submitted: true, invoked: true, pending: false };
    } catch (error) {
      action.calls += 1;
      if (error instanceof OutcomeUnknownError || WRITE_EFFECTS.has(action.effect)) {
        action.status = 'outcome_unknown';
        action.reason = 'timeout';
      } else {
        action.status = 'failed';
        action.reason = error instanceof Error ? error.message : 'failed';
      }
      return { action: this.clone(action), submitted: true, invoked: true, pending: false };
    }
  }

  /** A commit failed before the call. The row may be tried again. */
  abort(idempotencyKey: string): void {
    const action = this.byKey.get(idempotencyKey);
    if (!action || action.status !== 'executing') return;
    action.status = 'not_submitted';
    action.reason = 'not_durable';
  }

  execute(input: ExecuteInput): ExecuteResult {
    const reserved = this.reserve(input);
    if (!reserved.pending) return reserved;
    return this.finish(reserved.action.idempotencyKey, input.call);
  }

  /**
   * After an unknown write, compare a fresh read with the intended values.
   * This never calls the tool again.
   */
  readBack(idempotencyKey: string, actual: Record<string, unknown> | null): ExecuteResult {
    const action = this.byKey.get(idempotencyKey);
    if (!action) throw new Error('action_not_found');
    if (action.status !== 'outcome_unknown') {
      return { action: this.clone(action), submitted: action.status !== 'not_submitted', invoked: false, pending: false };
    }
    const calls = action.calls;
    action.readback = actual;
    if (action.intended && payloadHash(action.intended) === payloadHash(actual)) {
      action.status = 'confirmed';
      action.inconsistent = false;
      action.reason = null;
    } else {
      action.inconsistent = true;
      action.reason = 'readback_mismatch';
    }
    action.calls = calls;
    return { action: this.clone(action), submitted: true, invoked: false, pending: false };
  }

  getByKey(key: string): ActionRecord | undefined {
    const action = this.byKey.get(key);
    return action ? this.clone(action) : undefined;
  }

  snapshot(): GatewaySnapshot {
    return { actions: [...this.byKey.values()].map((action) => structuredClone(action)) };
  }

  /** Replaces this gateway's rows. Call it on the instance the executor already holds. */
  load(saved: GatewaySnapshot): void {
    this.byKey.clear();
    let seq = 0;
    for (const action of saved.actions) {
      const copy = structuredClone(action);
      // A row left executing did not finish its flush after the call. A write must not be sent again.
      if (copy.status === 'executing') {
        if (WRITE_EFFECTS.has(copy.effect)) {
          copy.status = 'outcome_unknown';
          copy.reason = copy.reason ?? 'interrupted';
        } else {
          copy.status = 'not_submitted';
          copy.reason = null;
        }
      }
      this.byKey.set(copy.idempotencyKey, copy);
      const match = /^act_(\d+)$/.exec(copy.id);
      const n = match ? Number(match[1]) : 0;
      if (n > seq) seq = n;
    }
    this.seq = seq;
  }

  private mustNotCallAgain(action: ActionRecord): boolean {
    if (WRITE_EFFECTS.has(action.effect)) return action.status !== 'not_submitted';
    return action.status === 'confirmed' || action.status === 'executing' || action.status === 'outcome_unknown';
  }

  private create(input: ExecuteInput, idempotencyKey: string, hash: string): ActionRecord {
    const action: ActionRecord = {
      id: `act_${++this.seq}`,
      tenantId: input.tenantId,
      instanceId: input.instanceId,
      stepId: input.stepId,
      businessKey: input.businessKey,
      idempotencyKey,
      effect: input.effect,
      payload: input.payload,
      payloadHash: hash,
      approvalHash: input.approvalHash ?? null,
      identitySnapshot: input.identity ?? null,
      intended: input.intended ?? null,
      status: 'not_submitted',
      externalRef: null,
      readback: null,
      calls: 0,
      inconsistent: false,
      reason: null,
    };
    this.byKey.set(idempotencyKey, action);
    return action;
  }

  private clone(action: ActionRecord): ActionRecord {
    return { ...action };
  }
}
