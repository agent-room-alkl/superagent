import type { WorkItem } from '../humanwork/work-items.js';
import { WorkInbox } from '../humanwork/work-items.js';
import type { QueueTask } from './queue.js';

/** Opens the one human exception item a dead-lettered task is allowed to create. */
export function openDeadLetterItem(inbox: WorkInbox, task: QueueTask): WorkItem {
  return inbox.create({
    tenantId: task.tenantId,
    kind: 'exception_ruling',
    projectId: task.projectId,
    assigneeUserId: task.assigneeUserId ?? 'unassigned',
    payload: {
      taskId: task.id,
      source: 'dead_letter',
      reason: task.waitingReason,
      attempt: task.attempt,
      identity: task.identitySnapshot,
    },
  });
}
