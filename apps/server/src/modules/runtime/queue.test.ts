import assert from 'node:assert/strict';
import { it } from 'vitest';
import { TaskQueue } from './queue.js';
import { CLAIM_TASK_SQL, HEARTBEAT_TASK_SQL } from './sql.js';

it('claim SQL takes one row with SKIP LOCKED and a lease', () => {
  assert.match(CLAIM_TASK_SQL, /FOR UPDATE SKIP LOCKED/);
  assert.match(CLAIM_TASK_SQL, /lease_owner = \$1/);
  assert.match(CLAIM_TASK_SQL, /attempt = t\.attempt \+ 1/);
  assert.match(CLAIM_TASK_SQL, /attempt < \$3/);
  assert.match(CLAIM_TASK_SQL, /not_before IS NULL OR not_before <= now\(\)/);
  assert.match(HEARTBEAT_TASK_SQL, /lease_owner = \$2/);
  assert.doesNotMatch(CLAIM_TASK_SQL, /OFFSET/);
});

it('two workers do not receive the same task while the lease holds', () => {
  const queue = new TaskQueue(30_000);
  queue.add({ id: 'a', tenantId: 't', createdAt: 1 });
  queue.add({ id: 'b', tenantId: 't', createdAt: 2 });
  const first = queue.claim('w1', 0);
  const second = queue.claim('w2', 0);
  const third = queue.claim('w3', 0);
  assert.equal(first?.id, 'a');
  assert.equal(second?.id, 'b');
  assert.equal(third, null);
  assert.equal(first?.attempt, 1);
  assert.equal(first?.leaseOwner, 'w1');
});

it('expired lease can be claimed by another worker and the attempt increases', () => {
  const queue = new TaskQueue(1_000);
  queue.add({ id: 'a', tenantId: 't', createdAt: 1 });
  assert.equal(queue.claim('w1', 0)?.id, 'a');
  assert.equal(queue.heartbeat('a', 'w1', 1_000), false);
  const again = queue.claim('w2', 1_000);
  assert.equal(again?.leaseOwner, 'w2');
  assert.equal(again?.attempt, 2);
  assert.throws(() => queue.succeed('a', 'w1', 1_000), /lease_lost|lease_expired/);
});

it('heartbeat extends the lease only for the current owner', () => {
  const queue = new TaskQueue(1_000);
  queue.add({ id: 'a', tenantId: 't', createdAt: 1 });
  queue.claim('w1', 0);
  assert.equal(queue.heartbeat('a', 'w1', 500), true);
  assert.equal(queue.get('a')?.leaseUntil, 1_500);
  assert.equal(queue.claim('w2', 1_200), null);
});

it('failures retry until the ceiling, then dead-letter once and open a human item', () => {
  const opened: string[] = [];
  const queue = new TaskQueue(5_000, (task) => opened.push(task.id));
  queue.add({ id: 'a', tenantId: 't', createdAt: 1, maxAttempts: 2 });
  queue.claim('w1', 0);
  const retry = queue.fail('a', 'w1', 10, 'boom');
  assert.equal(retry.deadLettered, false);
  assert.equal(retry.task.status, 'assigned');
  queue.claim('w1', 20);
  const dead = queue.fail('a', 'w1', 30, 'boom');
  assert.equal(dead.deadLettered, true);
  assert.equal(dead.task.deadLetter, true);
  assert.equal(dead.task.waitingReason, 'dead_letter:boom');
  assert.deepEqual(opened, ['a']);
  assert.equal(queue.claim('w2', 40), null);
});

it('enqueue stores only ids, and registering a handler does not run it', () => {
  const queue = new TaskQueue(30_000);
  let ran = 0;
  queue.register('knowledge.parse', () => { ran += 1; });
  const task = queue.enqueue('knowledge.parse', { tenantId: 't', itemId: 'item-1' });
  assert.equal(ran, 0);
  assert.equal(task.kind, 'knowledge.parse');
  assert.deepEqual(task.payload, { tenantId: 't', itemId: 'item-1' });
  assert.throws(() => queue.enqueue('knowledge.sync', { tenantId: 't', body: 'secret' } as never), /payload_not_a_ref/);
  const claimed = queue.claim('worker', 0);
  assert.equal(claimed?.attempt, 1);
  assert.equal(ran, 0);
  assert.equal(queue.heartbeat(task.id, 'worker', 1_000), true);
  assert.equal(queue.handler('knowledge.parse') !== undefined, true);
});

it('notBefore holds the same run without counting a failure', () => {
  const queue = new TaskQueue(30_000);
  const first = queue.enqueue('knowledge.sync', { tenantId: 't', runId: 'run-1', operationId: 'poll' }, 5_000);
  assert.equal(queue.claim('worker', 1_000), null);
  assert.equal(queue.get(first.id)?.attempt, 0);
  const again = queue.enqueue('knowledge.sync', { tenantId: 't', runId: 'run-1', operationId: 'poll' }, 2_000);
  assert.equal(again.id, first.id);
  assert.equal(again.attempt, 0);
  assert.equal(again.notBefore, 2_000);
  const claimed = queue.claim('worker', 2_000);
  assert.equal(claimed?.id, first.id);
  assert.equal(claimed?.attempt, 1);
  const leased = queue.enqueue('knowledge.sync', { tenantId: 't', runId: 'run-1', operationId: 'poll' }, 9_000);
  assert.equal(leased.id, first.id);
  assert.equal(leased.notBefore, 2_000);
  queue.succeed(first.id, 'worker', 2_100);
  const next = queue.enqueue('knowledge.sync', { tenantId: 't', runId: 'run-1', operationId: 'poll' }, 8_000);
  assert.notEqual(next.id, first.id);
  assert.equal(next.attempt, 0);
  assert.equal(next.notBefore, 8_000);
});
