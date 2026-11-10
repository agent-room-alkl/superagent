/**
 * What a command-room task's linked execution run has done, read from the modules that own it: the run from the
 * executor, its approvals from the work inbox, its external attempts and read-back from the tool gateway.
 * The room never runs, re-runs or undoes anything here. The one write is retiring approvals after a contract change.
 *
 * Loaded lazily by the room routes, because the work-inbox module imports the room module (viewerFrom).
 */
import { executionState } from '../execution/index.js';
import { gatewayState, flushGateway } from '../gateway/index.js';
import { flushInbox, inboxState, persistWorkItem } from '../humanwork/index.js';
import type { Execution } from '../execution/executor.js';
import type { WorkItem } from '../humanwork/work-items.js';

export interface TaskOutcome {
  runId: string;
  runStatus: string;
  eventId: string;
  approvals: Array<{ id: string; status: string; standing: boolean; actionStatus: string | null }>;
  /** External write attempts the gateway recorded for this run. A contract change never adds one. */
  attempts: number;
  actions: Array<{ stepId: string; status: string; calls: number; externalRef: string | null; readback: unknown }>;
}

/** The run, or null when this tenant has no such run. Never creates or starts one. */
export function findRun(tenantId: string, runId: string): Execution | null {
  try {
    return executionState.current.get(tenantId, runId);
  } catch {
    return null;
  }
}

/** The approvals that authorised this run's writes: the run's action approvals and its human-review items. */
function approvalsOf(run: Execution): WorkItem[] {
  const reviewIds = new Set(run.steps.filter((step) => step.workItemId).map((step) => step.workItemId as string));
  return inboxState.current.all().filter((item) =>
    item.tenantId === run.tenantId
    && (item.kind === 'action_approval' || reviewIds.has(item.id))
    && (item.payload.executionId === run.id || reviewIds.has(item.id)));
}

export function outcomeOf(tenantId: string, runId: string): TaskOutcome | null {
  const run = findRun(tenantId, runId);
  if (!run) return null;
  const actions = gatewayState.current.snapshot().actions.filter((action) => action.tenantId === run.tenantId && action.instanceId === run.instanceId);
  return {
    runId: run.id,
    runStatus: run.status,
    eventId: run.eventId,
    approvals: approvalsOf(run).map((item) => ({ id: item.id, status: item.status, standing: item.decision !== null, actionStatus: item.actionStatus })),
    attempts: actions.reduce((sum, action) => sum + action.calls, 0),
    actions: actions.map((action) => ({ stepId: action.stepId, status: action.status, calls: action.calls, externalRef: action.externalRef, readback: action.readback })),
  };
}

/** Retire every standing approval of the run. Returns the ids retired; an approval already retired is left alone. */
export async function retireApprovals(tenantId: string, runId: string): Promise<string[]> {
  const run = findRun(tenantId, runId);
  if (!run) return [];
  const retired: string[] = [];
  for (const item of approvalsOf(run)) {
    if (!item.decision) continue;
    const updated = inboxState.current.retireDecision(item.id);
    await persistWorkItem(updated);
    retired.push(item.id);
  }
  if (retired.length > 0) {
    await flushInbox();
    await flushGateway(); // unchanged; written so the stored state matches the process after a restart
  }
  return retired;
}
