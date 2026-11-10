-- T-45: a tenant-serialized aggregate. All receipts, matching decisions and action intents
-- commit atomically. External I/O is always outside the row lock. No credentials are stored.
CREATE TABLE IF NOT EXISTS longwork_state (
  tenant_id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON longwork_state TO superagent_app;
