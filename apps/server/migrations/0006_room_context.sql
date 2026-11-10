-- Command room (T-58): a message says what it is (someone speaking, the super agent replying, or a report /
-- review / cancel on a task), and a task keeps who asked for it, what it continues, the employee's prompt
-- snapshot, whether it needs an action approval, and who accepted the result.
-- Rows written before this migration keep kind NULL; the room works the kind out when it loads them.

ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS kind text;
ALTER TABLE room_tasks ADD COLUMN IF NOT EXISTS context jsonb NOT NULL DEFAULT '{}'::jsonb;
