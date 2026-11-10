import type { UserContext } from '@superagent/shared';
import { canAccessProject } from '../../auth.js';
import type { WorkItem } from '../humanwork/work-items.js';
import { payloadHash } from '../gateway/gateway.js';
import type { LongWork } from './service.js';

export type LongInboxItem = WorkItem & { canAct: boolean; longwork: { type: 'match' | 'waiting'; id: string; projectId: string } };
export async function longInbox(work: LongWork, user: UserContext, query: { project?: string; exceptions?: string }): Promise<LongInboxItem[]> {
  const state = await work.snapshot(user.tenantId);
  const owner = user.roles.some(r => r === 'owner' || r === 'admin');
  const visible = (project: string) => canAccessProject(user, project) && (!query.project || project === query.project);
  const base = (id: string, projectId: string, assigneeUserId: string, payload: Record<string, unknown>): WorkItem => ({
    id, tenantId: user.tenantId, projectId, assigneeUserId, kind: 'supply_info', renderer: 'issue_list', payload,
    payloadVersion: 1, payloadHash: payloadHash(payload), status: 'open', decision: null, submitCount: 0,
    actionStatus: null, systemVerified: false, evidenceSource: null, waitingOn: null, draft: null, rows: [],
  });
  const exceptions: LongInboxItem[] = state.exceptions.filter(e => visible(e.projectId) && (owner || user.userId === e.assignee || user.roles.includes('reviewer'))).map(e => {
    const incoming = state.actions.find(a => a.batchId === e.id)?.payload.mail;
    const item = base(`long-match:${e.id}`, e.projectId, e.assignee, {
      title: '来件需要确认原事项', reason: '线程改变或存在多个候选事项，请核对证据后选择。', original: incoming,
      candidates: e.candidates.map(id => { const i = state.items.find(x => x.id === id); return { id, object: i?.objectId, person: i?.person, thread: i?.threadId }; }),
      resolvedTo: e.resolvedTo, resolutionKind: e.resolutionKind ?? 'existing',
    });
    return { ...item, kind: 'exception_ruling', status: e.resolvedTo ? 'closed' : 'open',
      canAct: !e.resolvedTo && (owner || user.roles.includes('reviewer')) && e.assignee === user.userId,
      longwork: { type: 'match', id: e.id, projectId: e.projectId } };
  });
  if (query.exceptions === '1') return exceptions;
  const waiting: LongInboxItem[] = state.items.filter(i => visible(i.projectId) && (owner || i.assignee === user.userId)).map(i => {
    const item = base(`long-item:${i.id}`, i.projectId, i.assignee, { title: `长事项 · ${i.objectId}`, due: i.dueAt,
      why: i.phase === 'replied' ? '来件已并回同一事项，等待负责人核对；这不是系统验收完成。' : '阶段只表示跟进计划；发送是否成功请核对独立动作记录。',
      phase: i.phase, original: i.original, replies: i.replies, originalItemId: i.id, dateRule: `${i.dateRuleId}@${i.dateRuleVersion}`,
      ...(i.registrationEvidence ? { registrationEvidence: i.registrationEvidence, evidenceSource: '人工登记，未经系统核验' } : {}) });
    return { ...item, status: i.phase === 'closed' ? 'closed' : 'open', waitingOn: ['closed', 'replied'].includes(i.phase) ? null : i.person,
      canAct: i.assignee === user.userId && i.phase !== 'closed', longwork: { type: 'waiting', id: i.id, projectId: i.projectId } };
  });
  return [...exceptions, ...waiting];
}
