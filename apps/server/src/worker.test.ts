import { expect, it } from 'vitest';
import { CLAIM_TASK_KIND_SQL } from './modules/runtime/sql.js';
import { TaskQueue } from './modules/runtime/queue.js';
import { dispatchBound, dispatchReady, runQueueLoop } from './worker.js';

it('claims only a registered kind and calls that handler once', () => {
  const queue = new TaskQueue(60_000);
  queue.add({ id: 'room-task', tenantId: 't', createdAt: 1 });
  const waiting = queue.enqueue('knowledge.parse', { tenantId: 't', itemId: 'item-1' });
  queue.enqueue('knowledge.sync', { tenantId: 't', runId: 'run-1', operationId: 'poll' });

  expect(dispatchReady(queue, 'worker-a', 1_000)).toBeNull();
  expect(queue.get(waiting.id)?.attempt).toBe(0);
  expect(queue.get('room-task')?.leaseOwner).toBeNull();

  const seen: string[] = [];
  queue.register('knowledge.parse', (task) => seen.push(task.id));
  const claimed = dispatchReady(queue, 'worker-a', 1_000);
  expect(claimed?.id).toBe(waiting.id);
  expect(seen).toEqual([waiting.id]);
  expect(queue.get('room-task')?.leaseOwner).toBeNull();
  expect(dispatchReady(queue, 'worker-b', 1_000)).toBeNull();

  const later = queue.enqueue('knowledge.parse', { tenantId: 't', itemId: 'item-2', runId: 'run-2' }, 5_000);
  expect(dispatchReady(queue, 'worker-a', 1_000)).toBeNull();
  expect(queue.get(later.id)?.attempt).toBe(0);
  const due = dispatchReady(queue, 'worker-a', 5_000);
  expect(due?.id).toBe(later.id);
  expect(seen).toEqual([waiting.id, later.id]);
});

it('a bound database is claimed only for a registered kind, and the handler runs once', async () => {
  const queue = new TaskQueue(60_000);
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const db = {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      calls.push({ sql, params });
      return {
        rows: [{
          id: 'pg-parse',
          attempt: 1,
          lease_owner: 'worker-a',
          kind: 'knowledge.parse',
          tenant_id: '11111111-1111-4111-8111-111111111111',
          payload: { tenantId: '11111111-1111-4111-8111-111111111111', itemId: 'item-1' },
          identity_snapshot: { workerId: 'worker-a', claimedAt: '2026-11-09T00:00:00.000Z', attempt: 1 },
        } as T],
      };
    },
  };

  expect(await dispatchBound(db, queue, 'worker-a')).toBeNull();
  expect(calls).toHaveLength(0);

  const seen: string[] = [];
  queue.register('knowledge.parse', (task) => seen.push(task.id));
  const claimed = await dispatchBound(db, queue, 'worker-a');
  expect(claimed?.id).toBe('pg-parse');
  expect(claimed?.payload).toEqual({ tenantId: '11111111-1111-4111-8111-111111111111', itemId: 'item-1' });
  expect(claimed?.identitySnapshot).toEqual({ workerId: 'worker-a', claimedAt: '2026-11-09T00:00:00.000Z', attempt: 1 });
  expect(seen).toEqual(['pg-parse']);
  expect(calls[0]?.sql).toBe(CLAIM_TASK_KIND_SQL);
  expect(calls[0]?.params).toEqual(['worker-a', 60_000, 3, ['knowledge.parse']]);
});

it('keeps the loop alive when a bound claim cannot reach the database', async () => {
  const previous = process.env.WORKER_HEARTBEAT_MS;
  process.env.WORKER_HEARTBEAT_MS = '5';
  const queue = new TaskQueue(60_000);
  queue.register('knowledge.parse', () => undefined);
  const controller = new AbortController();
  const done = runQueueLoop(controller.signal, queue, {
    async query() {
      throw new Error('econnrefused');
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await done;
  if (previous === undefined) delete process.env.WORKER_HEARTBEAT_MS;
  else process.env.WORKER_HEARTBEAT_MS = previous;
});
