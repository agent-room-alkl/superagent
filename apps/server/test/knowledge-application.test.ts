import { describe, it, expect, afterAll } from 'vitest';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { UserContext } from '@superagent/shared';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { MemoryKnowledgeRepository, PgKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { confirmSource, emptyState, invalidateAnalyses, type Evidence, type KnowledgeState } from '../src/modules/knowledge/domain.js';
import { runAnalysis } from '../src/modules/analysis/service.js';
import { knowledgeModule } from '../src/modules/knowledge/index.js';
import { migrate } from '../src/migrate.js';
const owner: UserContext = { tenantId: 'tenant-a', userId: 'alice', roles: ['owner'], projectScopes: ['project-a'] };
async function fixture() {
  const repo = new MemoryKnowledgeRepository(), service = new KnowledgeService({ repo });
  const conn = await service.createConnection(owner, { name: '资料', pluginId: 'local-file' });
  await service.confirmConnection(owner, conn.id);
  await service.upload(owner, { connectionId: conn.id, name: 'policy.md', text: '规则\n\n付款前核对金额。' });
  const item = (await repo.read(owner)).source.items[0]!;
  return { repo, service, conn, item };
}
async function confirmed() { const f = await fixture(); await f.service.confirm(owner, f.item.id, f.item.version); return f; }
function evidence(s: KnowledgeState): Evidence { const i = s.source.items.find(i => i.current)!, c = s.source.chunks.find(c => c.itemId === i.id && c.text.includes('付款'))!; return { sourceId: i.id, version: i.version, start: c.start, end: c.end, locator: c.locator, quote: c.text }; }
const proposal = (e: Evidence, name = '应付助理') => [{ key: 'ap-assistant', kind: 'employee', name, description: '核对待付款资料', evidence: [e] }];
describe('knowledge application: real source store + transactions', () => {
  it('requires separate connection and version confirmation; preserves blank-line offsets', async () => {
    const f = await fixture(); expect(await f.service.search(owner, '付款')).toEqual({ answer: '无依据', hits: [] });
    await f.service.confirm(owner, f.item.id, f.item.version);
    const result = await f.service.search(owner, '付款'); expect(result.hits[0]).toMatchObject({ start: 4, end: 12, locator: 'policy.md#L3', quote: '付款前核对金额。' });
    expect(result.answer).toContain('policy.md#L3');
  });
  it('owner role cannot bypass ACL, project or tenant boundary', async () => {
    const f = await confirmed();
    for (const ctx of [{ ...owner, userId: 'bob' }, { ...owner, tenantId: 'tenant-b' }]) expect((await f.service.search(ctx, '付款')).hits).toEqual([]);
    await f.repo.transact(owner, s => { s.connectionMeta[f.conn.id]!.projectIds = ['project-a']; invalidateAnalyses(s); confirmSource(s, owner, f.item.id, f.item.version); });
    expect((await f.service.search({ ...owner, projectScopes: [] }, '付款')).answer).toBe('无依据');
  });
  it('unknown ACL cannot be confirmed and removes old citations immediately', async () => {
    const f = await confirmed();
    expect((await f.service.preview(owner, f.item.id, f.item.version)).chunks[1]).toMatchObject({ text: '付款前核对金额。', start: 4 });
    await f.repo.transact(owner, s => { s.source.items[0]!.acl = null; invalidateAnalyses(s); });
    await expect(f.service.confirm(owner, f.item.id, f.item.version)).rejects.toMatchObject({ code: 'source_denied' });
    expect((await f.service.search(owner, '付款')).hits).toEqual([]);
    await expect(f.service.preview(owner, f.item.id, f.item.version)).rejects.toMatchObject({ code: 'not_found' });
  });
  it('changed upload withdraws approval, and retry never silently restores it', async () => {
    const f = await confirmed(); await f.service.upload(owner, { connectionId: f.conn.id, name: 'policy.md', text: '新付款规则' });
    expect((await f.service.search(owner, '付款')).hits).toEqual([]);
    await f.service.sync(owner, f.conn.id); expect((await f.service.search(owner, '付款')).hits).toEqual([]);
    await expect(f.service.confirm(owner, f.item.id, f.item.version)).rejects.toMatchObject({ code: 'source_denied' });
  });
  it('disable and auth status block current and history access', async () => {
    const f = await confirmed(); await f.service.togglePlugin(owner, 'local-file', false);
    expect((await f.service.search(owner, '付款')).hits).toEqual([]);
    await f.service.togglePlugin(owner, 'local-file', true);
    await f.repo.transact(owner, s => { s.source.connections[0]!.status = 'needs_reauth'; invalidateAnalyses(s); });
    expect((await f.service.overview(owner)).items).toEqual([]); expect((await f.service.search(owner, '付款')).hits).toEqual([]);
  });
  it('transactions roll back all writes on failed mutations', async () => {
    const f = await confirmed(); const before = await f.repo.read(owner), auditCount=f.repo.auditEntries.length;
    await expect(f.repo.transact(owner, s => { s.source.items = []; throw Error('fail'); })).rejects.toThrow('fail');
    expect(await f.repo.read(owner)).toEqual(before);
    expect(f.repo.auditEntries).toHaveLength(auditCount);
  });
  it('audits source/approval changes as metadata while keeping source text out of the log', async () => {
    const f=await confirmed();
    expect(f.repo.auditEntries.some(e=>e.action==='knowledge.version_confirmation_changed'&&e.actor==='alice')).toBe(true);
    expect(JSON.stringify(f.repo.auditEntries)).not.toContain('付款前核对金额');
    expect(JSON.stringify(f.repo.auditEntries)).not.toContain('规则');
  });
  it('unconfigured external connectors and analysis return actionable errors', async () => {
    const f = await confirmed();
    await f.service.installPlugin(owner, 'database');
    await expect(f.service.createConnection(owner, { name: '数据库', pluginId: 'database', readOnlyAcknowledged: true })).rejects.toMatchObject({ code: 'connector_not_configured', statusCode: 503 });
    await expect(f.service.startAnalysis(owner)).rejects.toMatchObject({ code: 'analysis_unavailable', statusCode: 503 });
    await expect(f.service.createConnection(owner, { name: 'x', pluginId: 'local-file', scope: { password: 'placeholder' } })).rejects.toMatchObject({ code: 'secret_not_allowed' });
  });
  it('employee cannot change source approval or recommendation state', async () => {
    const f = await confirmed(), employee = { ...owner, roles: ['employee'] as UserContext['roles'] };
    await expect(f.service.confirm(employee, f.item.id, f.item.version)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await f.service.search(employee, '付款')).hits).toHaveLength(1);
  });
  it('lost project scope prevents connection mutations and hides pending proposal evidence', async () => {
    const f = await confirmed(); const e = evidence(await f.repo.read(owner));
    await f.repo.transact(owner, s => {
      s.recommendations.push({ id: 'r', key: 'r', kind: 'employee', name: '人工名称', description: '人工描述', humanLocked: true, deleted: false, evidence: [e], proposedChange: { name: '待审修改', description: '待审描述', evidence: [{ ...e, sourceId: 'revoked-source' }] } });
    });
    expect((await f.service.overview(owner)).recommendations[0]!.proposedChange).toBeUndefined();
    await f.repo.transact(owner, s => { s.connectionMeta[f.conn.id]!.projectIds = ['project-a']; });
    const lost = { ...owner, projectScopes: [] };
    await expect(f.service.confirmConnection(lost, f.conn.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.sync(lost, f.conn.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.service.upload(lost, { connectionId: f.conn.id, name: 'x.md', text: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('HTTP routes fail closed without dependencies, and validate requests with dependencies', async () => {
    const app = Fastify(); app.addHook('preHandler', async req => { req.user = owner; });
    await app.register(knowledgeModule, { prefix: '/knowledge' }); expect((await app.inject('/knowledge/overview')).statusCode).toBe(503); await app.close();
    const f = await fixture(), wired = Fastify(); wired.addHook('preHandler', async req => { req.user = owner; });
    await wired.register(knowledgeModule, { prefix: '/knowledge', deps: { repo: f.repo } });
    const overview = (await wired.inject('/knowledge/overview')).json(); expect(overview.items).toHaveLength(1);
    expect(overview.items[0].id).toHaveLength(64);
    expect((await wired.inject({ method: 'POST', url: `/knowledge/items/${overview.items[0].id}/confirm`, payload: { version: overview.items[0].version } })).statusCode).toBe(200);
    expect((await wired.inject({ method: 'POST', url: '/knowledge/connections', payload: [] })).statusCode).toBe(400);
    expect((await wired.inject({ method: 'POST', url: '/knowledge/analyses', payload: {} })).statusCode).toBe(503); await wired.close();
  });
});
describe('analysis stage worker', () => {
  it('persists stages, generates only evidence-backed drafts, and protects human locks/deletions', async () => {
    const f = await confirmed(); let queued = '', label = '应付助理';
    const model = { recommend: async () => proposal(evidence(await f.repo.read(owner)), label) };
    const service = new KnowledgeService({ repo: f.repo, model, enqueue: async (_ctx, run) => { queued = run; } });
    await service.startAnalysis(owner); expect(queued).toBeTruthy(); await runAnalysis(f.repo, model, owner, queued);
    let state = await f.repo.read(owner); expect(state.analyses[0]).toMatchObject({ status: 'completed', stage: 'complete' }); expect(state.recommendations).toHaveLength(1);
    const recId = state.recommendations[0]!.id;
    await service.editRecommendation(owner, recId, { name: '人工名称', description: '人工职责' });
    label = '模型新名称'; await service.startAnalysis(owner); await runAnalysis(f.repo, model, owner, queued);
    state = await f.repo.read(owner); expect(state.recommendations[0]).toMatchObject({ name: '人工名称', humanLocked: true, proposedChange: { name: '模型新名称' } });
    await service.editRecommendation(owner, recId, {}, true);
    await service.startAnalysis(owner); await runAnalysis(f.repo, model, owner, queued); expect((await f.repo.read(owner)).recommendations).toHaveLength(1); expect((await service.overview(owner)).recommendations).toEqual([]);
  });
  it('discards model output if ACL changes while the call is running', async () => {
    const f = await confirmed(); const e = evidence(await f.repo.read(owner)); let queued = '';
    const model = { recommend: async () => { await f.repo.transact(owner, s => { s.source.items[0]!.acl = null; invalidateAnalyses(s); }); return proposal(e); } };
    const service = new KnowledgeService({ repo: f.repo, model, enqueue: async (_ctx, run) => { queued = run; } });
    await service.startAnalysis(owner); await runAnalysis(f.repo, model, owner, queued);
    const state = await f.repo.read(owner); expect(state.analyses[0]!.status).toBe('stale'); expect(state.recommendations).toEqual([]);
  });
  it('changed versions preserve human content, withdraw old quotes and require explicit proposal adoption', async () => {
    const f = await confirmed(); let queued = '';
    const model = { recommend: async () => proposal(evidence(await f.repo.read(owner)), '模型名称') }, service = new KnowledgeService({ repo:f.repo,model,enqueue:async(_ctx,run)=>{queued=run;} });
    await service.startAnalysis(owner); await runAnalysis(f.repo,model,owner,queued);
    const rec = (await f.repo.read(owner)).recommendations[0]!;
    await service.editRecommendation(owner,rec.id,{name:'人工保留',description:'人工职责'});
    await service.upload(owner,{connectionId:f.conn.id,name:'policy.md',text:'规则\n\n付款前复核金额与审批。'});
    expect((await service.overview(owner)).recommendations[0]).toMatchObject({ name:'人工保留', description:'人工职责', humanLocked:true, stale:true, evidence:[] });
    await expect(service.editRecommendation(owner,rec.id,{name:'绕过确认',description:'不应写入'})).rejects.toMatchObject({code:'not_found'});
    await expect(service.adoptRecommendation(owner,rec.id)).rejects.toMatchObject({code:'proposal_unavailable'});
    const current = (await f.repo.read(owner)).source.items.find(i=>i.current)!; await service.confirm(owner,current.id,current.version);
    await service.startAnalysis(owner); await runAnalysis(f.repo,model,owner,queued);
    const visible = (await service.overview(owner)).recommendations[0]!;
    expect(visible).toMatchObject({name:'人工保留',humanLocked:true,stale:true,evidence:[],proposedChange:{name:'模型名称'}});
    await service.adoptRecommendation(owner,rec.id);
    expect((await service.overview(owner)).recommendations[0]).toMatchObject({name:'模型名称',humanLocked:true,stale:false});
    await f.repo.transact(owner,s=>{s.source.items.find(i=>i.current)!.acl=null;invalidateAnalyses(s);});
    expect((await service.overview(owner)).recommendations).toEqual([]);
  });
  it('rejects invented quotes and arbitrary model fields rather than publishing tools', async () => {
    const f = await confirmed(); let queued = '';
    const model = { recommend: async () => proposal({ ...evidence(await f.repo.read(owner)), quote: 'invented' }) };
    const service = new KnowledgeService({ repo: f.repo, model, enqueue: async (_ctx, run) => { queued = run; } });
    await service.startAnalysis(owner); await runAnalysis(f.repo, model, owner, queued);
    expect((await f.repo.read(owner)).analyses[0]).toMatchObject({ status: 'failed', error: 'unsupported_recommendation' }); expect((await f.repo.read(owner)).recommendations).toEqual([]);
  });
  it('duplicate deliveries do not execute the model twice', async () => {
    const f = await confirmed(); let queued = '', calls = 0;
    const model = { recommend: async () => { calls++; return []; } }; const service = new KnowledgeService({ repo: f.repo, model, enqueue: async (_ctx, run) => { queued = run; } });
    await service.startAnalysis(owner); await Promise.all([runAnalysis(f.repo, model, owner, queued), runAnalysis(f.repo, model, owner, queued)]); expect(calls).toBe(1);
  });
  it('ontology relations require evidence and visible object endpoints, and withdraw after endpoint deletion', async () => {
    const f=await confirmed();let queued='';const e=evidence(await f.repo.read(owner));
    const p=(key:string,kind:string)=>({key,kind,name:key,description:'有依据的业务草案',evidence:[e]});
    const relation={...p('pays','relation'),relation:{from:'invoice',to:'customer',label:'开给'}};
    const model={recommend:async()=>[relation,p('invoice','object'),p('customer','object')]};
    const service=new KnowledgeService({repo:f.repo,model,enqueue:async(_ctx,run)=>{queued=run;}});
    await service.startAnalysis(owner);await runAnalysis(f.repo,model,owner,queued);
    expect((await service.overview(owner)).recommendations.find(r=>r.kind==='relation')).toMatchObject({relation:{from:'invoice',to:'customer',label:'开给'}});
    const object=(await f.repo.read(owner)).recommendations.find(r=>r.key==='customer')!;await service.editRecommendation(owner,object.id,{},true);
    expect((await service.overview(owner)).recommendations.some(r=>r.kind==='relation')).toBe(false);
    await service.startAnalysis(owner);await runAnalysis(f.repo,model,owner,queued);
    expect((await f.repo.read(owner)).analyses.at(-1)).toMatchObject({status:'failed',error:'unsupported_relation'});
  });
  it('an expired lease during a model call becomes unknown without a second billable request', async () => {
    const f = await confirmed(); let queued = '', calls = 0;
    const model = { recommend: async () => { calls++; return []; } }, service = new KnowledgeService({ repo: f.repo, model, enqueue: async (_ctx, run) => { queued = run; } });
    await service.startAnalysis(owner);
    await f.repo.transact(owner, s => { Object.assign(s.analyses[0]!, { status: 'running', stage: 'recommend', leaseUntil: Date.now() - 1 }); });
    await runAnalysis(f.repo, model, owner, queued); expect(calls).toBe(0); expect((await f.repo.read(owner)).analyses[0]!.status).toBe('outcome_unknown');
  });
});
const dbUrl = process.env.DATABASE_URL;
(dbUrl ? describe : describe.skip)('PostgreSQL persistence and search projection', () => {
  const pool = new Pool({ connectionString: dbUrl }); afterAll(() => pool.end());
  it('persists across instances, atomically invalidates ACL, supports FTS/trigram and escapes LIKE', async () => {
    await migrate(pool, undefined, () => undefined);
    await pool.query(await readFile(new URL('../migrations/0002_knowledge.sql', import.meta.url), 'utf8'));
    const ctx = { ...owner, tenantId: randomUUID() }, repo = new PgKnowledgeRepository(pool), service = new KnowledgeService({ repo });
    const conn = await service.createConnection(ctx, { name: 'PG test', pluginId: 'local-file' }); await service.confirmConnection(ctx, conn.id); await service.upload(ctx, { connectionId: conn.id, name: 'pg.md', text: '付款 approval policy' });
    const item = (await repo.read(ctx)).source.items[0]!; await service.confirm(ctx, item.id, item.version);
    const audit = await pool.query("SELECT action,actor,detail FROM audit_log WHERE tenant_id=$1 AND object_type='knowledge'",[ctx.tenantId]);
    expect(audit.rows.some(r=>r.action==='knowledge.version_confirmation_changed'&&r.actor==='alice')).toBe(true);
    expect(JSON.stringify(audit.rows)).not.toContain('付款 approval policy');
    expect((await new KnowledgeService({ repo: new PgKnowledgeRepository(pool) }).search(ctx, 'approval')).hits).toHaveLength(1);
    expect((await service.search({ ...ctx, userId: 'bob' }, '付款')).hits).toEqual([]);
    expect((await service.search(ctx, '%')).hits).toEqual([]);
    await expect(repo.transact(ctx, s => { s.source.items = []; throw Error('rollback'); })).rejects.toThrow(); expect((await service.search(ctx, '付款')).hits).toHaveLength(1);
    await Promise.all(Array.from({ length: 8 }, () => repo.transact(ctx, s => { s.revision++; })));
    await repo.transact(ctx, s => { s.source.items[0]!.acl = null; invalidateAnalyses(s); }); expect((await service.search(ctx, '付款')).hits).toEqual([]);
    await pool.query('DELETE FROM knowledge_chunks WHERE tenant_id=$1', [ctx.tenantId]); await pool.query('DELETE FROM knowledge_tenants WHERE tenant_id=$1', [ctx.tenantId]);
  });
});
