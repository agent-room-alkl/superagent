-- Application role: least privilege. Audit log is append-only (PRD §3.9).
-- Run by the migration Job as the schema owner; the app connects as superagent_app.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'superagent_app') THEN
    CREATE ROLE superagent_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO superagent_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO superagent_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM superagent_app;
GRANT SELECT, INSERT ON audit_log TO superagent_app;

-- Keyword retrieval (PRD §3.1 MVP retrieval) and optional vectors.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
