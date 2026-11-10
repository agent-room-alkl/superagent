-- Work items created for one claimed run. The 0010 inbox snapshot stays for the web process.
-- Inserting a run's item must not replace approvals another process already holds.

CREATE TABLE IF NOT EXISTS work_item (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  execution_id text NOT NULL,
  payload jsonb NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON work_item TO superagent_app;
