import fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { loadRoomRows, saveRoomRows, type Queryable } from './pg-room.js';
import { CommandRoom, type EmployeeRef, type RoomSnapshot, type Viewer } from './room.js';

const EMPLOYEES: EmployeeRef[] = [
  { id: 'emp-sales', name: '销售员工', ownerUserId: 'user-sales', status: 'active' },
  { id: 'emp-ops', name: '运营员工', ownerUserId: 'user-ops', status: 'offline' },
];

const ROLES = new Set<Viewer['roles'][number]>(['admin', 'owner', 'employee', 'reviewer']);

export function createCommandRoom(): CommandRoom {
  const room = new CommandRoom(EMPLOYEES);
  for (const userId of ['user-owner', 'user-sales', 'user-ops']) room.addMember('room-1', userId);
  return room;
}

/** Process-local room. Postgres rows are the restart contract; the JSON file remains a fallback. */
export const roomState = { current: createCommandRoom() };

let roomStore: Queryable | null = null;

export function bindRoomStore(db: Queryable | null): void {
  roomStore = db;
}

export function reloadRoom(saved: RoomSnapshot): void {
  roomState.current = CommandRoom.restore(EMPLOYEES, saved);
}

/** Gap-fill cursor. Missing means the start of the room. A bad value must not look like an empty catch-up. */
export function messageCursor(value: string | undefined): number | null {
  if (value === undefined || value === '') return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function flushRoom(): Promise<void> {
  if (roomStore) await saveRoomRows(roomStore, roomState.current.snapshot());
}

/** Replaces the process-local room when the database already has messages or tasks. */
export async function hydrateRoom(): Promise<void> {
  if (!roomStore) return;
  const saved = await loadRoomRows(roomStore);
  if (saved.messages.length === 0 && saved.tasks.length === 0) return;
  reloadRoom(saved);
}

export function saveRoom(file: string): void {
  fs.writeFileSync(file, JSON.stringify(roomState.current.snapshot()));
}

export function loadRoom(file: string): void {
  reloadRoom(JSON.parse(fs.readFileSync(file, 'utf8')) as RoomSnapshot);
}

function header(headers: Record<string, unknown>, name: string): string {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return '';
}

/**
 * Who is acting. Under /api/v1 the auth hook has verified the user (Entra or dev identity) and that identity is
 * always used; client-supplied x-user-id / x-roles headers are ignored. The header form exists only for unit tests
 * that mount this plugin without the auth hook, and is refused in production.
 */
export function viewerFrom(headers: Record<string, unknown>, user?: { userId: string; roles: readonly string[]; projectScopes: readonly string[] }): Viewer {
  if (user) {
    const roles = user.roles.filter((r): r is Viewer['roles'][number] => ROLES.has(r as Viewer['roles'][number]));
    return { userId: user.userId, roles, projectScopes: [...user.projectScopes] };
  }
  if (process.env.NODE_ENV === 'production') throw new Error('unauthenticated');
  const roles = header(headers, 'x-roles')
    .split(',')
    .map((role) => role.trim())
    .filter((role): role is Viewer['roles'][number] => ROLES.has(role as Viewer['roles'][number]));
  return {
    userId: header(headers, 'x-user-id') || 'user-owner',
    roles: roles.length > 0 ? roles : ['owner'],
    projectScopes: header(headers, 'x-projects').split(',').map((scope) => scope.trim()).filter(Boolean),
  };
}

interface MessageBody {
  roomId?: string;
  tenantId?: string;
  projectId?: string | null;
  body?: string;
  clientMessageId?: string;
}

/** Command room HTTP surface (PRD §5.6). Auth headers stand in until Entra (T-39) is mounted. */
export const roomModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({ module: 'room', implemented: true }));

  app.post('/messages', async (req, reply) => {
    const body = (req.body ?? {}) as MessageBody;
    if (!body.roomId || !body.body || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    const viewer = viewerFrom(req.headers, req.user);
    const posted = roomState.current.post({
      roomId: body.roomId,
      tenantId: body.tenantId ?? 't',
      projectId: body.projectId ?? null,
      authorUserId: viewer.userId,
      authorRoles: viewer.roles,
      authorProjectScopes: viewer.projectScopes,
      modelAvailable: header(req.headers, 'x-model-available') === 'false' ? false : undefined,
      body: body.body,
      clientMessageId: body.clientMessageId,
    });
    await flushRoom();
    return posted;
  });

  app.get('/messages', async (req, reply) => {
    const query = req.query as { roomId?: string; after?: string };
    const after = messageCursor(query.after);
    if (after === null) return reply.code(400).send({ error: 'bad_cursor' });
    return { messages: roomState.current.eventsAfter(query.roomId ?? 'room-1', after, viewerFrom(req.headers, req.user)) };
  });

  app.get('/stream', async (req, reply) => {
    const query = req.query as { roomId?: string; after?: string };
    const after = messageCursor(query.after);
    if (after === null) return reply.code(400).send({ error: 'bad_cursor' });
    const messages = roomState.current.eventsAfter(query.roomId ?? 'room-1', after, viewerFrom(req.headers, req.user));
    const payload = messages.map((message) => `id: ${message.seq}\ndata: ${JSON.stringify(message)}\n\n`).join('');
    return reply.type('text/event-stream').send(payload);
  });

  app.get('/tasks', async (req) => ({ tasks: roomState.current.listTasks(viewerFrom(req.headers, req.user)) }));

  app.post('/tasks/:id/report', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { body?: string; clientMessageId?: string };
    if (!body.body || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const message = roomState.current.report(params.id, viewerFrom(req.headers, req.user).userId, body.body, body.clientMessageId);
      await flushRoom();
      return message;
    } catch (error) {
      const code = error instanceof Error && error.message === 'task_not_found' ? 404 : 403;
      return reply.code(code).send({ error: error instanceof Error ? error.message : 'forbidden' });
    }
  });
};
