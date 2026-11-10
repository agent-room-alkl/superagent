export const UPSERT_ACTION_SQL = `
INSERT INTO gateway_actions (
  id, tenant_id, instance_id, step_id, business_key, idempotency_key, effect, payload, payload_hash,
  approval_hash, identity, intended, status, external_ref, readback, calls, inconsistent, reason
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
  $10, $11::jsonb, $12::jsonb, $13, $14, $15::jsonb, $16, $17, $18
)
ON CONFLICT (idempotency_key) DO UPDATE SET
  status = EXCLUDED.status,
  external_ref = EXCLUDED.external_ref,
  readback = EXCLUDED.readback,
  calls = EXCLUDED.calls,
  inconsistent = EXCLUDED.inconsistent,
  reason = EXCLUDED.reason,
  approval_hash = EXCLUDED.approval_hash,
  identity = EXCLUDED.identity,
  intended = EXCLUDED.intended,
  payload = EXCLUDED.payload,
  payload_hash = EXCLUDED.payload_hash
`.trim();

export const LOAD_ACTIONS_SQL = `
SELECT id, tenant_id, instance_id, step_id, business_key, idempotency_key, effect, payload, payload_hash,
  approval_hash, identity, intended, status, external_ref, readback, calls, inconsistent, reason
FROM gateway_actions
`.trim();
