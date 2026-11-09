import { createHash, randomUUID } from 'node:crypto';
import type { UserContext } from '@superagent/shared';
import { KnowledgeStore, type Connection, type Item, type Chunk } from './store.js';
import type { StoredQueryTemplate } from './database.js';
export class KnowledgeError extends Error { constructor(public code: string, message: string, public statusCode = 400) { super(message); } }
export interface Snapshot { connections: Connection[]; items: Item[]; chunks: Chunk[]; citations: [string, string[]][]; flagged: [string, string][] }
export interface Evidence { sourceId: string; version: string; start: number; end: number; locator: string; quote: string }
export interface Recommendation {
  id: string; key: string; kind: 'employee' | 'tool' | 'sop' | 'object' | 'relation'; name: string; description: string;
  relation?: { from: string; to: string; label: string };
  evidence: Evidence[]; humanLocked: boolean; deleted: boolean;
  proposedChange?: { name: string; description: string; evidence: Evidence[]; relation?: { from:string;to:string;label:string } };
}
export interface AnalysisRun { id: string; actor: UserContext; status: 'queued' | 'running' | 'completed' | 'failed' | 'stale' | 'outcome_unknown'; stage: 'parse' | 'extract' | 'recommend' | 'complete'; signature: string; createdAt: string; error: string | null }
export interface ConnectionMeta { name: string; audience: string[]; projectIds: string[] }
export interface Confirmation { version: string; signature: string; confirmedBy: string; confirmedAt: string }
export interface Upload { connectionId: string; name: string; text: string; version: string; audience: string[] }
export interface ParseJob {
  id: string; actor: UserContext; connectionId: string; name: string; mimeType: string; blobRef: string; version: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'outcome_unknown'; operationLocation: string | null;
  notBefore: number; leaseToken: string | null; leaseUntil: number; attempts: number; error: string | null;
}
export interface KnowledgeState {
  revision: number; source: Snapshot; connectionMeta: Record<string, ConnectionMeta>; confirmations: Record<string, Confirmation>;
  analyses: AnalysisRun[]; recommendations: Recommendation[]; uploads: Upload[]; disabledPlugins: string[]; parseJobs: ParseJob[]; queryTemplates: StoredQueryTemplate[];
}
export const emptyState = (): KnowledgeState => ({ revision: 0, source: { connections: [], items: [], chunks: [], citations: [], flagged: [] }, connectionMeta: {}, confirmations: {}, analyses: [], recommendations: [], uploads: [], disabledPlugins: [], parseJobs: [], queryTemplates: [] });
export const stamp = () => new Date().toISOString();
export const id = () => randomUUID();
export const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function hydrate(s: Snapshot): KnowledgeStore {
  const store = new KnowledgeStore(); store.connections = new Map(s.connections.map(c => [c.id, c])); store.items = new Map(s.items.map(i => [i.id, i])); store.chunks = s.chunks;
  store.citations = new Map(s.citations.map(([k, v]) => [k, new Set(v)])); store.flagged = new Map(s.flagged); return store;
}
export function snapshot(store: KnowledgeStore): Snapshot { return { connections: [...store.connections.values()], items: [...store.items.values()], chunks: store.chunks, citations: [...store.citations].map(([k, v]) => [k, [...v]]), flagged: [...store.flagged] }; }
export function requireManager(ctx: UserContext) { if (!ctx.roles.some(r => r === 'owner' || r === 'admin')) throw new KnowledgeError('forbidden', '需要企业负责人或管理员权限。', 403); }
export function sourceOf(state: KnowledgeState, sourceId: string): Item { const item = state.source.items.find(i => i.id === sourceId); if (!item) throw new KnowledgeError('not_found', '来源条目不存在。', 404); return item; }
export function itemSignature(state: KnowledgeState, item: Item): string {
  const conn = state.source.connections.find(c => c.id === item.connectionId);
  return hash(JSON.stringify([item.version, item.contentHash, item.acl, conn?.scope, state.connectionMeta[item.connectionId]?.projectIds]));
}
/** Role never bypasses source ACL or project intersection. Repository enforces tenant isolation. */
export function mayRead(state: KnowledgeState, ctx: UserContext, item: Item, confirmed = true): boolean {
  const conn = state.source.connections.find(c => c.id === item.connectionId), meta = state.connectionMeta[item.connectionId];
  if (!conn || !meta || conn.status !== 'confirmed' || state.disabledPlugins.includes(conn.pluginId) || !item.current || item.status !== 'parsed' || !item.acl?.some(a => a.access === 'read' && a.principal === ctx.userId) || !meta.projectIds.every(p => ctx.projectScopes.includes(p))) return false;
  return !confirmed || state.confirmations[item.id]?.signature === itemSignature(state, item);
}
export function signature(state: KnowledgeState, ctx: UserContext): string { return hash(JSON.stringify(state.source.items.filter(i => mayRead(state, ctx, i)).map(i => [i.id, itemSignature(state, i)]).sort())); }
export function invalidateAnalyses(state: KnowledgeState): void {
  state.revision++;
  for (const [key, c] of Object.entries(state.confirmations)) { const item = state.source.items.find(i => i.id === key); if (!item || !item.current || item.status !== 'parsed' || c.signature !== itemSignature(state, item)) delete state.confirmations[key]; }
  for (const run of state.analyses) if (run.signature !== signature(state, run.actor) && ['queued', 'running', 'completed'].includes(run.status)) run.status = 'stale';
}
export function confirmSource(state: KnowledgeState, ctx: UserContext, sourceId: string, version: string): void {
  requireManager(ctx); const item = sourceOf(state, sourceId);
  if (!mayRead(state, ctx, item, false)) throw new KnowledgeError('source_denied', '源权限未知、范围不足或连接不可读，确认不能覆盖源权限。', 403);
  if (item.version !== version) throw new KnowledgeError('version_changed', '来源版本已变化，请重新核对。', 409);
  state.confirmations[item.id] = { version, signature: itemSignature(state, item), confirmedBy: ctx.userId, confirmedAt: stamp() };
  Object.assign(item, { confirmedVersion: version }); invalidateAnalyses(state);
}
export function positionedChunks(state: KnowledgeState, item: Item): (Chunk & { start: number; end: number })[] {
  // Never invent offsets from adjacent chunks: blank lines and paragraph gaps must retain their source positions.
  return state.source.chunks.filter(c => c.itemId === item.id).flatMap(c => { const explicit = c as Chunk & { start?: number; end?: number }; const { start, end } = explicit; return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start! >= 0 && end! - start! === c.text.length ? [{ ...c, start: start!, end: end! }] : []; });
}
export function evidenceValid(state: KnowledgeState, ctx: UserContext, e: Evidence): boolean {
  const item = state.source.items.find(i => i.id === e.sourceId);
  if (!item || !mayRead(state, ctx, item) || item.version !== e.version || !Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end) || e.start < 0 || e.end <= e.start) return false;
  return positionedChunks(state, item).some(c => e.start >= c.start && e.end <= c.end && c.text.slice(e.start - c.start, e.end - c.start) === e.quote && c.locator === e.locator);
}
export function mergeRecommendations(state: KnowledgeState, ctx: UserContext, proposals: Omit<Recommendation, 'id' | 'humanLocked' | 'deleted'>[]): void {
  const objects = new Set(state.recommendations.filter(r=>r.kind==='object'&&!r.deleted&&r.evidence.every(e=>evidenceValid(state,ctx,e))).map(r=>r.key));
  for(const p of proposals) if(p.kind==='object'&&p.evidence.every(e=>evidenceValid(state,ctx,e))&&!state.recommendations.some(r=>r.kind==='object'&&r.key===p.key&&r.deleted)) objects.add(p.key);
  for (const p of proposals) {
    if (!p.key || !p.name || !p.evidence.length || !p.evidence.every(e => evidenceValid(state, ctx, e))) throw new KnowledgeError('unsupported_recommendation', '模型建议缺少当前可定位依据，不能生成草案。', 422);
    if(p.kind==='relation'&&(!p.relation||!objects.has(p.relation.from)||!objects.has(p.relation.to))) throw new KnowledgeError('unsupported_relation','关系必须引用当前有依据且未删除的业务对象草案。',422);
    const existing = state.recommendations.find(r => r.key === p.key && r.kind === p.kind);
    if (existing?.deleted) continue;
    if (existing?.humanLocked) { existing.proposedChange = { name: p.name, description: p.description, evidence: p.evidence, ...(p.relation?{relation:p.relation}:{}) }; continue; }
    if (existing) Object.assign(existing, p); else state.recommendations.push({ ...p, id: id(), humanLocked: false, deleted: false });
  }
}
