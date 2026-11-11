import { expect, it } from 'vitest';
import { claimTask, deadLetterTask, enqueueWork, heartbeatTask, releaseTask, succeedTask } from './pg-queue.js';
import { CLAIM_TASK_KIND_SQL, CLAIM_TASK_SQL, DEAD_LETTER_SQL, FIND_OPEN_WORK_SQL, HEARTBEAT_TASK_SQL, INSERT_WORK_SQL, OPEN_WORK_INDEX_SQL, RELEASE_TASK_SQL, SUCCEED_TASK_SQL, UPDATE_NOT_BEFORE_SQL } from './sql.js';

it('sends the SKIP LOCKED claim and returns no row when the queue is empty', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const row = await claimTask(
    {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      },
    },
    'worker-a',
    30_000,
    3,
    '11111111-1111-4111-8111-111111111111',
  );
  expect(row).toBeNull();
  expect(calls[0]?.sql).toBe(CLAIM_TASK_SQL);
  expect(calls[0]?.sql).toMatch(/tenant_id = \$4::uuid/);
  expect(calls[0]?.params).toEqual(['worker-a', 30_000, 3, '11111111-1111-4111-8111-111111111111']);
});

it('limits a Postgres claim to the named kinds and does not take a room row', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  await claimTask(
    {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [] };
      },
    },
    'worker-a',
    30_000,
    3,
    '11111111-1111-4111-8111-111111111111',
    ['knowledge.parse'],
  );
  expect(calls[0]?.sql).toBe(CLAIM_TASK_KIND_SQL);
  expect(calls[0]?.sql).toMatch(/kind = ANY\(\$5::text\[\]\)/);
  expect(calls[0]?.sql).toMatch(/tenant_id = \$4::uuid/);
  expect(calls[0]?.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  expect(calls[0]?.params).toEqual(['worker-a', 30_000, 3, '11111111-1111-4111-8111-111111111111', ['knowledge.parse']]);
});

it('treats a heartbeat with no updated row as a lost lease', async () => {
  const renewed = await heartbeatTask(
    { async query() { return { rows: [] }; } },
    'task-1',
    'worker-a',
    30_000,
  );
  expect(renewed).toBe(false);
  const held = await heartbeatTask(
    {
      async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
        expect(sql).toBe(HEARTBEAT_TASK_SQL);
        expect(params).toEqual(['task-1', 'worker-a', 30_000]);
        return { rows: [{ id: 'task-1' } as T] };
      },
    },
    'task-1',
    'worker-a',
    30_000,
  );
  expect(held).toBe(true);
});

it('dead-letter inserts one exception item and a retry release stops at the ceiling', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db = {
    async query<T>(sql: string, params: readonly unknown[]) {
      calls.push({ sql, params });
      return { rows: [{ task_id: 'task-1' }] as T[] };
    },
  };
  expect(await deadLetterTask(db, 'task-1', 'worker-a', 3, 'boom')).toBe(true);
  expect(calls[0]?.sql).toBe(DEAD_LETTER_SQL);
  expect(calls[0]?.sql).toMatch(/INSERT INTO human_work_items/);
  expect(calls[0]?.sql).toMatch(/exception_ruling/);
  expect(calls[0]?.params).toEqual(['task-1', 'worker-a', 3, 'boom']);

  const released = await releaseTask(
    {
      async query(sql, params) {
        expect(sql).toBe(RELEASE_TASK_SQL);
        expect(sql).toMatch(/attempt < \$3/);
        expect(params).toEqual(['task-1', 'worker-a', 3]);
        return { rows: [] };
      },
    },
    'task-1',
    'worker-a',
    3,
  );
  expect(released).toBe(false);
});

