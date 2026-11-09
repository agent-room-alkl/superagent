import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import { bindRoomStore, createCommandRoom, hydrateRoom, loadRoom, reloadRoom, roomModule, roomState, saveRoom } from './index.js';
import { LOAD_MEMBERS_SQL, LOAD_MESSAGES_SQL, LOAD_TASKS_SQL, UPSERT_MEMBER_SQL, UPSERT_MESSAGE_SQL, UPSERT_TASK_SQL } from './sql.js';

beforeEach(() => {
  bindRoomStore(null);
  roomState.current = createCommandRoom();
});

it('serves the command room: no task for a greeting, one row per client id, and a role-filtered task list', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });

  const hello = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', body: '你好', clientMessageId: 'c1' },
  });
  expect(hello.json().task).toBeNull();

  const work = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'c2' },
  });
  expect(work.json().task.messageId).toBe(work.json().message.id);

  const again = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'c2' },
  });
  expect(again.json().duplicate).toBe(true);

  const stream = await app.inject({
    method: 'GET',
    url: `/api/v1/room/stream?roomId=room-1&after=${hello.json().reply.seq}`,
  });
  expect(stream.headers['content-type']).toContain('text/event-stream');
  expect(stream.body).toContain('整理询价草稿');
  expect(stream.body.match(/"clientMessageId":"c2"/g)?.length).toBe(1);

  const sales = await app.inject({
    method: 'GET',
    url: '/api/v1/room/tasks',
    headers: { 'x-user-id': 'user-sales', 'x-roles': 'employee', 'x-projects': 'p1' },
  });
  const ops = await app.inject({
    method: 'GET',
    url: '/api/v1/room/tasks',
    headers: { 'x-user-id': 'user-ops', 'x-roles': 'employee', 'x-projects': 'p1' },
  });
  expect(sales.json().tasks.every((task: { assigneeUserId: string }) => task.assigneeUserId === 'user-sales')).toBe(true);
  expect(ops.json().tasks).toEqual([]);
  await app.close();
});

it('a model outage keeps the assigned task and says it cannot be handled yet', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  const posted = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    headers: { 'x-model-available': 'false' },
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'model-1' },
  });
  expect(posted.json().task.status).toBe('waiting');
  expect(posted.json().task.waitingReason).toBe('等待模型');
  expect(posted.json().reply.body).toContain('暂时无法处理');
  const tasks = await app.inject({ method: 'GET', url: '/api/v1/room/tasks' });
  expect(tasks.json().tasks).toHaveLength(1);
  await app.close();
});

it('an employee posting about another project is refused and no task is stored', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  const posted = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    headers: { 'x-user-id': 'user-sales', 'x-roles': 'employee', 'x-projects': 'p1' },
    payload: { roomId: 'room-1', projectId: 'p2', body: '@销售员工 查看别人的项目', clientMessageId: 'scope-1' },
  });
  expect(posted.json().task).toBeNull();
  expect(posted.json().reply.body).toContain('不会创建');
  const tasks = await app.inject({
    method: 'GET',
    url: '/api/v1/room/tasks',
    headers: { 'x-user-id': 'user-owner', 'x-roles': 'owner' },
  });
  expect(tasks.json().tasks).toEqual([]);
  await app.close();
});

it('reloading from the snapshot still returns the same task and does not duplicate the message', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  const posted = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'c9' },
  });
  expect(posted.json().task.messageId).toBe(posted.json().message.id);
  reloadRoom(roomState.current.snapshot());
  const tasks = await app.inject({
    method: 'GET',
    url: '/api/v1/room/tasks',
    headers: { 'x-user-id': 'user-sales', 'x-roles': 'employee', 'x-projects': 'p1' },
  });
  expect(tasks.json().tasks).toHaveLength(1);
  const again = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'c9' },
  });
  expect(again.json().duplicate).toBe(true);
  await app.close();
});

it('a room saved to disk comes back with the same task after load', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  const file = path.join(os.tmpdir(), `room-${Date.now()}.json`);
  await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'disk-1' },
  });
  saveRoom(file);
  roomState.current = createCommandRoom();
  loadRoom(file);
  const tasks = await app.inject({
    method: 'GET',
    url: '/api/v1/room/tasks',
    headers: { 'x-user-id': 'user-sales', 'x-roles': 'employee', 'x-projects': 'p1' },
  });
  expect(tasks.json().tasks).toHaveLength(1);
  expect(tasks.json().tasks[0].title).toContain('整理询价草稿');
  fs.unlinkSync(file);
  await app.close();
});

