import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { loadRoomRows, saveRoomRows } from './pg-room.js';
import { CommandRoom, type EmployeeRef } from './room.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;

const SCHEMA = `t41_${randomUUID().replace(/-/g, '')}`;

const DDL = `
CREATE SCHEMA "${SCHEMA}";
CREATE TABLE "${SCHEMA}".room_messages (
  id text PRIMARY KEY,
  seq integer NOT NULL,
  tenant_id text NOT NULL,
  room_id text NOT NULL,
  author text NOT NULL,
  body text NOT NULL,
  client_message_id text NOT NULL,
  mentions jsonb NOT NULL,
  task_ids jsonb NOT NULL,
  UNIQUE (room_id, client_message_id)
);
CREATE TABLE "${SCHEMA}".room_tasks (
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
CREATE TABLE "${SCHEMA}".room_members (
  room_id text NOT NULL,
  user_id text NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
`;

const employees: EmployeeRef[] = [
  { id: 'emp-sales', name: '销售员工', ownerUserId: 'user-sales', status: 'active' },
];

async function withDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const admin = await pool.connect();
  try {
    await admin.query(DDL);
    return await run(pool);
  } finally {
    await admin.query('SET search_path TO public');
    await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    admin.release();
    await pool.end();
  }
}

function bound(pool: pg.Pool) {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${SCHEMA}"`);
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as T[] };
      } finally {
        client.release();
      }
    },
  };
}

live('a restarted room reloads the conversation from Postgres and keeps the client-id dedup', async () => {
  await withDatabase(async (pool) => {
    const db = bound(pool);
    const service = new CommandRoom(employees);
    service.addMember('room-1', 'user-sales');
    const posted = service.post({
      roomId: 'room-1',
      tenantId: 't',
      projectId: 'p1',
      authorUserId: 'user-owner',
      body: '@销售员工 整理询价草稿',
      clientMessageId: 'c2',
    });
    service.report(posted.task!.id, 'user-sales', '询价草稿已整理', 'report-1');
    await saveRoomRows(db, service.snapshot());
    await saveRoomRows(db, service.snapshot());

    const restored = CommandRoom.restore(employees, await loadRoomRows(db));
    const owner = { userId: 'user-owner', roles: ['owner' as const], projectScopes: [] };
    const messages = restored.eventsAfter('room-1', 0, owner);
    expect(messages.map((message) => message.body)).toEqual(['@销售员工 整理询价草稿', '已交给 @销售员工：@销售员工 整理询价草稿', '询价草稿已整理']);
    expect(restored.listTasks(owner)).toHaveLength(1);
    expect(restored.listTasks(owner)[0]?.status).toBe('reported');
    const again = restored.post({
      roomId: 'room-1',
      tenantId: 't',
      projectId: 'p1',
      authorUserId: 'user-owner',
      body: '@销售员工 整理询价草稿',
      clientMessageId: 'c2',
    });
    expect(again.duplicate).toBe(true);
    expect(restored.eventsAfter('room-1', 0, owner).filter((message) => message.clientMessageId === 'c2')).toHaveLength(1);
  });
});
