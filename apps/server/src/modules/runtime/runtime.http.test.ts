import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import { inboxState } from '../humanwork/index.js';
import { WorkInbox } from '../humanwork/work-items.js';
import { humanworkModule } from '../humanwork/index.js';
import { bindRuntimeDb, resetRuntime, runtimeModule } from './index.js';
import { CLAIM_TASK_KIND_SQL, CLAIM_TASK_SQL, DEAD_LETTER_SQL, FIND_OPEN_WORK_SQL, HEARTBEAT_TASK_SQL, INSERT_WORK_SQL, RELEASE_TASK_SQL, SUCCEED_TASK_SQL } from './sql.js';

beforeEach(() => {
  inboxState.current = new WorkInbox();
  resetRuntime();
});

it('a failed task past the attempt ceiling shows up once in the human inbox', async () => {
  const app = Fastify();
  await app.register(runtimeModule, { prefix: '/api/v1/runtime' });
  await app.register(humanworkModule, { prefix: '/api/v1/work-items' });

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/tasks',
    payload: { id: 'task-a', tenantId: 'tenant-1', assigneeUserId: 'user-ops', projectId: 'proj-1', maxAttempts: 1 },
  });
  expect(created.statusCode).toBe(200);

  const claimed = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/claim',
    payload: { workerId: 'worker-a' },
  });
  expect(claimed.json().task.id).toBe('task-a');

  const failed = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/tasks/task-a/fail',
    payload: { workerId: 'worker-a', reason: 'boom' },
  });
  expect(failed.json().deadLettered).toBe(true);

  const inbox = await app.inject({
    method: 'GET',
    url: '/api/v1/work-items',
    headers: { 'x-user-id': 'user-ops', 'x-roles': 'employee', 'x-projects': 'proj-1' },
  });
  expect(inbox.json().items).toHaveLength(1);
  expect(inbox.json().items[0].kind).toBe('exception_ruling');
  expect(inbox.json().items[0].payload.taskId).toBe('task-a');

  const again = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/claim',
    payload: { workerId: 'worker-b' },
  });
  expect(again.json().task).toBeNull();
  const stillOne = await app.inject({
    method: 'GET',
    url: '/api/v1/work-items',
    headers: { 'x-user-id': 'user-ops', 'x-roles': 'employee', 'x-projects': 'proj-1' },
  });
  expect(stillOne.json().items).toHaveLength(1);
});

it('a poll waits with notBefore and the same run stays one task until it succeeds', async () => {
  const app = Fastify();
  await app.register(runtimeModule, { prefix: '/api/v1/runtime' });
  const later = Date.now() + 60_000;
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/work',
    payload: { kind: 'knowledge.sync', payload: { tenantId: 'tenant-1', runId: 'run-1', operationId: 'poll' }, notBefore: later },
  });
  expect(first.statusCode).toBe(200);
  const held = await app.inject({ method: 'POST', url: '/api/v1/runtime/claim', payload: { workerId: 'worker-a' } });
  expect(held.json().task).toBeNull();

  const again = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/work',
    payload: { kind: 'knowledge.sync', payload: { tenantId: 'tenant-1', runId: 'run-1', operationId: 'poll' }, notBefore: 0 },
  });
  expect(again.json().id).toBe(first.json().id);
  expect(again.json().attempt).toBe(0);
  const claimed = await app.inject({ method: 'POST', url: '/api/v1/runtime/claim', payload: { workerId: 'worker-a' } });
  expect(claimed.json().task.attempt).toBe(1);
  const done = await app.inject({
    method: 'POST',
    url: `/api/v1/runtime/tasks/${first.json().id}/succeed`,
    payload: { workerId: 'worker-a' },
  });
  expect(done.json().status).toBe('reported');
  const next = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/work',
    payload: { kind: 'knowledge.sync', payload: { tenantId: 'tenant-1', runId: 'run-1', operationId: 'poll' } },
  });
  expect(next.json().id).not.toBe(first.json().id);
  const rejected = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/work',
    payload: { kind: 'knowledge.parse', payload: { tenantId: 'tenant-1', body: 'secret' } },
  });
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json().error).toBe('payload_not_a_ref');

  const skipped = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/claim',
    payload: { workerId: 'worker-b', kinds: ['knowledge.parse'] },
  });
  expect(skipped.json().task).toBeNull();
  const taken = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/claim',
    payload: { workerId: 'worker-b' },
  });
  expect(taken.json().task.id).toBe(next.json().id);
});

