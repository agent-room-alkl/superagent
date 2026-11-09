-- T-41 runtime: typed queue rows (kind / payload / not_before), one open row per (kind, tenant, operation, run),
-- and the command-room tables the room module persists to.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS payload jsonb;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS not_before timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_open_work ON tasks (
  kind, tenant_id, (coalesce(payload->>'operationId', '')), (coalesce(payload->>'runId', ''))
) WHERE dead_letter = false AND status IN ('assigned', 'running');

CREATE TABLE IF NOT EXISTS room_messages (
  id text PRIMARY KEY,
  seq integer NOT NULL,
  tenant_id text NOT NULL,
  room_id text NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  client_message_id text NOT NULL,
  mentions jsonb NOT NULL,
  task_ids jsonb NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS room_messages_dedup ON room_messages (room_id, client_message_id);

CREATE TABLE IF NOT EXISTS room_tasks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  room_id text NOT NULL,
  project_id text,
  message_id text NOT NULL,
  assignee_user_id text NOT NULL,
  employee_id text NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  waiting_reason text
);

CREATE TABLE IF NOT EXISTS room_members (
  room_id text NOT NULL,
  user_id text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS room_members_pk ON room_members (room_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON room_messages, room_tasks, room_members TO superagent_app;
