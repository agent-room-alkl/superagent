-- One row per claimed SOP run. The 0010 snapshot stays for the manual-start path.
-- A process that flushes its own snapshot must not delete a run another process inserted.

CREATE TABLE IF NOT EXISTS execution_run (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  instance_id text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (tenant_id, instance_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON execution_run TO superagent_app;