it('a bound database claim and heartbeat use the Postgres statements', async () => {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  bindRuntimeDb({
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params });
      if (sql === CLAIM_TASK_SQL) return { rows: [{ id: 'pg-1', attempt: 1, lease_owner: 'worker-a' }] as T[] };
      if (sql === CLAIM_TASK_KIND_SQL) return { rows: [{ id: 'pg-kind', attempt: 1, lease_owner: 'worker-a' }] as T[] };
      return { rows: [{ id: 'pg-1' }] as T[] };
    },
  });
  const app = Fastify();
  await app.register(runtimeModule, { prefix: '/api/v1/runtime' });

  const bad = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/claim',
    payload: { workerId: 'worker-a', maxAttempts: 1.5 },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toBe('bad_attempts');
  expect(calls).toHaveLength(0);

  const claimed = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/claim',
    payload: { workerId: 'worker-a', maxAttempts: 3 },
  });
  expect(claimed.json().task.id).toBe('pg-1');
  expect(calls[0]?.sql).toBe(CLAIM_TASK_SQL);
  expect(calls[0]?.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
  expect(calls[0]?.sql).toMatch(/not_before IS NULL OR not_before <= now\(\)/);
  expect(calls[0]?.params).toEqual(['worker-a', 60_000, 3]);

  const beat = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/tasks/pg-1/heartbeat',
    payload: { workerId: 'worker-a' },
  });
  expect(beat.json().ok).toBe(true);
  expect(calls[1]?.sql).toBe(HEARTBEAT_TASK_SQL);
  expect(calls[1]?.params).toEqual(['pg-1', 'worker-a', 60_000]);

  const filtered = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/claim',
    payload: { workerId: 'worker-a', kinds: ['knowledge.parse', 'room'] },
  });
  expect(filtered.json().task.id).toBe('pg-kind');
  expect(calls[2]?.sql).toBe(CLAIM_TASK_KIND_SQL);
  expect(calls[2]?.params).toEqual(['worker-a', 60_000, 3, ['knowledge.parse']]);
});

it('a bound database finishes a lease by reporting it, or dead-letters only at the ceiling', async () => {
  const calls: string[] = [];
  const rows = [
    [{ id: 'pg-1' }],
    [],
    [{ task_id: 'pg-1' }],
    [],
    [],
  ];
  bindRuntimeDb({
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      calls.push(sql);
      return { rows: (rows.shift() ?? []) as T[] };
    },
  });
  const app = Fastify();
  await app.register(runtimeModule, { prefix: '/api/v1/runtime' });

  const done = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/tasks/pg-1/succeed',
    payload: { workerId: 'worker-a' },
  });
  expect(done.json()).toEqual({ id: 'pg-1', status: 'reported' });

  const dead = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/tasks/pg-1/fail',
    payload: { workerId: 'worker-a', reason: 'boom', maxAttempts: 3 },
  });
  expect(dead.json().deadLettered).toBe(true);

  const lost = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/tasks/pg-1/fail',
    payload: { workerId: 'worker-b', reason: 'boom', maxAttempts: 3 },
  });
  expect(lost.statusCode).toBe(409);
  expect(calls).toEqual([SUCCEED_TASK_SQL, RELEASE_TASK_SQL, DEAD_LETTER_SQL, RELEASE_TASK_SQL, DEAD_LETTER_SQL]);
});

it('a bound database stores one work ref and rejects a non-uuid tenant before any query', async () => {
  const calls: string[] = [];
  const rows: { id: string }[][] = [
    [],
    [{ id: '22222222-2222-4222-8222-222222222222' }],
  ];
  bindRuntimeDb({
    async query<T>(sql: string): Promise<{ rows: T[] }> {
      calls.push(sql);
      return { rows: (rows.shift() ?? []) as T[] };
    },
  });
  const app = Fastify();
  await app.register(runtimeModule, { prefix: '/api/v1/runtime' });
  const tenant = '11111111-1111-4111-8111-111111111111';
  const bad = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/work',
    payload: { kind: 'knowledge.sync', payload: { tenantId: 'tenant-1', runId: 'run-1', operationId: 'poll' } },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toBe('tenant_not_uuid');
  expect(calls).toHaveLength(0);

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/runtime/work',
    payload: { kind: 'knowledge.sync', payload: { tenantId: tenant, runId: 'run-1', operationId: 'poll' }, notBefore: 0 },
  });
  expect(created.statusCode).toBe(200);
  expect(created.json().id).toBe('22222222-2222-4222-8222-222222222222');
  expect(calls).toEqual([FIND_OPEN_WORK_SQL, INSERT_WORK_SQL]);
});
