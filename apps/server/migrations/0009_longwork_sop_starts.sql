-- T-64: receipt, long item and SOP start metadata commit in the same transaction.
-- This is a durable hand-off, not proof that a general SOP graph or an external tool has run.
CREATE TABLE IF NOT EXISTS longwork_sop_starts (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  source_id text NOT NULL,
  event_id text NOT NULL,
  sop_id text NOT NULL,
  item_id text NOT NULL,
  project_id text NOT NULL,
  version_id text,
  instance_id text,
  status text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_id, event_id, sop_id)
);
GRANT SELECT, INSERT, UPDATE ON longwork_sop_starts TO superagent_app;
