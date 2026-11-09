/** Metadata-only audit projection. Source text, SQL, query arguments and credentials never enter these events. */
import type { Pool, PoolClient } from 'pg';
import type { AuditEntry, AuditSink } from '../audit/audit.js';
import { hash, type KnowledgeState } from './domain.js';
export interface AuditSnapshot { entries: Map<string, { action: string; fingerprint: string; version: string | null; detail: Record<string, unknown> }> }
export function auditSnapshot(state: KnowledgeState): AuditSnapshot {
  const entries: AuditSnapshot['entries'] = new Map();
  const add = (key: string, action: string, value: unknown, version: string | null, detail: Record<string, unknown>) => entries.set(key, { action, fingerprint: hash(JSON.stringify(value)), version, detail });
  for (const c of state.source.connections) add(`connection:${c.id}`, 'connection_changed', [c.status,c.scope,c.confirmedBy], null, { status:c.status,pluginId:c.pluginId });
  for (const [sourceId,c] of Object.entries(state.confirmations)) add(`confirmation:${sourceId}`, 'version_confirmation_changed', c, hash(c.version), { confirmed:true });
  for (const i of state.source.items.filter(i=>i.current)) add(`source:${i.id}`, 'source_changed', [i.status,i.version,i.contentHash,i.acl], hash(i.version), { status:i.status });
  for (const r of state.analyses) add(`analysis:${r.id}`, 'analysis_changed', [r.status,r.stage,r.error], null, { status:r.status,stage:r.stage });
  for (const j of state.parseJobs) add(`parse:${j.id}`, 'parse_changed', [j.status,j.error], hash(j.version), { status:j.status });
  for (const r of state.recommendations) add(`recommendation:${r.id}`, 'recommendation_changed', [r.name,r.description,r.evidence,r.humanLocked,r.deleted,r.proposedChange], null, { kind:r.kind,humanLocked:r.humanLocked,deleted:r.deleted });
  for (const t of state.queryTemplates) add(`template:${t.id}`, 'query_template_approved', t, hash(t.schemaVersion), { connectionId:t.connectionId });
  add('plugins','plugins_changed',state.disabledPlugins,null,{ disabled:state.disabledPlugins });
  return { entries };
}
export function auditDiff(before: AuditSnapshot, after: AuditSnapshot): Omit<AuditEntry,'tenantId'|'actor'>[] {
  const result: Omit<AuditEntry,'tenantId'|'actor'>[] = [];
  for (const [key,current] of after.entries) {
    const prior=before.entries.get(key); if (prior?.fingerprint===current.fingerprint) continue;
    result.push({action:`knowledge.${current.action}`,objectType:'knowledge',objectId:hash(key),versionRef:current.version,result:'ok',detail:current.detail});
  }
  for(const [key,prior] of before.entries) if(!after.entries.has(key)) result.push({action:'knowledge.reference_withdrawn',objectType:'knowledge',objectId:hash(key),versionRef:prior.version,result:'ok',detail:{}});
  return result;
}
export async function appendPgAudit(client: Pick<PoolClient,'query'>, entry: AuditEntry): Promise<void> {
  await client.query('INSERT INTO audit_log(tenant_id,actor,action,object_type,object_id,version_ref,result,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)', [entry.tenantId,entry.actor,entry.action,entry.objectType,entry.objectId,entry.versionRef??null,entry.result,JSON.stringify(entry.detail??{})]);
}
export class PgKnowledgeAudit implements AuditSink { constructor(private pool:Pool) {} append(entry:AuditEntry) {return appendPgAudit(this.pool,entry);} }
