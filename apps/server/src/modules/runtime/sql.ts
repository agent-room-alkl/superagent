/**
 * Postgres claim / heartbeat statements for PRD §5.7.
 * A row with not_before in the future stays invisible. That wait is not a failed attempt.
 */

export const CLAIM_TASK_SQL = `
UPDATE tasks AS t
SET lease_owner = $1,
    lease_until = now() + ($2::int * interval '1 millisecond'),
    attempt = t.attempt + 1,
    status = 'running',
    identity_snapshot = jsonb_build_object('workerId', $1::text, 'claimedAt', now(), 'attempt', t.attempt + 1)
WHERE t.id = (
  SELECT id
  FROM tasks
  WHERE dead_letter = false
    AND status IN ('assigned', 'running')
    AND attempt < $3
    AND (lease_until IS NULL OR lease_until <= now())
    AND (not_before IS NULL OR not_before <= now())
    AND tenant_id = $4::uuid
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
`.trim();

/** Same claim, limited to kinds the caller named. A room row (kind null) is not taken. */
export const CLAIM_TASK_KIND_SQL = CLAIM_TASK_SQL.replace(
  '  ORDER BY created_at',
  '    AND kind = ANY($5::text[])\n  ORDER BY created_at',
);

export const HEARTBEAT_TASK_SQL = `
UPDATE tasks
SET lease_until = now() + ($3::int * interval '1 millisecond')
WHERE id = $1
  AND lease_owner = $2
  AND dead_letter = false
  AND lease_until > now()
RETURNING id;
`.trim();

/** Give the row back to the queue. Only the current lease holder may do this, and only before the attempt ceiling. */
export const RELEASE_TASK_SQL = `
UPDATE tasks
SET status = 'assigned',
    lease_owner = NULL,
    lease_until = NULL
WHERE id = $1
  AND lease_owner = $2
  AND dead_letter = false
  AND lease_until > now()
  AND attempt < $3
RETURNING id;
`.trim();

/** Close a leased task. Only the current holder may report it, and only while the lease is live. */
export const SUCCEED_TASK_SQL = `
UPDATE tasks
SET status = 'reported',
    lease_owner = NULL,
    lease_until = NULL
WHERE id = $1
  AND lease_owner = $2
  AND dead_letter = false
  AND lease_until > now()
RETURNING id;
`.trim();

/** Same open poll identity as the memory queue: kind + tenant + operationId + runId. */
export const FIND_OPEN_WORK_SQL = `
SELECT id, status, lease_owner
FROM tasks
WHERE kind = $1
  AND tenant_id = $2::uuid
  AND coalesce(payload->>'operationId', '') = $3
  AND coalesce(payload->>'runId', '') = $4
  AND dead_letter = false
  AND status IN ('assigned', 'running')
ORDER BY created_at
LIMIT 1;
`.trim();

/** Move a waiting poll earlier or later. A live lease is not in this statement. */
export const UPDATE_NOT_BEFORE_SQL = `
UPDATE tasks
SET not_before = $2::timestamptz
WHERE id = $1::uuid
  AND lease_owner IS NULL
  AND dead_letter = false
  AND status IN ('assigned', 'running')
RETURNING id;
`.trim();

/** Ids only. The payload is the work ref, never a document body. */
export const INSERT_WORK_SQL = `
INSERT INTO tasks (id, tenant_id, status, attempt, dead_letter, kind, payload, not_before)
VALUES (gen_random_uuid(), $1::uuid, 'assigned', 0, false, $2, $3::jsonb, $4::timestamptz)
RETURNING id;
`.trim();

/** Two poll enqueues of the same open identity cannot both insert. */
export const OPEN_WORK_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS tasks_open_work
ON tasks (
  kind,
  tenant_id,
  (coalesce(payload->>'operationId', '')),
  (coalesce(payload->>'runId', ''))
)
WHERE dead_letter = false AND status IN ('assigned', 'running');
`.trim();

/**
 * Past the attempt ceiling: one statement marks the task dead and opens an
 * exception work item. A second call matches no row, so it cannot open another.
 */
export const DEAD_LETTER_SQL = `
WITH updated AS (
  UPDATE tasks
  SET dead_letter = true,
      status = 'waiting',
      lease_owner = NULL,
      lease_until = NULL
  WHERE id = $1
    AND lease_owner = $2
    AND dead_letter = false
    AND lease_until > now()
    AND attempt >= $3
  RETURNING id, tenant_id, identity_snapshot
)
INSERT INTO human_work_items (id, tenant_id, kind, renderer, task_id, target, payload_version, status)
SELECT gen_random_uuid(), tenant_id, 'exception_ruling', 'issue_list', id,
       jsonb_build_object('reason', $4::text, 'source', 'dead_letter', 'identity', identity_snapshot), 1, 'open'
FROM updated
RETURNING task_id;
`.trim();