it('reports a leased task only while the holder still owns the lease', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const ok = await succeedTask(
    {
      async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
        calls.push({ sql, params });
        return { rows: [{ id: 'task-1' }] as T[] };
      },
    },
    'task-1',
    'worker-a',
  );
  expect(ok).toBe(true);
  expect(calls[0]?.sql).toBe(SUCCEED_TASK_SQL);
  expect(calls[0]?.sql).toMatch(/status = 'reported'/);
  expect(calls[0]?.sql).toMatch(/lease_until > now\(\)/);
  expect(calls[0]?.params).toEqual(['task-1', 'worker-a']);
  const lost = await succeedTask({ async query() { return { rows: [] }; } }, 'task-1', 'worker-b');
  expect(lost).toBe(false);
});

const TENANT = '11111111-1111-4111-8111-111111111111';

it('keeps one open poll row and does not move not_before while that row is leased', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const script: { id: string; status?: string; lease_owner?: string | null }[][] = [
    [],
    [{ id: '11111111-1111-4111-8111-111111111112' }],
    [{ id: '11111111-1111-4111-8111-111111111112', status: 'assigned', lease_owner: null }],
    [{ id: '11111111-1111-4111-8111-111111111112' }],
    [{ id: '11111111-1111-4111-8111-111111111112', status: 'running', lease_owner: 'worker-a' }],
  ];
  const db = {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params });
      return { rows: (script.shift() ?? []) as T[] };
    },
  };
  const ref = { tenantId: TENANT, runId: 'run-1', operationId: 'poll' };
  const created = await enqueueWork(db, 'knowledge.sync', ref, 5_000);
  expect(created.id).toBe('11111111-1111-4111-8111-111111111112');
  expect(calls[0]?.sql).toBe(FIND_OPEN_WORK_SQL);
  expect(calls[1]?.sql).toBe(INSERT_WORK_SQL);
  expect(calls[1]?.params[0]).toBe(TENANT);
  expect(JSON.parse(String(calls[1]?.params[2]))).toEqual(ref);
  expect(String(calls[1]?.params[2])).not.toMatch(/secret|body/);

  const moved = await enqueueWork(db, 'knowledge.sync', ref, 0);
  expect(moved.id).toBe(created.id);
  expect(calls[2]?.sql).toBe(FIND_OPEN_WORK_SQL);
  expect(calls[3]?.sql).toBe(UPDATE_NOT_BEFORE_SQL);

  const leased = await enqueueWork(db, 'knowledge.sync', ref, 9_000);
  expect(leased.id).toBe(created.id);
  expect(calls).toHaveLength(5);
  expect(calls[4]?.sql).toBe(FIND_OPEN_WORK_SQL);
  await expect(enqueueWork(db, 'knowledge.sync', { tenantId: 'tenant-1', runId: 'run-1' })).rejects.toThrow(/tenant_not_uuid/);
  await expect(enqueueWork(db, 'knowledge.sync', { tenantId: TENANT, body: 'secret' } as never)).rejects.toThrow(/payload_not_a_ref/);
  expect(calls).toHaveLength(5);
});

it('a unique-index collision returns the row the other worker inserted', async () => {
  const calls: string[] = [];
  const db = {
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      calls.push(sql);
      if (sql === INSERT_WORK_SQL) throw Object.assign(new Error('duplicate'), { code: '23505' });
      if (calls.filter((line) => line === FIND_OPEN_WORK_SQL).length === 1) return { rows: [] as T[] };
      return { rows: [{ id: '33333333-3333-4333-8333-333333333333', status: 'assigned', lease_owner: null }] as T[] };
    },
  };
  const row = await enqueueWork(db, 'analysis.run', { tenantId: TENANT, runId: 'run-9', operationId: 'start' });
  expect(row.id).toBe('33333333-3333-4333-8333-333333333333');
  expect(calls).toEqual([FIND_OPEN_WORK_SQL, INSERT_WORK_SQL, FIND_OPEN_WORK_SQL]);
  expect(OPEN_WORK_INDEX_SQL).toMatch(/CREATE UNIQUE INDEX/);
  expect(OPEN_WORK_INDEX_SQL).toMatch(/coalesce\(payload->>'operationId'/);
});
