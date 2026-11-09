import type { UserContext } from '@superagent/shared';
import { Pool, type PoolClient } from 'pg';
import { emptyState, itemSignature, positionedChunks, type Evidence, type KnowledgeState } from './domain.js';
import { appendPgAudit, auditDiff, auditSnapshot } from './audit.js';
import type { AuditEntry } from '../audit/audit.js';
export interface SearchHit extends Evidence { title: string; score: number }
export interface KnowledgeRepository {
  read(ctx: UserContext): Promise<KnowledgeState>;
  transact<T>(ctx: UserContext, change: (state: KnowledgeState) => T | Promise<T>): Promise<T>;
  search(ctx: UserContext, query: string, limit: number): Promise<SearchHit[]>;
}
interface IndexedChunk extends Evidence { title: string; principals: string[]; projectIds: string[] }
const normalized = (value: KnowledgeState): KnowledgeState => ({ ...emptyState(), ...value });
export function indexableChunks(state: KnowledgeState): IndexedChunk[] {
  const result: IndexedChunk[] = [], seen = new Set<string>();
  for (const item of state.source.items) {
    const conn = state.source.connections.find(c => c.id === item.connectionId), meta = state.connectionMeta[item.connectionId];
    if (!conn || !meta || conn.status !== 'confirmed' || state.disabledPlugins.includes(conn.pluginId) || !item.current || item.status !== 'parsed' || !item.acl || state.confirmations[item.id]?.signature !== itemSignature(state, item)) continue;
    for (const chunk of positionedChunks(state, item)) for (let offset = 0; offset < chunk.text.length; offset += 1040) {
      const end = Math.min(offset + 1200, chunk.text.length);
      const key = JSON.stringify([item.id, item.version, chunk.start + offset, chunk.start + end, chunk.locator]);
      if (seen.has(key)) continue; seen.add(key);
      result.push({ sourceId: item.id, version: item.version, start: chunk.start + offset, end: chunk.start + end, quote: chunk.text.slice(offset, end), locator: chunk.locator, title: item.title, principals: item.acl.filter(a => a.access === 'read').map(a => a.principal), projectIds: meta.projectIds });
    }
  }
  return result;
}
/** One tenant lock makes source invalidation and the search projection atomic across workers. */
export class PgKnowledgeRepository implements KnowledgeRepository {
  constructor(readonly pool: Pool) {}
  async read(ctx: UserContext): Promise<KnowledgeState> {
    const r = await this.pool.query<{ doc: KnowledgeState }>('SELECT doc FROM knowledge_tenants WHERE tenant_id=$1', [ctx.tenantId]); return r.rows[0] ? normalized(r.rows[0].doc) : emptyState();
  }
  async transact<T>(ctx: UserContext, change: (state: KnowledgeState) => T | Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO knowledge_tenants(tenant_id,doc) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [ctx.tenantId, JSON.stringify(emptyState())]);
      const result = await client.query<{ doc: KnowledgeState }>('SELECT doc FROM knowledge_tenants WHERE tenant_id=$1 FOR UPDATE', [ctx.tenantId]);
      const state = normalized(result.rows[0]!.doc), before = auditSnapshot(state), value = await change(state);
      for (const entry of auditDiff(before,auditSnapshot(state))) await appendPgAudit(client,{...entry,tenantId:ctx.tenantId,actor:ctx.userId});
      await client.query('UPDATE knowledge_tenants SET doc=$2::jsonb,updated_at=now() WHERE tenant_id=$1', [ctx.tenantId, JSON.stringify(state)]);
      await this.replaceIndex(client, ctx.tenantId, state); await client.query('COMMIT'); return value;
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  private async replaceIndex(client: PoolClient, tenantId: string, state: KnowledgeState) {
    // Bounded pilot corpus; incremental projection is needed before a large-scale rollout.
    await client.query('DELETE FROM knowledge_chunks WHERE tenant_id=$1', [tenantId]);
    for (const c of indexableChunks(state)) await client.query('INSERT INTO knowledge_chunks(tenant_id,source_id,source_version,start_offset,end_offset,content,locator,title,principals,project_ids) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [tenantId, c.sourceId, c.version, c.start, c.end, c.quote, c.locator, c.title, c.principals, c.projectIds]);
  }
  async search(ctx: UserContext, query: string, limit: number): Promise<SearchHit[]> {
    const escaped = query.replace(/[\\%_]/g, '\\$&');
    const r = await this.pool.query<{ source_id: string; source_version: string; start_offset: number; end_offset: number; content: string; locator: string; title: string; score: number }>(`SELECT source_id,source_version,start_offset,end_offset,content,locator,title,
      (ts_rank_cd(search_vector,plainto_tsquery('simple',$4))+similarity(content,$4))::float8 AS score
      FROM knowledge_chunks WHERE tenant_id=$1 AND $2=ANY(principals) AND project_ids <@ $3::text[]
      AND (search_vector @@ plainto_tsquery('simple',$4) OR content ILIKE $5 ESCAPE '\\' OR content % $4)
      ORDER BY score DESC,source_id,start_offset LIMIT $6`, [ctx.tenantId, ctx.userId, ctx.projectScopes, query, `%${escaped}%`, limit]);
    return r.rows.map(r => ({ sourceId: r.source_id, version: r.source_version, start: r.start_offset, end: r.end_offset, quote: r.content, locator: r.locator, title: r.title, score: r.score }));
  }
}
/** Explicit test/local adapter, never a production fallback. */
export class MemoryKnowledgeRepository implements KnowledgeRepository {
  private tenants = new Map<string, KnowledgeState>(); private pending: Promise<unknown> = Promise.resolve();
  readonly auditEntries: AuditEntry[] = [];
  async read(ctx: UserContext) { return structuredClone(this.tenants.get(ctx.tenantId) ?? emptyState()); }
  async transact<T>(ctx: UserContext, change: (state: KnowledgeState) => T | Promise<T>): Promise<T> {
    const work = this.pending.then(async () => { const state = await this.read(ctx), before=auditSnapshot(state), result = await change(state); this.tenants.set(ctx.tenantId, state); this.auditEntries.push(...auditDiff(before,auditSnapshot(state)).map(e=>({...e,tenantId:ctx.tenantId,actor:ctx.userId}))); return structuredClone(result); }); this.pending = work.catch(() => undefined); return work;
  }
  async search(ctx: UserContext, query: string, limit: number): Promise<SearchHit[]> {
    return indexableChunks(await this.read(ctx)).filter(c => c.principals.includes(ctx.userId) && c.projectIds.every(p => ctx.projectScopes.includes(p)) && c.quote.toLocaleLowerCase().includes(query.toLocaleLowerCase())).slice(0, limit).map(c => ({ ...c, score: 1 }));
  }
}
