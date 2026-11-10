import fs from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import { loadRoomRows, saveRoomRows, type Queryable } from './pg-room.js';
import { employeesState } from '../employees/index.js';
import { CommandRoom, type EmployeeRef, type EmployeeSource, type RoomSnapshot, type Viewer } from './room.js';

const ROLES = new Set<Viewer['roles'][number]>(['admin', 'owner', 'employee', 'reviewer']);

/**
 * The room names the digital employees that exist in the employee module, as they are now: the person answering
 * for each one, whether it can take work, and the prompt version it would run with. Nothing here is a sample.
 */
export function registryEmployees(): EmployeeRef[] {
  const registry = employeesState.current;
  return registry.list().map((employee) => ({
    id: employee.id,
    name: employee.name,
    ownerUserId: employee.owner,
    duty: employee.duty,
    status: employee.status === 'online' || employee.status === 'busy'
      ? 'active'
      : employee.status === 'paused'
        ? 'paused'
        : employee.status === 'unconnected' ? 'unconnected' : 'offline',
    promptVersion: registry.currentPrompt(employee.id).version,
    modelTier: employee.modelTier,
  }));
}

let employeeSource: EmployeeSource = registryEmployees;

/** A fresh room. Tests pass a fixed list; the running app reads the employee module. */
export function createCommandRoom(employees: EmployeeSource = registryEmployees): CommandRoom {
  employeeSource = employees;
  return new CommandRoom(employees);
}

/** Process-local room. Postgres rows are the restart contract; the JSON file remains a fallback. */
export const roomState = { current: createCommandRoom() };

let roomStore: Queryable | null = null;

export function bindRoomStore(db: Queryable | null): void {
  roomStore = db;
}

export function reloadRoom(saved: RoomSnapshot): void {
  roomState.current = CommandRoom.restore(employeeSource, saved);
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
  followupTo?: string | null;
}

const STATUS: Record<string, number> = {
  task_not_found: 404,
  forbidden: 403,
  not_assignee: 403,
  task_closed: 409,
  not_reported: 409,
  evidence_failed: 409,
  empty_supplement: 400,
  not_held: 409,
};

function refusal(error: unknown): { code: number; body: { error: string } } {
  const name = error instanceof Error ? error.message : 'forbidden';
  return { code: STATUS[name] ?? 403, body: { error: STATUS[name] ? name : 'forbidden' } };
}

/** Command room HTTP surface (PRD §5.6). Under /api/v1 the caller is always the signed-in user. */
export const roomModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({ module: 'room', implemented: true }));

  app.post('/messages', async (req, reply) => {
    const body = (req.body ?? {}) as MessageBody;
    if (!body.roomId || !body.body || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    const viewer = viewerFrom(req.headers, req.user);
    const posted = roomState.current.post({
      roomId: body.roomId,
      // The signed-in user's tenant wins; the body value is only read where no auth hook is mounted (unit tests).
      tenantId: req.user?.tenantId ?? body.tenantId ?? 't',
      projectId: body.projectId ?? null,
      authorUserId: viewer.userId,
      authorRoles: viewer.roles,
      authorProjectScopes: viewer.projectScopes,
      modelAvailable: header(req.headers, 'x-model-available') === 'false' ? false : undefined,
      body: body.body,
      clientMessageId: body.clientMessageId,
      followupTo: typeof body.followupTo === 'string' && body.followupTo ? body.followupTo : null,
    });
    await flushRoom();
    return posted;
  });

  /** Who is looking, and which digital employees they may name. Read from the employee module on every call. */
  app.get('/roster', async (req) => {
    const viewer = viewerFrom(req.headers, req.user);
    return {
      viewer: { userId: viewer.userId, roles: viewer.roles, owner: viewer.roles.includes('owner') || viewer.roles.includes('admin') },
      employees: roomState.current.roster(viewer).map((employee) => ({
        id: employee.id,
        name: employee.name,
        duty: employee.duty ?? '',
        status: employee.status,
        ownerUserId: employee.ownerUserId,
      })),
    };
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

  app.get('/tasks', async (req) => {
    const query = req.query as { roomId?: string };
    return { tasks: roomState.current.listTasks(viewerFrom(req.headers, req.user), query.roomId || undefined) };
  });

  app.get('/summary', async (req) => {
    const view = roomState.current.summary(viewerFrom(req.headers, req.user));
    return {
      label: view.label,
      tasks: view.tasks.map((task) => ({ id: task.id, title: task.title, messageId: task.messageId, employeeId: task.employeeId })),
    };
  });

  app.post('/tasks/:id/report', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { body?: string; clientMessageId?: string };
    if (!body.body || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const message = roomState.current.report(params.id, viewerFrom(req.headers, req.user).userId, body.body, body.clientMessageId);
      await flushRoom();
      return message;
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  for (const action of ['cancel', 'review'] as const) {
    app.post(`/tasks/:id/${action}`, async (req, reply) => {
      const params = req.params as { id: string };
      const body = (req.body ?? {}) as { clientMessageId?: string };
      if (!body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
      try {
        const message = roomState.current[action](params.id, viewerFrom(req.headers, req.user), body.clientMessageId);
        await flushRoom();
        return message;
      } catch (error) {
        const refused = refusal(error);
        return reply.code(refused.code).send(refused.body);
      }
    });
  }

  app.post<{ Params: { id: string }; Body: { body?: string | null } }>('/tasks/:id/verify', async (req, reply) => {
    if (!req.body || !('body' in req.body)) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const task = roomState.current.verifyEvidence(req.params.id, viewerFrom(req.headers, req.user), req.body.body ?? null);
      await flushRoom();
      return { task, overview: roomState.current.overview(task.id, viewerFrom(req.headers, req.user)) };
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/ask-input', async (req, reply) => {
    try {
      const task = roomState.current.askInput(req.params.id, viewerFrom(req.headers, req.user));
      await flushRoom();
      return { task };
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  app.post<{ Params: { id: string }; Body: { text?: string; clientMessageId?: string } }>('/tasks/:id/supplement', async (req, reply) => {
    const body = req.body ?? {};
    if (typeof body.text !== 'string' || !body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const result = roomState.current.supplement(req.params.id, viewerFrom(req.headers, req.user), body.text, body.clientMessageId);
      await flushRoom();
      return result;
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/hold', async (req, reply) => {
    try {
      const task = roomState.current.holdForPermission(req.params.id, viewerFrom(req.headers, req.user));
      await flushRoom();
      return { task };
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });

  app.post<{ Params: { id: string }; Body: { clientMessageId?: string } }>('/tasks/:id/release-hold', async (req, reply) => {
    const body = req.body ?? {};
    if (!body.clientMessageId) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const result = roomState.current.releaseHold(req.params.id, viewerFrom(req.headers, req.user), body.clientMessageId);
      await flushRoom();
      return result;
    } catch (error) {
      const refused = refusal(error);
      return reply.code(refused.code).send(refused.body);
    }
  });
};