it('wiping the process and hydrating from the row store keeps the task and the dedup', async () => {
  bindRoomStore(memoryRoomDb());
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'pg-1' },
  });
  const taskId = roomState.current.listTasks({ userId: 'user-sales', roles: ['employee'], projectScopes: ['p1'] })[0]?.id;
  await app.inject({
    method: 'POST',
    url: `/api/v1/room/tasks/${taskId}/report`,
    headers: { 'x-user-id': 'user-sales', 'x-roles': 'employee', 'x-projects': 'p1' },
    payload: { body: '询价草稿已整理', clientMessageId: 'report-1' },
  });
  roomState.current = createCommandRoom();
  await hydrateRoom();
  const tasks = await app.inject({
    method: 'GET',
    url: '/api/v1/room/tasks',
    headers: { 'x-user-id': 'user-sales', 'x-roles': 'employee', 'x-projects': 'p1' },
  });
  expect(tasks.json().tasks).toHaveLength(1);
  expect(tasks.json().tasks[0].status).toBe('reported');
  const again = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'pg-1' },
  });
  expect(again.json().duplicate).toBe(true);
  const messages = await app.inject({ method: 'GET', url: '/api/v1/room/messages?roomId=room-1&after=0' });
  expect(messages.json().messages.filter((message: { clientMessageId: string }) => message.clientMessageId === 'pg-1')).toHaveLength(1);
  expect(messages.json().messages.some((message: { body: string }) => message.body === '询价草稿已整理')).toBe(true);
  await app.close();
});

it('a repeated report client id does not add a second transcript row', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  const posted = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'dedup-assign' },
  });
  const taskId = posted.json().task.id as string;
  const headers = { 'x-user-id': 'user-sales', 'x-roles': 'employee', 'x-projects': 'p1' };
  const first = await app.inject({
    method: 'POST',
    url: `/api/v1/room/tasks/${taskId}/report`,
    headers,
    payload: { body: '询价草稿已整理', clientMessageId: 'dedup-report' },
  });
  const second = await app.inject({
    method: 'POST',
    url: `/api/v1/room/tasks/${taskId}/report`,
    headers,
    payload: { body: '另一段正文', clientMessageId: 'dedup-report' },
  });
  expect(second.statusCode).toBe(200);
  expect(second.json().id).toBe(first.json().id);
  const messages = await app.inject({ method: 'GET', url: '/api/v1/room/messages?roomId=room-1&after=0' });
  expect(messages.json().messages.filter((message: { clientMessageId: string }) => message.clientMessageId === 'dedup-report')).toHaveLength(1);
  const stream = await app.inject({
    method: 'GET',
    url: `/api/v1/room/stream?roomId=room-1&after=${posted.json().reply.seq}`,
  });
  expect(stream.headers['content-type']).toContain('text/event-stream');
  expect(stream.body.match(/"clientMessageId":"dedup-report"/g)).toHaveLength(1);
  expect(stream.body).toContain(`id: ${first.json().seq}\n`);
  await app.close();
});

it('a report from anyone but the assignee is refused and does not enter the transcript', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  const posted = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    payload: { roomId: 'room-1', projectId: 'p1', body: '@销售员工 整理询价草稿', clientMessageId: 'assignee-assign' },
  });
  const taskId = posted.json().task.id as string;
  const refused = await app.inject({
    method: 'POST',
    url: `/api/v1/room/tasks/${taskId}/report`,
    headers: { 'x-user-id': 'user-ops', 'x-roles': 'employee', 'x-projects': 'p1' },
    payload: { body: '不是我的任务', clientMessageId: 'assignee-wrong' },
  });
  expect(refused.statusCode).toBe(403);
  expect(refused.json().error).toBe('not_assignee');
  const messages = await app.inject({ method: 'GET', url: '/api/v1/room/messages?roomId=room-1&after=0' });
  expect(messages.json().messages.some((message: { clientMessageId: string }) => message.clientMessageId === 'assignee-wrong')).toBe(false);
  const tasks = await app.inject({
    method: 'GET',
    url: '/api/v1/room/tasks',
    headers: { 'x-user-id': 'user-sales', 'x-roles': 'employee', 'x-projects': 'p1' },
  });
  expect(tasks.json().tasks[0].status).toBe('assigned');
  await app.close();
});

