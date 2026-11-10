import type { UserContext } from '@superagent/shared';
import { canAccessProject } from '../../auth.js';
import type { WorkItem } from '../humanwork/work-items.js';
import type { LongInboxItem } from './inbox.js';
import type { Action, State } from './store.js';

type Base = (id: string, project: string, assignee: string, payload: Record<string, unknown>) => WorkItem;
export function batchCollectionInbox(state: State, user: UserContext, query: { project?: string }, base: Base): LongInboxItem[] {
  const owner = user.roles.some(r => r === 'owner' || r === 'admin');
  const visible = (project: string) => canAccessProject(user, project) && (!query.project || project === query.project);
  const items: LongInboxItem[] = [];
  const groups = new Map<string, Action[]>();
  for (const a of state.actions) {
    if (!visible(a.projectId) || a.payload.kind === 'ambiguous_incoming') continue;
    if (!owner && a.assigneeUserId !== user.userId) continue;
    const rows = groups.get(a.batchId) ?? []; rows.push(a); groups.set(a.batchId, rows);
  }
  for (const [id, rows] of groups) {
    const priority = (a: Action) => a.clean === false || ['failed', 'unknown', 'executing'].includes(a.status) ? 0 : a.status === 'succeeded' ? 2 : 1;
    rows.sort((a, b) => priority(a) - priority(b) || a.rowId.localeCompare(b.rowId));
    const projectId = rows[0]!.projectId;
    const payload = { title: rows.every(a => a.payload.kind === 'collection_request') ? `发送收集请求 · ${id.slice('collection:'.length)}` : rows.every(a => a.payload.kind === 'reminder') ? '跟进请求待批准' : `批量动作 · ${id}`,
      why: '批准绑定每一行的内容；只提交勾选且已批准的行。结果未知只能回读，继续不会重复成功行。',
      actionRows: rows.map(a => ({ id: a.rowId, hash: a.hash, clean: a.clean !== false, selected: a.selected ?? (!!a.approval && a.status === 'approved'), state: a.status,
        data: a.payload, evidence: a.evidence, approvedBy: a.approval?.by })),
      hasExceptions: rows.some(a => a.clean === false || ['unknown', 'failed'].includes(a.status)),
    };
    const item = base(`long-batch:${id}`, projectId, rows[0]!.assigneeUserId ?? '', payload);
    items.push({ ...item, kind: 'action_approval', renderer: 'batch_table', status: rows.every(a => a.status === 'succeeded') ? 'closed' : 'open',
      canAct: rows.every(a => a.assigneeUserId === user.userId),
      actionStatus: rows.some(a => a.status === 'unknown') ? 'outcome_unknown' : null,
      rows: rows.map(a => ({ id: a.rowId, clean: a.clean !== false, selected: !!a.selected, executed: a.status === 'succeeded' })),
      longwork: { type: 'batch', id, projectId } });
  }
  for (const c of state.collections) {
    if (!visible(c.projectId)) continue;
    const requests = state.actions.filter(a => a.batchId === `collection:${c.id}` && a.projectId === c.projectId && a.payload.kind === 'collection_request');
    const waiting = c.recipients.filter(p => !Object.hasOwn(c.replies, p));
    if (owner || c.assigneeUserId === user.userId) {
      const payload = { title: `收集汇总 · ${c.id}`, due: c.deadline, collectionState: c.status, recipients: c.recipients, responses: c.replies,
        missing: c.status === 'summarized' ? c.missing : waiting,
        verifiedSends: requests.filter(a => a.status === 'succeeded').length, requestCount: requests.length,
        why: '创建不等于请求已发送；发送结果与人工回复分别记录。到截止时间后汇总固定，人工回复不等于系统核验。' };
      const item = base(`long-collection:${c.id}`, c.projectId, c.assigneeUserId ?? '', payload);
      items.push({ ...item, kind: 'supply_info', status: c.status === 'summarized' ? 'closed' : 'open', waitingOn: c.status === 'open' ? '收集截止时间' : null,
        canAct: false, longwork: { type: 'collection', id: c.id, projectId: c.projectId } });
    }
    if (c.recipients.includes(user.userId)) {
      const response = Object.hasOwn(c.replies, user.userId) ? c.replies[user.userId] : undefined;
      const payload = { title: `我的收集回复 · ${c.id}`, due: c.deadline, collectionState: c.status, myResponse: response ?? '',
        why: '回复交给本次收集负责人，其他参与人看不到内容；这是人工证据，未经系统核验。' };
      const item = base(`long-response:${c.id}:${user.userId}`, c.projectId, user.userId, payload);
      items.push({ ...item, kind: 'supply_info', status: c.status === 'summarized' ? 'closed' : response ? 'decided' : 'open',
        evidenceSource: response ? 'human_report' : null, canAct: c.status === 'open' && Date.now() < Date.parse(c.deadline),
        longwork: { type: 'collection-response', id: c.id, projectId: c.projectId } });
    }
  }
  return items;
}
