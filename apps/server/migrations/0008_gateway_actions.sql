-- T-41 tool gateway outbox. 0006 stays free for the command-room context migration.
-- One row per idempotency key. An unknown write is recovered by read-back, not by calling again.

CREATE TABLE IF NOT EXISTS gateway_actions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  instance_id text NOT NULL,
  step_id text NOT NULL,
  business_key text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  effect text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  approval_hash text,
  identity jsonb,
  intended jsonb,
  status text NOT NULL,
  external_ref text,
  readback jsonb,
  calls integer NOT NULL,
  inconsistent boolean NOT NULL,
  reason text
);

GRANT SELECT, INSERT, UPDATE, DELETE ON gateway_actions TO superagent_app;
