import type { KnowledgeSourcePlugin, UserContext } from '@superagent/shared';
import { confirmSource, evidenceValid, hash, hydrate, id, invalidateAnalyses, KnowledgeError, mayRead, positionedChunks, pluginInstalled, selectedItem, requireManager, signature, snapshot, stamp, type KnowledgeState, type Evidence } from './domain.js';
import { sourceScope, type SourceResource } from './sources.js';
import type { Item } from './store.js';
import type { AuditSink } from '../audit/audit.js';
import type { KnowledgeRepository, SearchHit } from './repository.js';
import { syncConnection } from './sync.js';
import { createLocalFilePlugin } from './plugins/local-file.js';
import type { AnalysisModel } from '../analysis/service.js';
import { queueBinaryUpload, type BinaryDeps } from './binary.js';
import type { DatabaseGateway } from './database.js';
export interface KnowledgeDeps {
  repo: KnowledgeRepository;
  plugins?: Record<string, KnowledgeSourcePlugin>;
  sourceResources?: SourceResource[];
  model?: AnalysisModel;
  enqueue?: (ctx: UserContext, runId: string) => Promise<void>;
  binary?: BinaryDeps;
  database?: DatabaseGateway;
  close?: () => Promise<void>;
  audit?: AuditSink;
}
export const MANIFESTS = [
  { id: 'local-file', name: '本地文件', capabilities: ['文件导入', '版本与行定位'] },
  { id: 'database', name: '只读数据库', capabilities: ['结构知识', '受控实时查询'] },
  { id: 'email', name: '企业邮件', capabilities: ['指定邮箱', '增量同步'] },
  { id: 'sharepoint', name: 'SharePoint', capabilities: ['资料库范围', '源权限同步'] },
];
function bounded(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new KnowledgeError('invalid_input', `${label}无效。`); return value;
}
function strings(value: unknown, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 100 || value.some(x => typeof x !== 'string' || !x || x.length > 200)) throw new KnowledgeError('invalid_input', '权限范围无效。'); return [...new Set(value)];
}
export class KnowledgeService {
  constructor(readonly deps: KnowledgeDeps) {}
  private allowed(state: KnowledgeState, ctx: UserContext, item: Item, confirmed = true): boolean {
    if (!mayRead(state, ctx, item, confirmed)) return false;
    const conn = state.source.connections.find(c => c.id === item.connectionId)!;
    if (conn.pluginId === 'email' || conn.pluginId === 'sharepoint') { try { sourceScope(this.deps.sourceResources ?? [], ctx, conn.pluginId, conn.scope, state.connectionMeta[conn.id]!.audience); return true; } catch { return false; } }
    if (conn.pluginId !== 'database') return true;
    try { return !!this.deps.database?.scope(ctx, conn.scope); } catch { return false; }
  }
  private valid(state: KnowledgeState, ctx: UserContext, evidence: Evidence): boolean {
    const item = state.source.items.find(i => i.id === evidence.sourceId);
    return !!item && this.allowed(state, ctx, item) && evidenceValid(state, ctx, evidence);
  }
  private connectionAllowed(state: KnowledgeState, ctx: UserContext, connectionId: string): boolean {
    const conn = state.source.connections.find(c => c.id === connectionId), meta = state.connectionMeta[connectionId];
    if (!conn || !meta?.audience.includes(ctx.userId) || !meta.projectIds.every(p => ctx.projectScopes.includes(p))) return false;
    if (conn.pluginId === 'email' || conn.pluginId === 'sharepoint') { try { sourceScope(this.deps.sourceResources ?? [], ctx, conn.pluginId, conn.scope, state.connectionMeta[conn.id]!.audience); return true; } catch { return false; } }
    if (conn.pluginId !== 'database') return true;
    try { return !!this.deps.database?.scope(ctx, conn.scope); } catch { return false; }
  }
  private plugin(state: KnowledgeState, pluginId: string): KnowledgeSourcePlugin {
    if (state.disabledPlugins.includes(pluginId)) throw new KnowledgeError('plugin_disabled', '知识源插件已暂停。', 409);
    if (pluginId === 'local-file') {
      const files = new Map<string, { name: string; bytes: Uint8Array; version: string; audience: string[] }[]>();
      for (const u of state.uploads) files.set(u.connectionId, [...files.get(u.connectionId) ?? [], { ...u, bytes: Buffer.from(u.text) }]);
      return createLocalFilePlugin(files);
    }
    if (pluginId !== 'local-file' && !pluginInstalled(state, pluginId)) throw new KnowledgeError('plugin_not_installed', '请先安装知识源插件。', 409);
    if (pluginId === 'database') { if (this.deps.database) return this.deps.database.plugin; throw new KnowledgeError('connector_not_configured', '需要由管理员配置独立只读数据库账号与授权视图。', 503); }
    const plugin = this.deps.plugins?.[pluginId];
    if (!plugin) throw new KnowledgeError('connector_not_configured', '此来源需要独立配置连接凭据与只读授权。模型 API Key 不能代替来源授权。', 503); return plugin;
  }
  async overview(ctx: UserContext) {
    const s = await this.deps.repo.read(ctx);
    const items = s.source.items.filter(i => this.allowed(s, ctx, i, false));
    const recs = s.recommendations.filter(r => !r.deleted).flatMap(r => {
      const valid = r.origin === 'manual' || r.evidence.length > 0 && r.evidence.every(e => this.valid(s, ctx, e));
      const identityAllowed = r.humanLocked && r.evidence.length > 0 && r.evidence.every(e => {
        const old = s.source.items.find(i => i.id === e.sourceId);
        const current = old && s.source.items.find(i => i.current && i.connectionId === old.connectionId && i.externalId === old.externalId);
        return !!current && this.allowed(s, ctx, current, false);
      });
      if (!valid && !identityAllowed) return [];
      return [{ ...r, stale: !valid, evidence: valid ? r.evidence : [], proposedChange: r.proposedChange?.evidence.every(e => this.valid(s, ctx, e)) ? r.proposedChange : undefined }];
    });
    const objectKeys=new Set(recs.filter(r=>r.kind==='object').map(r=>r.key));
    const visibleRecs=recs.filter(r=>r.kind!=='relation'||r.relation&&objectKeys.has(r.relation.from)&&objectKeys.has(r.relation.to));
    return {
      spaceName: s.spaceName,
      sourceResources: (this.deps.sourceResources ?? []).filter(r => r.audience.includes(ctx.userId) && r.projectIds.every(p => ctx.projectScopes.includes(p))).map(({ audience: _, ...r }) => r),
      plugins: MANIFESTS.map(m => ({ ...m, installed: pluginInstalled(s, m.id), builtIn: m.id === 'local-file', enabled: pluginInstalled(s,m.id) && !s.disabledPlugins.includes(m.id), configured: m.id === 'local-file' || (m.id === 'database' && !!this.deps.database?.list(ctx).length) || !!this.deps.plugins?.[m.id] })),
      databaseResources: this.deps.database?.list(ctx) ?? [],
      connections: s.source.connections.filter(c => this.connectionAllowed(s, ctx, c.id)).map(c => ({ id: c.id, name: s.connectionMeta[c.id]!.name, pluginId: c.pluginId, status: c.status, scope: c.scope })),
      items: items.map(i => ({ id: hash(i.id), title: i.title, version: i.version, status: i.status, confirmed: this.allowed(s, ctx, i), locator: i.locator })),
      analyses: s.analyses.filter(r => r.actor.userId === ctx.userId).map(({ actor: _, ...run }) => run), recommendations: visibleRecs,
      canConfirm: ctx.roles.some(role => role === 'owner' || role === 'admin'),
      parseJobs: s.parseJobs.filter(j => j.actor.userId === ctx.userId && s.connectionMeta[j.connectionId]?.audience.includes(ctx.userId) && s.connectionMeta[j.connectionId]!.projectIds.every(p => ctx.projectScopes.includes(p))).map(j => ({ id: j.id, name: j.name, status: j.status, error: j.error })),
    };
  }
  async createConnection(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const name = bounded(input.name, 160, '连接名称'), pluginId = bounded(input.pluginId, 80, '插件');
    if (!MANIFESTS.some(m => m.id === pluginId)) throw new KnowledgeError('unknown_plugin', '知识源插件不存在。');
    const audience = strings(input.audience, [ctx.userId]), projectIds = strings(input.projectIds);
    if (!audience.includes(ctx.userId) || !projectIds.every(p => ctx.projectScopes.includes(p))) throw new KnowledgeError('scope_denied', '连接不能扩大当前账号的权限范围。', 403);
    if (input.credentialRef != null || input.effect !== undefined && input.effect !== 'read') throw new KnowledgeError('invalid_scope', '仅允许只读范围；不能在此提交凭据引用或写入效果。');
    if (pluginId !== 'local-file' && input.readOnlyAcknowledged !== true) throw new KnowledgeError('read_only_acknowledgement_required', '请先核对范围并确认独立只读授权。');
    const scope = input.scope ?? {};
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || JSON.stringify(scope).length > 8000) throw new KnowledgeError('invalid_scope', '来源范围无效。');
    if ('selectedExternalIds' in scope || ('effect' in scope && scope.effect !== 'read')) throw new KnowledgeError('invalid_scope', '来源范围不能包含导入选择或写入效果。');
    // Credential values are never accepted here; connector secrets are provisioned separately in Key Vault.
    if (/password|secret|token|api.?key|connection.?string/i.test(JSON.stringify(scope))) throw new KnowledgeError('secret_not_allowed', '来源范围中不能保存凭据。');
    if (pluginId === 'database' && Object.keys(scope).some(key => key !== 'resourceId')) throw new KnowledgeError('scope_denied', '数据库表、列、行数及项目范围由管理员的只读资源定义。', 403);
    return this.deps.repo.transact(ctx, async s => {
      this.plugin(s, pluginId);
      const effective: Record<string, unknown> = pluginId === 'database' ? { ...this.deps.database!.scope(ctx, { ...scope as Record<string, unknown>, audience }) } : pluginId === 'email' || pluginId === 'sharepoint' ? sourceScope(this.deps.sourceResources ?? [], ctx, pluginId, scope as Record<string, unknown>, audience) : scope as Record<string, unknown>;
      if (pluginId === 'email' || pluginId === 'sharepoint') effective.selectedExternalIds = [];
      const conn = { id: id(), pluginId, scope: effective, credentialRef: null, status: 'draft' as const, cursor: null, confirmedBy: null };
      s.source.connections.push(conn); s.connectionMeta[conn.id] = { name, audience, projectIds: [...new Set([...projectIds, ...((effective.projectIds as string[] | undefined) ?? [])])] }; return { ...conn, name };
    });
  }
  async confirmConnection(ctx: UserContext, connectionId: string) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, async s => {
      const conn = s.source.connections.find(c => c.id === connectionId);
      if (!conn || !this.connectionAllowed(s, ctx, connectionId)) throw new KnowledgeError('not_found', '来源连接不存在。', 404);
      const test = await this.plugin(s, conn.pluginId).testConnection({ connectionId, scope: conn.scope, credentialRef: conn.credentialRef });
      if (!test.ok) throw new KnowledgeError('connection_test_failed', '来源连接测试未通过。', 409);
      conn.status = 'confirmed'; conn.confirmedBy = ctx.userId; invalidateAnalyses(s); return { id: conn.id, status: conn.status };
    });
  }
  private scopedPlugin(state: KnowledgeState, pluginId: string, ctx: UserContext): KnowledgeSourcePlugin {
    const plugin = this.plugin(state, pluginId);
    return { ...plugin,
      async listItems(cfg, cursor) { const batch = await plugin.listItems(cfg, cursor); return { ...batch, items: batch.items.filter(ref => selectedItem(cfg.scope, ref.externalId)) }; },
      async getAcl(cfg, ref) {
        const acl = await plugin.getAcl?.(cfg, ref);
        // Re-evaluate at the body-read boundary: a preview grant may have been revoked meanwhile.
        return acl?.status === 'known' && acl.entries.some(e => e.principal === ctx.userId && e.access === 'read') ? acl : { status: 'unknown', reason: 'sync actor lacks current source permission' };
      },
    };
  }
  private async checkLiveAcl(state: KnowledgeState, ctx: UserContext, item: Item) {
    const conn = state.source.connections.find(c => c.id === item.connectionId)!;
    if (conn.pluginId === 'local-file') return;
    const acl = await this.plugin(state, conn.pluginId).getAcl?.({ connectionId: conn.id, scope: conn.scope, credentialRef: conn.credentialRef }, { externalId: item.externalId, version: item.version, title: item.title, locator: item.locator, change: 'upsert' });
    if (acl?.status !== 'known' || !acl.entries.some(e => e.principal === ctx.userId && e.access === 'read')) throw new KnowledgeError('source_denied', '来源权限已变化，不能确认或读取当前资料。', 403);
  }
  private async sourcePreview(state: KnowledgeState, ctx: UserContext, connectionId: string) {
    const conn = state.source.connections.find(c => c.id === connectionId);
    if (!conn || !this.connectionAllowed(state, ctx, connectionId) || !['email','sharepoint'].includes(conn.pluginId)) throw new KnowledgeError('source_denied', '当前来源范围不可预览。', 403);
    const plugin = this.plugin(state, conn.pluginId), cfg = { connectionId, scope: conn.scope, credentialRef: conn.credentialRef };
    const batch = await plugin.listItems(cfg, undefined);
    const eligible: { id: string; externalId: string; title: string; version: string; locator: string; selected: boolean }[] = [];
    let blocked = 0;
    if (batch.items.length > 1000) throw new KnowledgeError('preview_limit', '资料超过预览上限，请缩小授权范围。', 409);
    for (const ref of batch.items) {
      if (ref.change === 'deleted' || ref.change === 'access_revoked') { blocked++; continue; }
      const acl = await plugin.getAcl?.(cfg, ref);
      if (acl?.status !== 'known' || !acl.entries.some(e => e.principal === ctx.userId && e.access === 'read')) { blocked++; continue; }
      eligible.push({ id: hash(JSON.stringify([connectionId, ref.externalId, ref.version])), externalId: ref.externalId, title: ref.title, version: ref.version, locator: ref.locator, selected: selectedItem(conn.scope, ref.externalId) });
    }
    return { conn, eligible, blocked };
  }
  async previewConnection(ctx: UserContext, connectionId: string) {
    const state = await this.deps.repo.read(ctx), { conn, eligible, blocked } = await this.sourcePreview(state, ctx, connectionId);
    return { connectionId, name: state.connectionMeta[connectionId]!.name, pluginId: conn.pluginId, status: conn.status, scope: conn.scope, items: eligible.map(({externalId: _, ...item}) => item), blocked };
  }
  async importSelection(ctx: UserContext, connectionId: string, input: Record<string, unknown>) {
    requireManager(ctx); const ids = strings(input.ids);
    if (!ids.length) throw new KnowledgeError('invalid_selection', '请选择有权限的资料。');
    await this.deps.repo.transact(ctx, async s => {
      const {conn, eligible} = await this.sourcePreview(s, ctx, connectionId);
      if (conn.status !== 'confirmed') throw new KnowledgeError('connection_unconfirmed', '先确认来源连接。', 409);
      if (ids.some(id => !eligible.some(ref => ref.id === id))) throw new KnowledgeError('source_denied', '选择包含无权读取或版本已变化的资料。', 403);
      const selection = eligible.filter(ref => ids.includes(ref.id)).map(ref => ref.externalId);
      if (JSON.stringify(selection) !== JSON.stringify(conn.scope.selectedExternalIds)) {
        conn.scope = { ...conn.scope, selectedExternalIds: selection }; conn.cursor = null;
        for (const item of s.source.items.filter(item => item.connectionId === connectionId)) delete s.confirmations[item.id];
        invalidateAnalyses(s);
      }
    });
    return this.sync(ctx, connectionId);
  }
  async renameSpace(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const name = bounded(input.name, 160, '知识空间名称');
    return this.deps.repo.transact(ctx, s => { s.spaceName = name; return { name }; });
  }
  async createManualRole(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const name = bounded(input.name, 160, '角色名称'), description = bounded(input.description, 4000, '角色说明');
    return this.deps.repo.transact(ctx, s => { const role = { id: id(), key: `manual-${id()}`, kind: 'employee' as const, origin: 'manual' as const, name, description, evidence: [], humanLocked: true, deleted: false }; s.recommendations.push(role); return role; });
  }
  async installPlugin(ctx: UserContext, pluginId: string) {
    requireManager(ctx); if (!MANIFESTS.some(m => m.id === pluginId)) throw new KnowledgeError('unknown_plugin', '插件不存在。');
    return this.deps.repo.transact(ctx, s => { if (!s.installedPlugins.includes(pluginId)) s.installedPlugins.push(pluginId); return { installed: true }; });
  }
  async sync(ctx: UserContext, connectionId: string) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, async s => {
      const conn = s.source.connections.find(c => c.id === connectionId);
      if (!conn || !this.connectionAllowed(s, ctx, connectionId)) throw new KnowledgeError('not_found', '来源连接不存在。', 404);
      if (conn.status !== 'confirmed') throw new KnowledgeError('connection_unconfirmed', '先测试并确认连接范围。', 409);
      const store = hydrate(s.source), result = await syncConnection(store, this.scopedPlugin(s, conn.pluginId, ctx), connectionId);
      s.source = snapshot(store);
      if (result.error) { const current = s.source.connections.find(c => c.id === connectionId)!; if (current.status !== 'needs_reauth') current.status = 'sync_failed'; }
      invalidateAnalyses(s); return { ...result, error: result.error ? '来源同步失败；资料暂停使用，检查授权后重试。' : undefined };
    });
  }
  async upload(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const connectionId = bounded(input.connectionId, 100, '连接'), name = bounded(input.name, 180, '文件名'), text = bounded(input.text, 200_000, '文件内容');
    if (!/\.(txt|md|markdown|csv)$/i.test(name) || /[\\/\x00-\x1f]/.test(name)) throw new KnowledgeError('unsupported_file', '此入口支持 TXT、Markdown 和 CSV 文件。');
    await this.deps.repo.transact(ctx, s => {
      const conn = s.source.connections.find(c => c.id === connectionId), meta = s.connectionMeta[connectionId];
      if (!conn || conn.pluginId !== 'local-file' || !meta?.audience.includes(ctx.userId) || !meta.projectIds.every(p => ctx.projectScopes.includes(p))) throw new KnowledgeError('not_found', '本地文件连接不存在。', 404);
      s.uploads = s.uploads.filter(u => u.connectionId !== connectionId || u.name !== name);
      if (s.uploads.length >= 200) throw new KnowledgeError('corpus_limit', '试点资料数已达到上限。', 409);
      s.uploads.push({ connectionId, name, text, version: hash(text), audience: meta.audience });
      // Source content changed: withdraw confirmation in the same transaction as accepting the new upload.
      for (const item of s.source.items.filter(i => i.connectionId === connectionId && i.externalId === name && i.contentHash !== hash(text))) delete s.confirmations[item.id];
      invalidateAnalyses(s);
    });
    return this.sync(ctx, connectionId);
  }
  async uploadBinary(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); if (!this.deps.binary) throw new KnowledgeError('parser_unavailable', 'Azure 文档解析和文件存储尚未配置。', 503);
    return queueBinaryUpload(this.deps.repo, this.deps.binary, ctx, input);
  }
  async confirm(ctx: UserContext, sourceId: string, version: string) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, async s => { const item = s.source.items.find(i => i.id === sourceId || hash(i.id) === sourceId); if (!item || !this.allowed(s, ctx, item, false)) throw new KnowledgeError('source_denied', '当前资料权限不足。', 403); await this.checkLiveAcl(s, ctx, item); confirmSource(s, ctx, item.id, version); return { confirmed: true }; });
  }
  async preview(ctx: UserContext, sourceId: string, version: string) {
    const state = await this.deps.repo.read(ctx), item = state.source.items.find(i => hash(i.id) === sourceId || i.id === sourceId);
    if (!item || !this.allowed(state, ctx, item, false)) throw new KnowledgeError('not_found', '当前资料不可读取。', 404);
    await this.checkLiveAcl(state, ctx, item);
    if (item.version !== version) throw new KnowledgeError('version_changed', '资料版本已变化，请刷新后核对。', 409);
    let remaining = 200_000;
    const chunks = positionedChunks(state, item).flatMap(c => { if (remaining <= 0) return []; const text = c.text.slice(0, remaining); remaining -= text.length; return [{ text, locator: c.locator, start: c.start, end: c.start + text.length }]; });
    return { id: hash(item.id), title: item.title, version: item.version, locator: item.locator, chunks, truncated: remaining === 0 };
  }
  async search(ctx: UserContext, query: string): Promise<{ answer: string; hits: SearchHit[] }> {
    bounded(query, 200, '检索词'); const hits = await this.deps.repo.search(ctx, query.trim(), 12);
    // Recheck live state before returning citations; projection and mutation commit atomically in PG.
    const state = await this.deps.repo.read(ctx), valid = hits.filter(e => this.valid(state, ctx, e));
    return { answer: valid.length ? valid.map(e => `${e.quote}\n[${e.locator}]`).join('\n\n') : '无依据', hits: valid };
  }
  async startAnalysis(ctx: UserContext) {
    requireManager(ctx);
    if (!this.deps.model || !this.deps.enqueue) throw new KnowledgeError('analysis_unavailable', '分析需要已配置并通过预算校验的模型及持久化工作队列。', 503);
    await this.deps.model.check?.(ctx.tenantId);
    const run = await this.deps.repo.transact(ctx, s => {
      if (!s.source.items.some(i => this.allowed(s, ctx, i))) throw new KnowledgeError('no_evidence', '无依据：先确认有权限的企业资料。', 409);
      if (s.analyses.some(r => r.actor.userId === ctx.userId && ['queued', 'running'].includes(r.status))) throw new KnowledgeError('analysis_active', '已有分析任务正在运行。', 409);
      const run = { id: id(), actor: ctx, status: 'queued' as const, stage: 'parse' as const, signature: signature(s, ctx), createdAt: stamp(), error: null };
      s.analyses.push(run); return run;
    });
    await this.deps.enqueue(ctx, run.id); return { id: run.id, status: 'queued', stage: run.stage };
  }
  async editRecommendation(ctx: UserContext, recId: string, input: Record<string, unknown>, remove = false) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, s => {
      const r = s.recommendations.find(r => r.id === recId && !r.deleted && (remove || (r.origin === 'manual' || r.evidence.length > 0 && r.evidence.every(e => this.valid(s, ctx, e)))));
      if (!r) throw new KnowledgeError('not_found', '当前有效建议不存在。', 404);
      if (remove) r.deleted = true; else { r.name = bounded(input.name, 160, '名称'); r.description = bounded(input.description, 4000, '说明'); r.humanLocked = true; }
      return { id: r.id, deleted: r.deleted, humanLocked: r.humanLocked };
    });
  }
  async adoptRecommendation(ctx: UserContext, recId: string) {
    requireManager(ctx); return this.deps.repo.transact(ctx, s => {
      const r = s.recommendations.find(r => r.id === recId && !r.deleted), proposal = r?.proposedChange;
      if (!r || !proposal?.evidence.length || !proposal.evidence.every(e => this.valid(s, ctx, e))) throw new KnowledgeError('proposal_unavailable', '修改草案的依据已变化，请重新分析并核对。', 409);
      Object.assign(r, proposal, { humanLocked: true }); delete r.proposedChange; return { id: r.id, humanLocked: true };
    });
  }
  async togglePlugin(ctx: UserContext, pluginId: string, enabled: boolean) {
    requireManager(ctx); if (!MANIFESTS.some(m => m.id === pluginId)) throw new KnowledgeError('unknown_plugin', '插件不存在。');
    return this.deps.repo.transact(ctx, s => { if (!pluginInstalled(s, pluginId)) throw new KnowledgeError('plugin_not_installed', '请先安装知识源插件。', 409); s.disabledPlugins = s.disabledPlugins.filter(p => p !== pluginId); if (!enabled) s.disabledPlugins.push(pluginId); invalidateAnalyses(s); return { enabled }; });
  }
  private databaseConnection(s: KnowledgeState, ctx: UserContext, connectionId: string) {
    const conn = s.source.connections.find(c => c.id === connectionId), meta = s.connectionMeta[connectionId];
    if (!this.deps.database || !conn || conn.pluginId !== 'database' || conn.status !== 'confirmed' || !pluginInstalled(s, 'database') || s.disabledPlugins.includes('database') || !meta || !this.connectionAllowed(s, ctx, connectionId)) throw new KnowledgeError('source_denied', '当前数据库来源不可用。', 403);
    return conn;
  }
  async templates(ctx: UserContext, connectionId: string) { const state = await this.deps.repo.read(ctx); this.databaseConnection(state, ctx, connectionId); return { templates: state.queryTemplates.filter(t => t.connectionId === connectionId) }; }
  async approveTemplate(ctx: UserContext, connectionId: string, input: Record<string, unknown>) {
    requireManager(ctx); return this.deps.repo.transact(ctx, async s => {
      const conn = this.databaseConnection(s, ctx, connectionId), template = await this.deps.database!.approve(ctx, connectionId, conn.scope, input);
      if (!s.queryTemplates.some(t => t.id === template.id)) s.queryTemplates.push(template); return template;
    });
  }
  async factFreshness(ctx: UserContext, connectionId: string, templateId: string, revision: string) {
    const state = await this.deps.repo.read(ctx), conn = this.databaseConnection(state, ctx, connectionId);
    const template = state.queryTemplates.find(t => t.id === templateId && t.connectionId === connectionId);
    if (!template) throw new KnowledgeError('template_not_approved', '必须选择已经审批的查询模板。', 403);
    const result = await this.deps.database!.freshness(ctx, conn.scope, template, revision);
    const fresh = await this.deps.repo.read(ctx); this.databaseConnection(fresh, ctx, connectionId);
    if (!fresh.queryTemplates.some(t => t.id === template.id)) throw new KnowledgeError('template_stale', '查询模板已被撤回。', 409);
    return result;
  }
  async query(ctx: UserContext, connectionId: string, input: Record<string, unknown>) {
    try { return await this.queryCurrent(ctx, connectionId, input); } catch (error) {
      await this.deps.audit?.append({ tenantId: ctx.tenantId, actor: ctx.userId, action: 'knowledge.current_fact_denied', objectType: 'knowledge', objectId: hash(connectionId), result: 'denied', detail: { reason: error instanceof KnowledgeError ? error.code : 'source_unavailable' } });
      throw error;
    }
  }
  private async queryCurrent(ctx: UserContext, connectionId: string, input: Record<string, unknown>) {
    const state = await this.deps.repo.read(ctx), conn = this.databaseConnection(state, ctx, connectionId), template = state.queryTemplates.find(t => t.id === input.templateId && t.connectionId === connectionId);
    if (!template) throw new KnowledgeError('template_not_approved', '必须选择已经审批的查询模板。', 403);
    if (!Array.isArray(input.args)) throw new KnowledgeError('invalid_parameters', '查询参数必须为数组。');
    // Results are current facts returned to the caller; never inserted into source items or the knowledge index.
    const result = await this.deps.database!.run(ctx, conn.scope, template, input.args);
    const fresh = await this.deps.repo.read(ctx); this.databaseConnection(fresh, ctx, connectionId);
    if (!fresh.queryTemplates.some(t => t.id === template.id)) throw new KnowledgeError('template_stale', '查询模板已被撤回。', 409);
    await this.deps.audit?.append({tenantId:ctx.tenantId,actor:ctx.userId,action:'knowledge.current_fact_queried',objectType:'knowledge',objectId:template.id,versionRef:hash(result.schemaVersion),result:'ok',detail:{connectionId,rowCount:result.rowCount,queriedAt:result.queriedAt}});
    return result;
  }
}