it('rejects a gap-fill cursor that is not a whole message sequence', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  const posted = await app.inject({
    method: 'POST',
    url: '/api/v1/room/messages',
    headers: { 'x-user-id': 'user-owner', 'x-roles': 'owner' },
    payload: { roomId: 'room-1', body: '你好', clientMessageId: 'cursor-1' },
  });
  expect(posted.statusCode).toBe(200);
  for (const after of ['foo', '-1', '1.5']) {
    const messages = await app.inject({ method: 'GET', url: `/api/v1/room/messages?roomId=room-1&after=${after}` });
    expect(messages.statusCode).toBe(400);
    expect(messages.json().error).toBe('bad_cursor');
    const stream = await app.inject({ method: 'GET', url: `/api/v1/room/stream?roomId=room-1&after=${after}` });
    expect(stream.statusCode).toBe(400);
    expect(stream.json().error).toBe('bad_cursor');
  }
  const caughtUp = await app.inject({ method: 'GET', url: '/api/v1/room/messages?roomId=room-1&after=0' });
  expect(caughtUp.statusCode).toBe(200);
  expect(caughtUp.json().messages.length).toBeGreaterThan(0);
  await app.close();
});

interface StoredMessage {
  id: string;
  seq: number;
  tenant_id: string;
  room_id: string;
  author: string;
  body: string;
  client_message_id: string;
  mentions: string[];
  task_ids: string[];
}

interface StoredTask {
  id: string;
  tenant_id: string;
  room_id: string;
  project_id: string | null;
  message_id: string;
  assignee_user_id: string;
  employee_id: string;
  title: string;
  status: string;
  waiting_reason: string | null;
}

function memoryRoomDb() {
  const messages: StoredMessage[] = [];
  const tasks: StoredTask[] = [];
  const members: Array<{ room_id: string; user_id: string }> = [];
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      if (sql === UPSERT_MESSAGE_SQL) {
        const row: StoredMessage = {
          id: String(params[0]),
          seq: Number(params[1]),
          tenant_id: String(params[2]),
          room_id: String(params[3]),
          author: String(params[4]),
          body: String(params[5]),
          client_message_id: String(params[6]),
          mentions: JSON.parse(String(params[7])) as string[],
          task_ids: JSON.parse(String(params[8])) as string[],
        };
        const existing = messages.findIndex((item) => item.room_id === row.room_id && item.client_message_id === row.client_message_id);
        if (existing >= 0) messages[existing] = { ...messages[existing]!, task_ids: row.task_ids };
        else messages.push(row);
        return { rows: [] };
      }
      if (sql === UPSERT_TASK_SQL) {
        const row: StoredTask = {
          id: String(params[0]),
          tenant_id: String(params[1]),
          room_id: String(params[2]),
          project_id: params[3] == null ? null : String(params[3]),
          message_id: String(params[4]),
          assignee_user_id: String(params[5]),
          employee_id: String(params[6]),
          title: String(params[7]),
          status: String(params[8]),
          waiting_reason: params[9] == null ? null : String(params[9]),
        };
        const existing = tasks.findIndex((item) => item.id === row.id);
        if (existing >= 0) tasks[existing] = row;
        else tasks.push(row);
        return { rows: [] };
      }
      if (sql === UPSERT_MEMBER_SQL) {
        const roomId = String(params[0]);
        const userId = String(params[1]);
        if (!members.some((item) => item.room_id === roomId && item.user_id === userId)) members.push({ room_id: roomId, user_id: userId });
        return { rows: [] };
      }
      if (sql === LOAD_MESSAGES_SQL) return { rows: [...messages].sort((a, b) => a.seq - b.seq) as T[] };
      if (sql === LOAD_TASKS_SQL) return { rows: tasks as T[] };
      if (sql === LOAD_MEMBERS_SQL) return { rows: members as T[] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}
