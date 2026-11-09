import type { ActionStatus, WorkItemKind, WorkItemRenderer, WorkItemStatus } from '@superagent/shared';
import { payloadHash } from '../gateway/gateway.js';
import type { Viewer } from '../room/room.js';

export interface BatchRow {
  id: string;
  clean: boolean;
  selected: boolean;
  executed: boolean;
}

export interface WorkItem {
  id: string;
  tenantId: string;
  kind: WorkItemKind;
  renderer: WorkItemRenderer;
  projectId: string | null;
  assigneeUserId: string;
  payloadVersion: number;
  payload: Record<string, unknown>;
  payloadHash: string;
  status: WorkItemStatus;
  decision: { by: string; payloadHash: string } | null;
  submitCount: number;
  actionStatus: ActionStatus | null;
  systemVerified: boolean;
  evidenceSource: 'system' | 'human_report' | null;
  waitingOn: string | null;
  draft: Record<string, unknown> | null;
  rows: BatchRow[];
}

const DEFAULT_RENDERER: Record<WorkItemKind, WorkItemRenderer> = {
  data_check: 'field_diff',
  action_approval: 'field_diff',
  manual_execution: 'document_preview',
  branch_choice: 'issue_list',
  exception_ruling: 'issue_list',
  supply_info: 'issue_list',
  deliverable_review: 'document_preview',
};

export interface NewWorkItem {
  id?: string;
  tenantId: string;
  kind: WorkItemKind;
  renderer?: WorkItemRenderer;
  projectId?: string | null;
  assigneeUserId: string;
  payload?: Record<string, unknown>;
  waitingOn?: string | null;
  rows?: Array<Pick<BatchRow, 'id' | 'clean' | 'selected'>>;
}

export type WorkGroup = 'action' | 'waiting' | 'internal';

/** A decision is not permission to write. Only a current action-approval hash may execute. */
export function canExecute(item: WorkItem): boolean {
  if (item.draft) return false;
  if (!item.decision) return false;
  if (item.kind !== 'action_approval') return false;
  if (item.decision.payloadHash !== item.payloadHash) return false;
  if (item.actionStatus === 'outcome_unknown' || item.actionStatus === 'not_submitted') return false;
  return true;
}

export function workGroup(item: WorkItem): WorkGroup {
  if (item.waitingOn) return 'waiting';
  if (item.kind === 'supply_info' || item.kind === 'branch_choice') return 'internal';
  return 'action';
}

function invalidAmount(payload: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(payload, 'amount')) return false;
  const amount = payload.amount;
  return typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0;
}

function isOwner(viewer: Viewer): boolean {
  return viewer.roles.includes('owner') || viewer.roles.includes('admin');
}

export class WorkInbox {
  private readonly items = new Map<string, WorkItem>();
  private seq = 0;

  create(input: NewWorkItem): WorkItem {
    const payload = input.payload ?? {};
    const item: WorkItem = {
      id: input.id ?? `wi_${++this.seq}`,
      tenantId: input.tenantId,
      kind: input.kind,
      renderer: input.renderer ?? DEFAULT_RENDERER[input.kind],
      projectId: input.projectId ?? null,
      assigneeUserId: input.assigneeUserId,
      payloadVersion: 1,
      payload,
      payloadHash: payloadHash(payload),
      status: 'open',
      decision: null,
      submitCount: 0,
      actionStatus: null,
      systemVerified: false,
      evidenceSource: null,
      waitingOn: input.waitingOn ?? null,
      draft: null,
      rows: (input.rows ?? []).map((row) => ({ ...row, executed: false })),
    };
    this.items.set(item.id, item);
    return this.view(item);
  }

  list(viewer: Viewer, options?: { exceptionsOnly?: boolean; projectId?: string }): WorkItem[] {
    return [...this.items.values()]
      .filter((item) => this.visible(item, viewer))
      .filter((item) => !options?.exceptionsOnly || item.kind === 'exception_ruling')
      .filter((item) => !options?.projectId || item.projectId === options.projectId)
      .map((item) => this.view(item));
  }

  decide(id: string, actorUserId: string, expectedVersion: number): { ok: boolean; reason?: string; item: WorkItem } {
    const item = this.require(id);
    if (item.actionStatus === 'outcome_unknown') {
      return { ok: false, reason: 'no_resubmit', item: this.view(item) };
    }
    if (item.status === 'decided' || item.status === 'closed' || item.decision) {
      return { ok: false, reason: 'conflict', item: this.view(item) };
    }
    if (expectedVersion !== item.payloadVersion) {
      return { ok: false, reason: 'version_conflict', item: this.view(item) };
    }
    if (invalidAmount(item.payload)) {
      return { ok: false, reason: 'invalid_amount', item: this.view(item) };
    }
    if (item.kind === 'action_approval') {
      const waiting = this.inheritConfirmedData(item);
      if (waiting) return { ok: false, reason: waiting, item: this.view(item) };
    }
    item.status = 'decided';
    item.decision = { by: actorUserId, payloadHash: item.payloadHash };
    item.submitCount += 1;
    return { ok: true, item: this.view(item) };
  }

