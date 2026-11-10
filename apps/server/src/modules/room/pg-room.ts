import type { MessageKind, PromptSnapshot, RoomSnapshot, RoomTask } from './room.js';
import {
  LOAD_MEMBERS_SQL,
  LOAD_MESSAGES_SQL,
  LOAD_TASKS_SQL,
  UPSERT_MEMBER_SQL,
  UPSERT_MESSAGE_SQL,
  UPSERT_TASK_SQL,
} from './sql.js';

export interface Queryable {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface MessageRow {
  id: string;
  seq: number;
  tenant_id: string;
  room_id: string;
  author: string;
  body: string;
  client_message_id: string;
  mentions: unknown;
  task_ids: unknown;
  kind?: string | null;
}

interface TaskRow {
  id: string;
  tenant_id: string;
  room_id: string;
  project_id: string | null;
  message_id: string;
  assignee_user_id: string;
  employee_id: string;
  title: string;
  status: RoomTask['status'];
  waiting_reason: string | null;
  context?: unknown;
}

/** Everything about a task that is not a column of its own (migration 0006). */
interface TaskContext {
  createdByUserId?: string;
  followupTo?: string | null;
  promptSnapshot?: PromptSnapshot | null;
  approval?: RoomTask['approval'];
  reviewedByUserId?: string | null;
}

const KINDS = new Set<MessageKind>(['message', 'reply', 'report', 'review', 'cancel']);

function asContext(value: unknown): TaskContext {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  return parsed && typeof parsed === 'object' ? (parsed as TaskContext) : {};
}

interface MemberRow {
  room_id: string;
  user_id: string;
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return [];
}

/** Writes the in-memory snapshot. Re-saving the same client message id updates the task link and does not insert a second row. */
export async function saveRoomRows(db: Queryable, snapshot: RoomSnapshot): Promise<void> {
  for (const message of snapshot.messages) {
    await db.query(UPSERT_MESSAGE_SQL, [
      message.id,
      message.seq,
      message.tenantId,
      message.roomId,
      message.authorUserId,
      message.body,
      message.clientMessageId,
      JSON.stringify(message.mentions),
      JSON.stringify(message.taskIds),
      message.kind,
    ]);
  }
  for (const task of snapshot.tasks) {
    await db.query(UPSERT_TASK_SQL, [
      task.id,
      task.tenantId,
      task.roomId,
      task.projectId,
      task.messageId,
      task.assigneeUserId,
      task.employeeId,
      task.title,
      task.status,
      task.waitingReason,
      JSON.stringify({
        createdByUserId: task.createdByUserId,
        followupTo: task.followupTo,
        promptSnapshot: task.promptSnapshot,
        approval: task.approval,
        reviewedByUserId: task.reviewedByUserId,
      } satisfies TaskContext),
    ]);
  }
  for (const member of snapshot.members) {
    for (const userId of member.userIds) {
      await db.query(UPSERT_MEMBER_SQL, [member.roomId, userId]);
    }
  }
}

/** Rebuilds a snapshot from room_messages, room_tasks, and room_members. */
export async function loadRoomRows(db: Queryable): Promise<RoomSnapshot> {
  const messages = await db.query<MessageRow>(LOAD_MESSAGES_SQL, []);
  const tasks = await db.query<TaskRow>(LOAD_TASKS_SQL, []);
  const members = await db.query<MemberRow>(LOAD_MEMBERS_SQL, []);
  const byRoom = new Map<string, string[]>();
  for (const member of members.rows) {
    const users = byRoom.get(member.room_id) ?? [];
    users.push(member.user_id);
    byRoom.set(member.room_id, users);
  }
  const seq = messages.rows.reduce((max, row) => Math.max(max, Number(row.seq)), 0);
  return {
    seq,
    messages: messages.rows.map((row) => ({
      id: row.id,
      seq: Number(row.seq),
      roomId: row.room_id,
      tenantId: row.tenant_id,
      authorUserId: row.author,
      body: row.body,
      clientMessageId: row.client_message_id,
      mentions: asStrings(row.mentions),
      taskIds: asStrings(row.task_ids),
      // A row from before migration 0006 has no kind; CommandRoom.restore works it out.
      kind: (KINDS.has(row.kind as MessageKind) ? row.kind : undefined) as MessageKind,
    })),
    tasks: tasks.rows.map((row) => {
      const context = asContext(row.context);
      return {
        id: row.id,
        tenantId: row.tenant_id,
        roomId: row.room_id,
        projectId: row.project_id,
        messageId: row.message_id,
        assigneeUserId: row.assignee_user_id,
        employeeId: row.employee_id,
        title: row.title,
        status: row.status,
        waitingReason: row.waiting_reason,
        createdByUserId: context.createdByUserId ?? '',
        followupTo: context.followupTo ?? null,
        promptSnapshot: context.promptSnapshot ?? null,
        approval: context.approval === 'required' ? 'required' : 'none',
        reviewedByUserId: context.reviewedByUserId ?? null,
      };
    }),
    members: [...byRoom.entries()].map(([roomId, userIds]) => ({ roomId, userIds })),
  };
}
