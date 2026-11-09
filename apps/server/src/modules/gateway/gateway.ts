import { createHash } from 'node:crypto';
import type { ActionStatus, ToolEffect } from '../../../../../packages/shared/src/index.ts';

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
  authorize: () => boolean;
  /** Synchronous on purpose: the outbox row is committed before this runs. */
  call: () => { externalRef?: string; actual?: Record<string, unknown> } | void;
}

export interface ExecuteResult {
  action: ActionRecord;
  submitted: boolean;
  invoked: boolean;
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

  execute(input: ExecuteInput): ExecuteResult {
    const hash = payloadHash(input.payload);
    const idempotencyKey = [input.tenantId, input.instanceId, input.stepId, input.businessKey].join(':');
    const existing = this.byKey.get(idempotencyKey);
    if (existing && this.mustNotCallAgain(existing)) {
      return { action: this.clone(existing), submitted: existing.status !== 'not_submitted', invoked: false };
    }

    const action = existing ?? this.create(input, idempotencyKey, hash);
    action.payload = input.payload;
    action.payloadHash = hash;
    action.approvalHash = input.approvalHash ?? null;
    action.effect = input.effect;

    if (!input.authorize()) {
      action.status = 'not_submitted';
      action.reason = 'unauthorized';
      return { action: this.clone(action), submitted: false, invoked: false };
    }

    if (WRITE_EFFECTS.has(input.effect) && action.approvalHash !== hash) {
      action.status = 'not_submitted';
      action.reason = 'approval_mismatch';
      return { action: this.clone(action), submitted: false, invoked: false };
    }

    action.status = 'executing';
    action.reason = null;
    this.byKey.set(idempotencyKey, action);

    try {
      const result = this.callExternal(input);
      action.calls += 1;
      action.externalRef = result?.externalRef ?? null;
      if (input.intended) {
        const actual = result?.actual ?? null;
        action.readback = actual;
        if (payloadHash(input.intended) !== payloadHash(actual)) {
          action.status = 'outcome_unknown';
          action.inconsistent = true;
          action.reason = 'readback_mismatch';
          return { action: this.clone(action), submitted: true, invoked: true };
        }
      }
      action.status = 'confirmed';
      action.inconsistent = false;
      return { action: this.clone(action), submitted: true, invoked: true };
    } catch (error) {
      action.calls += 1;
      if (error instanceof OutcomeUnknownError || WRITE_EFFECTS.has(input.effect)) {
        action.status = 'outcome_unknown';
        action.reason = 'timeout';
      } else {
        action.status = 'failed';
        action.reason = error instanceof Error ? error.message : 'failed';
      }
      return { action: this.clone(action), submitted: true, invoked: true };
    }
  }

  getByKey(key: string): ActionRecord | undefined {
    const action = this.byKey.get(key);
    return action ? this.clone(action) : undefined;
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

  private callExternal(input: ExecuteInput): { externalRef?: string; actual?: Record<string, unknown> } | void {
    return input.call();
  }

  private clone(action: ActionRecord): ActionRecord {
    return { ...action };
  }
}
