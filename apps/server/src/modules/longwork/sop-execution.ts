import { randomUUID } from 'node:crypto';
import type { MailSource } from './service.js';
import type { LongItem, MailExecutionLink, Store } from './store.js';

export interface ClaimedMailInput {
  tenantId: string; versionId: string; instanceId: string; eventId: string; startedBy: string; data: Record<string, unknown>;
}
export interface ClaimedMailRun {
  id: string; tenantId: string; versionId: string; instanceId: string;
  status: 'running' | 'waiting_human' | 'completed' | 'blocked' | 'outcome_unknown';
}
/** Installed by the execution owner. Both operations must use durable per-instance state, not a process cache. */
export interface MailSopConsumer {
  /** Rechecks the pinned version and current execution permission. A denial never starts or resumes a graph. */
  eligible(input: ClaimedMailInput): Promise<boolean>;
  start(input: ClaimedMailInput): Promise<ClaimedMailRun>;
  inspect(tenantId: string, instanceId: string): Promise<ClaimedMailRun | null>;
}
const reasons: Record<ClaimedMailRun['status'], string> = {
  running: '流程正在处理；运行状态不代表外部结果已核验。', waiting_human: '流程等待人工工作项；尚未批准的动作不会执行。',
  completed: '流程执行记录已结束；外部结果以各步骤的回读证据为准，仍待负责人核对。',
  blocked: '流程已阻塞，请核对关联执行记录；不会自动重建或重复写入。', outcome_unknown: '流程结果未知，保留同一执行；只允许授权后的回读核对。',
};
function bound(item: LongItem, source: MailSource | undefined, tenant: string): source is MailSource {
  return !!source && source.tenant === tenant && source.id === item.sourceId && source.sopId === item.sopId &&
    source.projectId === item.projectId && source.objectId === item.objectId && source.assignee === item.assignee && source.reviewer === item.reviewer;
}

/** A short durable lease avoids overlapping dispatch. The executor's unique instance row is the final write fence. */
export class MailSopBridge {
  constructor(private store: Store, private sources: readonly MailSource[], private consumer?: MailSopConsumer, private now = Date.now) {}

  async tick(tenant: string): Promise<void> {
    if (!this.consumer) return; // Honest waiting_runtime until the execution owner's adapter is installed.
    const ids = await this.store.change(tenant, s => s.items.filter(i => i.phase !== 'closed' && i.sopStart?.status === 'waiting_runtime' &&
      i.sopStart.instanceId && i.sopStart.versionId && i.sopExecution?.status !== 'completed')
      .sort((a, b) => Date.parse(a.sopExecution?.updatedAt ?? '1970-01-01') - Date.parse(b.sopExecution?.updatedAt ?? '1970-01-01'))
      .slice(0, 50).map(i => i.id));
    for (const id of ids) await this.consume(tenant, id);
  }

  private async consume(tenant: string, id: string): Promise<void> {
    const leaseOwner = randomUUID(); const now = this.now();
    const claim = await this.store.change(tenant, s => {
      const item = s.items.find(i => i.id === id); const source = this.sources.find(x => x.id === item?.sourceId && x.tenant === tenant);
      if (!item || item.phase === 'closed' || item.sopStart?.status !== 'waiting_runtime' || !bound(item, source, tenant) ||
        !item.sopStart.instanceId || !item.sopStart.versionId || !item.events.length || (item.sopExecution?.leaseUntil ?? 0) > now) return null;
      if (!item.sopInput || !item.sopMail || item.sopMail.id !== item.events[0]) {
        item.sopExecution = { status: 'blocked', reason: '原事项未保存起始参数，等待负责人核对；未启动流程。', updatedAt: new Date(now).toISOString() }; return null;
      }
      const previous = item.sopExecution;
      item.sopExecution = { ...previous, status: previous?.runId ? previous.status : 'dispatching',
        reason: previous?.runId ? previous.reason : '正在关联固定流程实例，尚未确认执行结果。', updatedAt: new Date(now).toISOString(), leaseOwner, leaseUntil: now + 60000 };
      return { runId: previous?.runId, input: { tenantId: tenant, versionId: item.sopStart.versionId, instanceId: item.sopStart.instanceId,
        eventId: item.events[0]!, startedBy: source.reviewer, data: { ...structuredClone(item.sopInput),
          mail: structuredClone(item.sopMail),
          longItem: { id: item.id, sourceId: item.sourceId, projectId: item.projectId, objectId: item.objectId } } } satisfies ClaimedMailInput };
    });
    if (!claim) return;
    let result: Omit<MailExecutionLink, 'updatedAt'> = { status: 'waiting_runtime', reason: '流程或执行权限当前不可用；保留固定实例，未启动流程。' };
    try {
      // Inspect first after every restart, including an expired dispatch lease. Never advance an existing run.
      let run = await this.consumer!.inspect(tenant, claim.input.instanceId);
      if (!run && claim.runId) {
        result = { runId: claim.runId, status: 'blocked', reason: '原执行记录暂不可读，保留关联等待核对；不会重新启动流程。' };
      } else if (!run) {
        if (!await this.consumer!.eligible(claim.input)) {
          result = { status: 'waiting_runtime', reason: '流程或执行权限当前不可用；保留固定实例，未启动流程。' };
        } else {
          // Recheck the case/source immediately before crossing the execution boundary.
          const allowed = await this.store.change(tenant, s => {
            const item = s.items.find(i => i.id === id); const source = this.sources.find(x => x.id === item?.sourceId && x.tenant === tenant);
            return !!item && item.phase !== 'closed' && item.sopStart?.status === 'waiting_runtime' && item.sopExecution?.leaseOwner === leaseOwner && bound(item, source, tenant);
          });
          if (allowed) run = await this.consumer!.start(claim.input);
          else result = { status: 'blocked', reason: '原事项或来源已改变，未启动流程；等待负责人核对。' };
        }
      }
      if (run) {
        if (!run.id || run.tenantId !== tenant || run.instanceId !== claim.input.instanceId || run.versionId !== claim.input.versionId || !Object.hasOwn(reasons, run.status)) throw Error('invalid_execution_link');
        result = { runId: run.id, status: run.status, reason: reasons[run.status] };
      }
    } catch {
      // A failed reply does not prove the executor failed. Next tick inspects the same instance before any start.
      result = { status: 'waiting_runtime', reason: '执行关联暂不可用；保留同一实例，下一次先核对已有执行，不重复写入。' };
    }
    await this.store.change(tenant, s => {
      const item = s.items.find(i => i.id === id);
      if (!item || item.sopExecution?.leaseOwner !== leaseOwner) return;
      // Closing/revoking during a call does not erase a possibly-started run's identity.
      item.sopExecution = { ...result, ...(result.runId ? {} : item.sopExecution.runId ? { runId: item.sopExecution.runId } : {}), updatedAt: new Date(this.now()).toISOString() };
    });
  }
}
