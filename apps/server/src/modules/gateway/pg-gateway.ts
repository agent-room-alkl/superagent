import type { ActionRecord, GatewaySnapshot } from './gateway.js';
import { LOAD_ACTIONS_SQL, UPSERT_ACTION_SQL } from './sql.js';

export interface Queryable {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface ActionRow {
  id: string;
  tenant_id: string;
  instance_id: string;
  step_id: string;
  business_key: string;
  idempotency_key: string;
  effect: ActionRecord['effect'];
  payload: unknown;
  payload_hash: string;
  approval_hash: string | null;
  identity: ActionRecord['identitySnapshot'];
  intended: ActionRecord['intended'];
  status: ActionRecord['status'];
  external_ref: string | null;
  readback: unknown | null;
  calls: number;
  inconsistent: boolean;
  reason: string | null;
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

export async function saveGatewaySnapshot(db: Queryable, snapshot: GatewaySnapshot): Promise<void> {
  for (const action of snapshot.actions) {
    await db.query(UPSERT_ACTION_SQL, [
      action.id,
      action.tenantId,
      action.instanceId,
      action.stepId,
      action.businessKey,
      action.idempotencyKey,
      action.effect,
      JSON.stringify(action.payload),
      action.payloadHash,
      action.approvalHash,
      jsonOrNull(action.identitySnapshot),
      jsonOrNull(action.intended),
      action.status,
      action.externalRef,
      jsonOrNull(action.readback),
      action.calls,
      action.inconsistent,
      action.reason,
    ]);
  }
}

export async function loadGatewaySnapshot(db: Queryable): Promise<GatewaySnapshot> {
  const result = await db.query<ActionRow>(LOAD_ACTIONS_SQL, []);
  return {
    actions: result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      instanceId: row.instance_id,
      stepId: row.step_id,
      businessKey: row.business_key,
      idempotencyKey: row.idempotency_key,
      effect: row.effect,
      payload: row.payload,
      payloadHash: row.payload_hash,
      approvalHash: row.approval_hash,
      identitySnapshot: row.identity,
      intended: row.intended,
      status: row.status,
      externalRef: row.external_ref,
      readback: row.readback,
      calls: Number(row.calls),
      inconsistent: row.inconsistent,
      reason: row.reason,
    })),
  };
}
