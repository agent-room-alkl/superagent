import type { KnowledgeSourcePlugin, UserContext } from '@superagent/shared';
import { confirmSource, evidenceValid, hash, hydrate, id, invalidateAnalyses, KnowledgeError, mayRead, requireManager, signature, snapshot, stamp, type KnowledgeState } from './domain.js';
import type { KnowledgeRepository, SearchHit } from './repository.js';
import { syncConnection } from './sync.js';
import { createLocalFilePlugin } from './plugins/local-file.js';
import type { AnalysisModel } from '../analysis/service.js';
import { queueBinaryUpload, type BinaryDeps } from './binary.js';
export interface KnowledgeDeps {
  repo: KnowledgeRepository;
  plugins?: Record<string, KnowledgeSourcePlugin>;
  model?: AnalysisModel;
  enqueue?: (ctx: UserContext, runId: string) => Promise<void>;
  binary?: BinaryDeps;
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
  private plugin(state: KnowledgeState, pluginId: string): KnowledgeSourcePlugin {
    if (state.disabledPlugins.includes(pluginId)) throw new KnowledgeError('plugin_disabled', '知识源插件已暂停。', 409);
    if (pluginId === 'local-file') {
      const files = new Map<string, { name: string; bytes: Uint8Array; version: string; audience: string[] }[]>();
      for (const u of state.uploads) files.set(u.connectionId, [...files.get(u.connectionId) ?? [], { ...u, bytes: Buffer.from(u.text) }]);
      return createLocalFilePlugin(files);
    }
    const plugin = this.deps.plugins?.[pluginId];
    if (!plugin) throw new KnowledgeError('connector_not_configured', '此来源需要独立配置连接凭据与只读授权。模型 API Key 不能代替来源授权。', 503); return plugin;
  }
  async overview(ctx: UserContext) {
    const s = await this.deps.repo.read(ctx);
    const items = s.source.items.filter(i => mayRead(s, ctx, i, false));
    const recs = s.recommendations.filter(r => !r.deleted && r.evidence.every(e => evidenceValid(s, ctx, e)));
    return {
      plugins: MANIFESTS.map(m => ({ ...m, enabled: !s.disabledPlugins.includes(m.id), configured: m.id === 'local-file' || !!this.deps.plugins?.[m.id] })),
      connections: s.source.connections.filter(c => s.connectionMeta[c.id]?.audience.includes(ctx.userId) && s.connectionMeta[c.id]!.projectIds.every(p => ctx.projectScopes.includes(p))).map(c => ({ id: c.id, name: s.connectionMeta[c.id]!.name, pluginId: c.pluginId, status: c.status })),
      items: items.map(i => ({ id: i.id, title: i.title, version: i.version, status: i.status, confirmed: mayRead(s, ctx, i), locator: i.locator })),
      analyses: s.analyses.filter(r => r.actor.userId === ctx.userId).map(({ actor: _, ...run }) => run), recommendations: recs,
      parseJobs: s.parseJobs.filter(j => j.actor.userId === ctx.userId).map(j => ({ id: j.id, name: j.name, status: j.status, error: j.error })),
    };
  }
  async createConnection(ctx: UserContext, input: Record<string, unknown>) {
    requireManager(ctx); const name = bounded(input.name, 160, '连接名称'), pluginId = bounded(input.pluginId, 80, '插件');
    if (!MANIFESTS.some(m => m.id === pluginId)) throw new KnowledgeError('unknown_plugin', '知识源插件不存在。');
    const audience = strings(input.audience, [ctx.userId]), projectIds = strings(input.projectIds);
    if (!audience.includes(ctx.userId) || !projectIds.every(p => ctx.projectScopes.includes(p))) throw new KnowledgeError('scope_denied', '连接不能扩大当前账号的权限范围。', 403);
    const scope = input.scope ?? {};
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || JSON.stringify(scope).length > 8000) throw new KnowledgeError('invalid_scope', '来源范围无效。');
    // Credential values are never accepted here; connector secrets are provisioned separately in Key Vault.
    if (/password|secret|token|api.?key|connection.?string/i.test(JSON.stringify(scope))) throw new KnowledgeError('secret_not_allowed', '来源范围中不能保存凭据。');
    return this.deps.repo.transact(ctx, async s => {
      this.plugin(s, pluginId); const conn = { id: id(), pluginId, scope: scope as Record<string, unknown>, credentialRef: null, status: 'draft' as const, cursor: null, confirmedBy: null };
      s.source.connections.push(conn); s.connectionMeta[conn.id] = { name, audience, projectIds }; return { ...conn, name };
    });
  }
  async confirmConnection(ctx: UserContext, connectionId: string) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, async s => {
      const conn = s.source.connections.find(c => c.id === connectionId);
      if (!conn || !s.connectionMeta[connectionId]?.audience.includes(ctx.userId)) throw new KnowledgeError('not_found', '来源连接不存在。', 404);
      const test = await this.plugin(s, conn.pluginId).testConnection({ connectionId, scope: conn.scope, credentialRef: conn.credentialRef });
      if (!test.ok) throw new KnowledgeError('connection_test_failed', '来源连接测试未通过。', 409);
      conn.status = 'confirmed'; conn.confirmedBy = ctx.userId; invalidateAnalyses(s); return { id: conn.id, status: conn.status };
    });
  }
  async sync(ctx: UserContext, connectionId: string) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, async s => {
      const conn = s.source.connections.find(c => c.id === connectionId);
      if (!conn || !s.connectionMeta[connectionId]?.audience.includes(ctx.userId)) throw new KnowledgeError('not_found', '来源连接不存在。', 404);
      if (conn.status !== 'confirmed') throw new KnowledgeError('connection_unconfirmed', '先测试并确认连接范围。', 409);
      const store = hydrate(s.source), result = await syncConnection(store, this.plugin(s, conn.pluginId), connectionId);
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
      if (!conn || conn.pluginId !== 'local-file' || !meta?.audience.includes(ctx.userId)) throw new KnowledgeError('not_found', '本地文件连接不存在。', 404);
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
  async confirm(ctx: UserContext, sourceId: string, version: string) { return this.deps.repo.transact(ctx, s => { confirmSource(s, ctx, sourceId, version); return { confirmed: true }; }); }
  async search(ctx: UserContext, query: string): Promise<{ answer: string; hits: SearchHit[] }> {
    bounded(query, 200, '检索词'); const hits = await this.deps.repo.search(ctx, query.trim(), 12);
    // Recheck live state before returning citations; projection and mutation commit atomically in PG.
    const state = await this.deps.repo.read(ctx), valid = hits.filter(e => evidenceValid(state, ctx, e));
    return { answer: valid.length ? valid.map(e => `${e.quote}\n[${e.locator}]`).join('\n\n') : '无依据', hits: valid };
  }
  async startAnalysis(ctx: UserContext) {
    requireManager(ctx);
    if (!this.deps.model || !this.deps.enqueue) throw new KnowledgeError('analysis_unavailable', '分析需要已配置并通过预算校验的模型及持久化工作队列。', 503);
    const run = await this.deps.repo.transact(ctx, s => {
      if (!s.source.items.some(i => mayRead(s, ctx, i))) throw new KnowledgeError('no_evidence', '无依据：先确认有权限的企业资料。', 409);
      if (s.analyses.some(r => r.actor.userId === ctx.userId && ['queued', 'running'].includes(r.status))) throw new KnowledgeError('analysis_active', '已有分析任务正在运行。', 409);
      const run = { id: id(), actor: ctx, status: 'queued' as const, stage: 'parse' as const, signature: signature(s, ctx), createdAt: stamp(), error: null };
      s.analyses.push(run); return run;
    });
    await this.deps.enqueue(ctx, run.id); return { id: run.id, status: 'queued', stage: run.stage };
  }
  async editRecommendation(ctx: UserContext, recId: string, input: Record<string, unknown>, remove = false) {
    requireManager(ctx);
    return this.deps.repo.transact(ctx, s => {
      const r = s.recommendations.find(r => r.id === recId && !r.deleted && r.evidence.every(e => evidenceValid(s, ctx, e)));
      if (!r) throw new KnowledgeError('not_found', '当前有效建议不存在。', 404);
      if (remove) r.deleted = true; else { r.name = bounded(input.name, 160, '名称'); r.description = bounded(input.description, 4000, '说明'); r.humanLocked = true; }
      return { id: r.id, deleted: r.deleted, humanLocked: r.humanLocked };
    });
  }
  async togglePlugin(ctx: UserContext, pluginId: string, enabled: boolean) {
    requireManager(ctx); if (!MANIFESTS.some(m => m.id === pluginId)) throw new KnowledgeError('unknown_plugin', '插件不存在。');
    return this.deps.repo.transact(ctx, s => { s.disabledPlugins = s.disabledPlugins.filter(p => p !== pluginId); if (!enabled) s.disabledPlugins.push(pluginId); invalidateAnalyses(s); return { enabled }; });
  }
}
