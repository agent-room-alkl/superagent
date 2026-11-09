import assert from 'node:assert/strict';
import { it } from 'vitest';
import { WorkInbox } from '../humanwork/work-items.js';
import { openDeadLetterItem } from './dead-letter.js';
import { TaskQueue } from './queue.js';

it('dead-letter opens one exception item and does not open another on a later claim', () => {
  const inbox = new WorkInbox();
  const queue = new TaskQueue(5_000, (task) => openDeadLetterItem(inbox, task));
  queue.add({ id: 'task-a', tenantId: 'tenant-1', projectId: 'proj-1', assigneeUserId: 'user-ops', maxAttempts: 1 });
  queue.claim('worker-a', 0);
  const failed = queue.fail('task-a', 'worker-a', 10, 'boom');
  assert.equal(failed.deadLettered, true);

  const visible = inbox.list({ userId: 'user-ops', roles: ['employee'], projectScopes: ['proj-1'] });
  assert.equal(visible.length, 1);
  assert.equal(visible[0]?.kind, 'exception_ruling');
  assert.equal(visible[0]?.renderer, 'issue_list');
  assert.equal(visible[0]?.payload.taskId, 'task-a');
  assert.equal(visible[0]?.payload.reason, 'dead_letter:boom');

  assert.equal(queue.claim('worker-b', 20), null);
  assert.equal(inbox.list({ userId: 'user-ops', roles: ['employee'], projectScopes: ['proj-1'] }).length, 1);
});
