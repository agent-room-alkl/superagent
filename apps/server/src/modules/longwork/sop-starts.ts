import { randomUUID } from 'node:crypto';
import { claimSopEvent, loadPublishedVersion, type Queryable } from '../sop/pg-sop.js';
import { sopEventKey } from '../sop/sop.js';
import type { MailSource } from './service.js';
import type { LongItem, PrepareSop, SopStartLink } from './store.js';

interface Row { id: string; item_id: string; status: SopStartLink['status']; version_id: string | null; instance_id: string | null; reason: string }
const WAITING_RUNTIME = '流程实例与固定版本已登记，等待执行处理器；尚未运行流程图或执行外部动作。';
const link = (r: Row): SopStartLink => ({ requestId: r.id, status: r.status, ...(r.version_id ? { versionId: r.version_id } : {}),
  ...(r.instance_id ? { instanceId: r.instance_id } : {}), reason: r.reason });
/** Encode the two untrusted/string components before using the existing SOP event-key format. */
export const mailSopEvent = (sourceId: string, eventId: string) => ({ source: `mail:${Buffer.from(sourceId).toString('base64url')}`, eventId: Buffer.from(eventId).toString('base64url') });

async function register(db: Queryable, tenant: string, item: LongItem, source?: MailSource): Promise<SopStartLink> {
  const eventId = item.events[0]!;
  await db.query(`INSERT INTO longwork_sop_starts(id,tenant_id,source_id,event_id,sop_id,item_id,project_id,status,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,'waiting_publication','流程尚未发布，起始请求保留，未执行外部动作。')
    ON CONFLICT(tenant_id,source_id,event_id,sop_id) DO NOTHING`, [randomUUID(), tenant, item.sourceId, eventId, item.sopId, item.id, item.projectId]);
  const { rows } = await db.query<Row>(`SELECT id,item_id,status,version_id,instance_id,reason FROM longwork_sop_starts
    WHERE tenant_id=$1 AND source_id=$2 AND event_id=$3 AND sop_id=$4 FOR UPDATE`, [tenant, item.sourceId, eventId, item.sopId]);
  const row = rows[0]!;
  if (row.item_id !== item.id) return { status: 'blocked_claim', reason: '同一邮件已关联其他原事项，等待人工核对；未执行外部动作。' };
  if (row.status === 'blocked_claim' || row.status === 'cancelled') return link(row);
  const update = async (status: SopStartLink['status'], reason: string, versionId: string | null = row.version_id, instanceId: string | null = row.instance_id) => {
    await db.query(`UPDATE longwork_sop_starts SET status=$2,reason=$3,version_id=$4,instance_id=$5,updated_at=now() WHERE id=$1`, [row.id, status, reason, versionId, instanceId]);
    return link({ ...row, status, reason, version_id: versionId, instance_id: instanceId });
  };
  if (!source || source.tenant !== tenant || source.projectId !== item.projectId || source.objectId !== item.objectId || source.sopId !== item.sopId || source.assignee !== item.assignee)
    return update('blocked_source', '来源或业务对象绑定已变，起始请求保留，等待重新确认。');
  if (row.version_id && row.instance_id) return row.status === 'waiting_runtime' ? link(row) : update('waiting_runtime', WAITING_RUNTIME);
  const version = await loadPublishedVersion(db, item.sopId);
  if (!version || !version.report?.ok || version.validatedRevision !== version.revision)
    return update('waiting_publication', '流程尚未发布或校验已失效，起始请求保留，未执行外部动作。');
  if (version.definition.employeeStatus === 'paused') return update('paused', '流程员工已暂停，原起始请求继续等待。');
  const event = mailSopEvent(item.sourceId, eventId);
  const claimed = await claimSopEvent(db, { tenantId: tenant, ...event, sopId: item.sopId });
  if (!claimed) return update('blocked_claim', 'SOP事件已被其他处理器领取，保留原事项等待核对；未重复启动。');
  const instanceId = `mail_${randomUUID()}`;
  await db.query(`INSERT INTO sop_instances(id,tenant_id,sop_id,sop_version_id,version_number,event_key,status)
    VALUES($1,$2,$3,$4,$5,$6,'running')`, [instanceId, tenant, item.sopId, version.id, version.number,
    sopEventKey(tenant, event.source, event.eventId, item.sopId)]);
  return update('waiting_runtime', WAITING_RUNTIME, version.id, instanceId);
}

/** SQL only, invoked inside PgLongWorkStore's transaction. No network call or business connector is used here. */
export function prepareMailSopStarts(sources: readonly MailSource[]): PrepareSop {
  return async (db, tenant, state) => {
    for (const item of state.items) {
      if (item.phase === 'closed' && item.sopStart?.requestId && item.sopStart.status !== 'cancelled') {
        await db.query(`UPDATE longwork_sop_starts SET status='cancelled',reason=$2,updated_at=now() WHERE id=$1`,
          [item.sopStart.requestId, '原事项已关闭，流程起始请求已取消；未执行外部动作。']);
        if (item.sopStart.instanceId) {
          await db.query("UPDATE sop_instances SET status='skipped' WHERE id=$1 AND tenant_id=$2 AND status='running'", [item.sopStart.instanceId, tenant]);
          await db.query("UPDATE sop_events SET disposition='skipped' WHERE event_key=(SELECT event_key FROM sop_instances WHERE id=$1 AND tenant_id=$2)", [item.sopStart.instanceId, tenant]);
        }
        item.sopStart = { ...item.sopStart, status: 'cancelled', reason: '原事项已关闭，流程起始请求已取消；未执行外部动作。' };
      }
      if (!item.events.length || item.phase === 'closed' || item.sopStart?.status === 'blocked_claim' || item.sopStart?.status === 'cancelled') continue;
      const source = sources.find(s => s.id === item.sourceId && s.tenant === tenant);
      if (item.sopStart?.status === 'waiting_runtime' && source && source.projectId === item.projectId && source.objectId === item.objectId && source.sopId === item.sopId && source.assignee === item.assignee) continue;
      item.sopStart = await register(db, tenant, item, source);
    }
  };
}
