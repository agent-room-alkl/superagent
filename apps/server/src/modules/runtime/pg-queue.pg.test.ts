import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { claimTask, deadLetterTask, releaseTask } from './pg-queue.js';
import { CLAIM_TASK_SQL, OPEN_WORK_INDEX_SQL } from './sql.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;

const SCHEMA = `t41_${randomUUID().replace(/-/g, '')}`;

const DDL = `
CREATE SCHEMA "${SCHEMA}";
CREATE TABLE "${SCHEMA}".tasks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  status text NOT NULL,
  lease_owner text,
  lease_until timestamptz,
  attempt integer NOT NULL DEFAULT 0,
  identity_snapshot jsonb,
  dead_letter boolean NOT NULL DEFAULT false,
  kind text,
  payload jsonb,
  not_before timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "${SCHEMA}".human_work_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  kind text NOT NULL,
  renderer text NOT NULL,
  task_id uuid,
  target jsonb NOT NULL,
  payload_version integer NOT NULL DEFAULT 1,
  status text NOT NULL
);
${OPEN_WORK_INDEX_SQL.replace('ON tasks', `ON "${SCHEMA}".tasks`)}
`;

async function withDatabase<T>(run: (pool: pg.Pool) => Promise<T>): Promise<T> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const admin = await pool.connect();
  try {
    await admin.query(DDL);
    await admin.query(`SET search_path TO "${SCHEMA}"`);
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

const LIVE_TENANT = '11111111-1111-4111-8111-111111111111';

async function insertTask(pool: pg.Pool, createdAtOffsetMs: number): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO "${SCHEMA}"`);
    const result = await client.query<{ id: string }>(
      `INSERT INTO tasks (id, tenant_id, status, attempt, dead_letter, created_at)
       VALUES (gen_random_uuid(), $2::uuid, 'assigned', 0, false, now() + ($1::int * interval '1 millisecond'))
       RETURNING id`,
      [createdAtOffsetMs, LIVE_TENANT],
    );
    return result.rows[0]!.id;
  } finally {
    client.release();
  }
}

live('two workers claim different rows, and a locked row is skipped instead of waited on', async () => {
  await withDatabase(async (pool) => {
    const older = await insertTask(pool, 0);
    const newer = await insertTask(pool, 1_000);
    const db = bound(pool);
    const [first, second, third] = await Promise.all([
      claimTask(db, 'worker-a', 30_000, 3, LIVE_TENANT),
      claimTask(db, 'worker-b', 30_000, 3, LIVE_TENANT),
      claimTask(db, 'worker-c', 30_000, 3, LIVE_TENANT),
    ]);
    const ids = [first?.id, second?.id, third?.id].filter((id): id is string => Boolean(id));
    expect(new Set(ids).size).toBe(2);
    expect(ids).toEqual(expect.arrayContaining([older, newer]));
    expect([first, second, third].filter((row) => row === null)).toHaveLength(1);
    for (const row of [first, second, third]) {
      if (!row) continue;
      expect(row.identity_snapshot).toMatchObject({ workerId: row.lease_owner, attempt: 1 });
    }

    const locked = await insertTask(pool, 2_000);
    const holder = await pool.connect();
    const claimer = await pool.connect();
    try {
      await holder.query(`SET search_path TO "${SCHEMA}"`);
      await claimer.query(`SET search_path TO "${SCHEMA}"`);
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM tasks WHERE id = $1 FOR UPDATE', [locked]);
      await claimer.query("SET statement_timeout = '3000ms'");
      const started = Date.now();
      const skipped = await claimer.query(CLAIM_TASK_SQL, ['worker-d', 30_000, 3, LIVE_TENANT]);
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(skipped.rows).toEqual([]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      claimer.release();
    }
  });
}, 20_000);

live('a failed claim retries once, then dead-letter opens a single exception item', async () => {
  await withDatabase(async (pool) => {
    const taskId = await insertTask(pool, 0);
    const db = bound(pool);
    const claimed = await claimTask(db, 'worker-a', 30_000, 2, LIVE_TENANT);
    expect(claimed?.id).toBe(taskId);
    expect(claimed?.attempt).toBe(1);
    expect(await releaseTask(db, taskId, 'worker-a', 2)).toBe(true);

    const again = await claimTask(db, 'worker-a', 30_000, 2, LIVE_TENANT);
    expect(again?.attempt).toBe(2);
    expect(await deadLetterTask(db, taskId, 'worker-b', 2, 'boom')).toBe(false);
    expect(await deadLetterTask(db, taskId, 'worker-a', 2, 'boom')).toBe(true);
    expect(await deadLetterTask(db, taskId, 'worker-a', 2, 'boom')).toBe(false);
    expect(await claimTask(db, 'worker-c', 30_000, 2, LIVE_TENANT)).toBeNull();

    const client = await pool.connect();
    try {
      await client.query(`SET search_path TO "${SCHEMA}"`);
      const items = await client.query<{ kind: string; renderer: string; reason: string; worker: string }>(
        `SELECT kind, renderer, target->>'reason' AS reason, target->'identity'->>'workerId' AS worker
         FROM human_work_items WHERE task_id = $1`,
        [taskId],
      );
      expect(items.rows).toEqual([{ kind: 'exception_ruling', renderer: 'issue_list', reason: 'boom', worker: 'worker-a' }]);
      const task = await client.query<{ dead_letter: boolean; status: string }>(
        'SELECT dead_letter, status FROM tasks WHERE id = $1',
        [taskId],
      );
      expect(task.rows[0]).toEqual({ dead_letter: true, status: 'waiting' });
    } finally {
      client.release();
    }
  });
}, 20_000);
