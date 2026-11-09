-- T-40 module migration. Run with the migration role; runtime has no DDL privileges.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS knowledge_tenants (
  tenant_id text PRIMARY KEY,
  doc jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  chunk_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES knowledge_tenants(tenant_id),
  source_id text NOT NULL,
  source_version text NOT NULL,
  start_offset integer NOT NULL CHECK(start_offset>=0),
  end_offset integer NOT NULL CHECK(end_offset>start_offset),
  content text NOT NULL,
  locator text NOT NULL,
  title text NOT NULL,
  principals text[] NOT NULL,
  project_ids text[] NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',content)) STORED
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_fts ON knowledge_chunks USING gin(search_vector);
CREATE INDEX IF NOT EXISTS knowledge_chunks_trgm ON knowledge_chunks USING gin(content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS knowledge_chunks_access ON knowledge_chunks(tenant_id);
GRANT SELECT,INSERT,UPDATE,DELETE ON knowledge_tenants,knowledge_chunks TO superagent_app;
GRANT USAGE ON SEQUENCE knowledge_chunks_chunk_id_seq TO superagent_app;
