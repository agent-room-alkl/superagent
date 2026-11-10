-- T-41 SOP runtime. 0006 is left for the command-room context migration.
-- Published versions and claimed events live here so a worker in another process can read them.
-- The dedup key is (tenant_id, source, event_id, sop_id), the same key SopRuntime keeps in memory.

CREATE TABLE IF NOT EXISTS sop_versions (
  id text PRIMARY KEY,
  sop_id text NOT NULL,
  number integer NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL,
  report jsonb,
  revision integer NOT NULL,
  validated_revision integer,
  effective_at text,
  UNIQUE (sop_id, number)
);

CREATE TABLE IF NOT EXISTS sop_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  sop_id text NOT NULL,
  sop_version_id text NOT NULL,
  version_number integer NOT NULL,
  event_key text NOT NULL UNIQUE,
  status text NOT NULL
);

CREATE TABLE IF NOT EXISTS sop_events (
  tenant_id text NOT NULL,
  source text NOT NULL,
  event_id text NOT NULL,
  sop_id text NOT NULL,
  event_key text NOT NULL UNIQUE,
  disposition text NOT NULL,
  PRIMARY KEY (tenant_id, source, event_id, sop_id)
);

CREATE TABLE IF NOT EXISTS sop_runtime_seq (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  seq integer NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON sop_versions, sop_instances, sop_events, sop_runtime_seq TO superagent_app;
