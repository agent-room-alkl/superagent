/** Command-room rows (PRD §3.7 / §5.5). Text ids match the room module; the unique key is the dedup. */

export const UPSERT_MESSAGE_SQL = `
INSERT INTO room_messages (
  id, seq, tenant_id, room_id, author, body, client_message_id, mentions, task_ids, kind
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
ON CONFLICT (room_id, client_message_id) DO UPDATE
  SET task_ids = EXCLUDED.task_ids
`.trim();

export const UPSERT_TASK_SQL = `
INSERT INTO room_tasks (
  id, tenant_id, room_id, project_id, message_id, assignee_user_id, employee_id, title, status, waiting_reason, context
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      waiting_reason = EXCLUDED.waiting_reason,
      context = EXCLUDED.context
`.trim();

export const UPSERT_MEMBER_SQL = `
INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)
ON CONFLICT (room_id, user_id) DO NOTHING
`.trim();

export const LOAD_MESSAGES_SQL = `
SELECT id, seq, tenant_id, room_id, author, body, client_message_id, mentions, task_ids, kind
FROM room_messages
ORDER BY seq
`.trim();

export const LOAD_TASKS_SQL = `
SELECT id, tenant_id, room_id, project_id, message_id, assignee_user_id, employee_id, title, status, waiting_reason, context
FROM room_tasks
`.trim();

export const LOAD_MEMBERS_SQL = `
SELECT room_id, user_id FROM room_members ORDER BY room_id, user_id
`.trim();
