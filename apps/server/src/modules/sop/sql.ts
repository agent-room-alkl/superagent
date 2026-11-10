/** Durable SOP rows. event_key is tenant|source|eventId|sopId and matches sopEventKey. */

export const UPSERT_VERSION_SQL = `
INSERT INTO sop_versions (
  id, sop_id, number, definition, status, report, revision, validated_revision, effective_at
) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, $7, $8, $9)
ON CONFLICT (id) DO UPDATE SET
  definition = EXCLUDED.definition,
  status = EXCLUDED.status,
  report = EXCLUDED.report,
  revision = EXCLUDED.revision,
  validated_revision = EXCLUDED.validated_revision,
  effective_at = EXCLUDED.effective_at
`.trim();

export const UPSERT_INSTANCE_SQL = `
INSERT INTO sop_instances (
  id, tenant_id, sop_id, sop_version_id, version_number, event_key, status
) VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status
`.trim();

export const UPSERT_EVENT_SQL = `
INSERT INTO sop_events (tenant_id, source, event_id, sop_id, event_key, disposition)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (tenant_id, source, event_id, sop_id) DO UPDATE SET disposition = EXCLUDED.disposition
`.trim();

export const UPSERT_SEQ_SQL = `
INSERT INTO sop_runtime_seq (id, seq) VALUES (true, $1)
ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq
`.trim();

export const LOAD_VERSIONS_SQL = `
SELECT id, sop_id, number, definition, status, report, revision, validated_revision, effective_at
FROM sop_versions
ORDER BY number
`.trim();

export const LOAD_INSTANCES_SQL = `
SELECT id, tenant_id, sop_id, sop_version_id, version_number, event_key, status
FROM sop_instances
`.trim();

export const LOAD_EVENTS_SQL = `
SELECT event_key, disposition FROM sop_events
`.trim();

export const LOAD_SEQ_SQL = `SELECT seq FROM sop_runtime_seq WHERE id = true`.trim();

/** Inserts the dedup row. A conflict means another process already claimed this event. */
export const CLAIM_EVENT_SQL = `
INSERT INTO sop_events (tenant_id, source, event_id, sop_id, event_key, disposition)
VALUES ($1, $2, $3, $4, $5, 'open')
ON CONFLICT (tenant_id, source, event_id, sop_id) DO NOTHING
RETURNING event_key
`.trim();

export const LOAD_PUBLISHED_SQL = `
SELECT id, sop_id, number, definition, status, report, revision, validated_revision, effective_at
FROM sop_versions
WHERE sop_id = $1 AND status = 'published'
ORDER BY number DESC
LIMIT 1
`.trim();