  /** Changing the amount (or any payload field) retires the previous approval. */
  revise(id: string, patch: Record<string, unknown>): WorkItem {
    const item = this.require(id);
    item.payload = { ...item.payload, ...patch };
    item.payloadVersion += 1;
    item.payloadHash = payloadHash(item.payload);
    item.decision = null;
    item.status = 'withdrawn';
    item.actionStatus = null;
    if (item.kind === 'data_check') this.revokeDownstream(item.id);
    return this.view(item);
  }

  markOutcomeUnknown(id: string): WorkItem {
    const item = this.require(id);
    item.actionStatus = 'outcome_unknown';
    item.submitCount = Math.max(item.submitCount, 1);
    return this.view(item);
  }

  /** Unsaved edits block execution. They do not replace the approved payload. */
  stage(id: string, patch: Record<string, unknown>): WorkItem {
    const item = this.require(id);
    item.draft = { ...(item.draft ?? {}), ...patch };
    return this.view(item);
  }

  /** Records a branch choice. Reopening the item does not erase it. */
  chooseBranch(id: string, actorUserId: string, choice: string): WorkItem {
    const item = this.require(id);
    if (item.kind !== 'branch_choice') throw new Error('not_a_branch');
    item.payload = { ...item.payload, branch: choice };
    item.payloadHash = payloadHash(item.payload);
    item.decision = { by: actorUserId, payloadHash: item.payloadHash };
    item.status = 'decided';
    item.systemVerified = false;
    return this.view(item);
  }

  reopen(id: string): WorkItem {
    const item = this.require(id);
    item.status = 'open';
    return this.view(item);
  }

  /** A conflicting row cannot be selected. Clean rows can. */
  selectRow(id: string, rowId: string, selected: boolean): { ok: boolean; reason?: string; item: WorkItem } {
    const item = this.require(id);
    const row = item.rows.find((candidate) => candidate.id === rowId);
    if (!row) return { ok: false, reason: 'row_not_found', item: this.view(item) };
    if (selected && !row.clean) return { ok: false, reason: 'conflict_row', item: this.view(item) };
    if (row.executed) return { ok: false, reason: 'already_executed', item: this.view(item) };
    row.selected = selected;
    return { ok: true, item: this.view(item) };
  }

  executeBatch(id: string): WorkItem {
    const item = this.require(id);
    if (item.renderer !== 'batch_table') throw new Error('not_a_batch');
    if (!canExecute(item)) throw new Error('not_executable');
    for (const row of item.rows) {
      if (row.executed) continue;
      row.executed = row.selected && row.clean;
    }
    return this.view(item);
  }

  recordHumanEvidence(id: string, reference: string): WorkItem {
    const item = this.require(id);
    if (reference.trim() === '') throw new Error('evidence_required');
    item.evidenceSource = 'human_report';
    item.systemVerified = false;
    item.payload = { ...item.payload, humanReference: reference };
    if (item.waitingOn || item.kind === 'exception_ruling') return this.view(item);
    if (item.actionStatus !== 'outcome_unknown') item.status = 'decided';
    return this.view(item);
  }

  /** A note on an unknown result stays a note. It does not clear the system outcome. */
  annotate(id: string, note: string): WorkItem {
    const item = this.require(id);
    item.payload = { ...item.payload, note };
    return this.view(item);
  }

  /** Execution-time auth failure returns the item to the inbox and does not submit. */
  noteUnauthorized(id: string): WorkItem {
    const item = this.require(id);
    item.status = 'open';
    item.actionStatus = 'not_submitted';
    item.decision = null;
    return this.view(item);
  }

  /** A write approval cannot proceed on its own numbers. It copies the confirmed data check. */
  private inheritConfirmedData(item: WorkItem): string | null {
    const sourceId = item.payload.dataCheckId;
    if (typeof sourceId !== 'string' || sourceId === '') return null;
    const source = this.items.get(sourceId);
    if (!source || source.kind !== 'data_check' || source.status !== 'decided' || !source.decision) {
      return 'waiting_data_confirmation';
    }
    if (Object.prototype.hasOwnProperty.call(source.payload, 'amount')) {
      item.payload = { ...item.payload, amount: source.payload.amount };
      item.payloadHash = payloadHash(item.payload);
    }
    return null;
  }

  /** Revising confirmed data drops every approval that was bound to it. */
  private revokeDownstream(dataCheckId: string): void {
    for (const downstream of this.items.values()) {
      if (downstream.kind !== 'action_approval' || downstream.payload.dataCheckId !== dataCheckId) continue;
      downstream.decision = null;
      downstream.status = 'withdrawn';
      downstream.actionStatus = null;
    }
  }

  private visible(item: WorkItem, viewer: Viewer): boolean {
    if (viewer.projectScopes.length > 0 && item.projectId && !viewer.projectScopes.includes(item.projectId)) return false;
    if (isOwner(viewer)) return true;
    if (item.assigneeUserId === viewer.userId) return true;
    return viewer.roles.includes('reviewer') && item.kind === 'exception_ruling';
  }

  private require(id: string): WorkItem {
    const item = this.items.get(id);
    if (!item) throw new Error('work_item_not_found');
    return item;
  }

  private view(item: WorkItem): WorkItem {
    return {
      ...item,
      payload: { ...item.payload },
      decision: item.decision ? { ...item.decision } : null,
      rows: item.rows.map((row) => ({ ...row })),
      waitingOn: item.waitingOn,
      draft: item.draft ? { ...item.draft } : null,
      systemVerified: item.evidenceSource === 'human_report' ? false : item.systemVerified,
    };
  }
}
