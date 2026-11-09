/** Real HTTP/UI integration; explicit test storage/model, not live Azure evidence. */
import { describe, it, expect } from 'vitest';
import { chromium } from 'playwright';
import { buildApp } from '../src/app.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { tickKnowledge } from '../src/modules/knowledge/worker.js';
import type { KnowledgeDeps } from '../src/modules/knowledge/service.js';
import { DatabaseGateway } from '../src/modules/knowledge/database.js';
const d = process.env.RUN_BROWSER_TESTS === '1' ? describe : describe.skip;
d('knowledge UI over real HTTP handlers', () => {
  it('imports, confirms and retrieves sources, runs a durable analysis, and locks a draft', async () => {
    const deps: KnowledgeDeps = {
      repo: new MemoryKnowledgeRepository(), enqueue: async () => undefined,
      database:new DatabaseGateway([{id:'approved-db',name:'测试只读视图',projectIds:[],scope:{audience:['alice'],maxRows:10,tables:{approved_invoices:{columns:['id','status','email'],sensitive:['email']}}},
        verifyReadOnly:async()=>true,inspect:async()=>({version:'synthetic-schema',tables:{approved_invoices:[{column:'id',type:'integer'},{column:'status',type:'text'},{column:'email',type:'text'}]}}),
        open:async()=>({client:{query:async sql=>({rows:sql.startsWith('SELECT * FROM (')?[{id:1,masked:'person@synthetic.example'}]:[]})},release:()=>undefined})}]),
      model: { recommend: async input => [{ key: 'check-policy', kind: 'employee', name: '资料核对助理', description: '仅生成待人工核对的员工草案。', evidence: input.evidence.slice(0, 1) }] },
    };
    const app = await buildApp({ serveWeb: true, auth: { mode: 'dev', platformTenantId: 'ui-test' }, knowledgeDeps: deps });
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': 'alice|owner|' } });
    const page = await context.newPage(), errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(`${base}/#knowledge`);
      await page.getByLabel('连接名称',{exact:true}).fill('真实 HTTP 测试资料');
      await page.getByRole('button', { name: '创建连接草案' }).click();
      await page.getByRole('button', { name: '确认连接', exact: true }).click();
      await page.getByLabel('资料名称').fill('policy.md');
      await page.getByLabel('文本内容').fill('付款前核对金额。');
      await page.getByRole('button', { name: '提交资料', exact: true }).click();
      await page.getByRole('button', { name: '确认此版本', exact: true }).waitFor();
      await page.getByLabel('查询企业资料').fill('付款');
      await page.getByRole('button', { name: '查询依据', exact: true }).click();
      await page.getByText('没有当前可用的依据。', { exact: false }).waitFor();
      await page.getByRole('button', { name: '确认此版本', exact: true }).click();
      await page.getByText('当前版本已人工确认', { exact: false }).waitFor();
      await page.getByRole('button', { name: '查询依据', exact: true }).click();
      await page.locator('.knowledge-evidence blockquote').first().waitFor();
      expect(await page.locator('.knowledge-evidence blockquote').first().textContent()).toBe('付款前核对金额。');
      expect(await page.locator('.knowledge-evidence').first().textContent()).toContain('policy.md#L1');
      const submitted = page.waitForResponse(r => r.url().endsWith('/knowledge/analyses') && r.request().method() === 'POST');
      await page.getByRole('button', { name: '开始分析', exact: true }).click(); expect((await submitted).status()).toBe(202);
      await tickKnowledge(deps, 'ui-test');
      await page.reload(); await page.getByText('员工草案', { exact: true }).waitFor();
      expect(await page.locator('.knowledge-recommendation input').inputValue()).toBe('资料核对助理');
      await page.locator('.knowledge-recommendation input').fill('人工保留名称');
      await page.getByRole('button', { name: '保存并人工锁定', exact: true }).click();
      await page.getByText('人工锁定', { exact: true }).waitFor();
      const state = await deps.repo.read({ tenantId: 'ui-test', userId: 'alice', roles: ['owner'], projectScopes: [] });
      expect(state.recommendations[0]).toMatchObject({ name: '人工保留名称', humanLocked: true });
      expect(state.source.connections).toHaveLength(1); expect(state.analyses[0]!.status).toBe('completed');
      await page.getByLabel('数据库连接名称',{exact:true}).fill('受控实时数据');
      await page.getByRole('button',{name:'创建数据库连接草案',exact:true}).click();
      await page.getByRole('button',{name:'确认连接',exact:true}).click();
      const schemaResponse=page.waitForResponse(r=>r.url().includes('/connections/')&&r.url().endsWith('/sync'));
      await page.getByRole('button',{name:'读取数据库结构知识',exact:true}).click(); expect((await schemaResponse).status()).toBe(200);
      await page.getByText('表 approved_invoices',{exact:true}).waitFor();
      await page.getByRole('button',{name:'确认此版本',exact:true}).click();
      await page.getByLabel('待批准的 SQL 模板',{exact:true}).fill('SELECT id,email AS masked FROM approved_invoices WHERE status=$1');
      await page.getByLabel('参数名称（英文逗号分隔，可留空）',{exact:true}).fill('status');
      await page.getByRole('button',{name:'提交并批准查询模板',exact:true}).click();
      await page.getByText('批准人：alice',{exact:false}).waitFor();
      await page.getByLabel('执行参数（JSON 数组）').fill('["open"]');
      await page.getByRole('button',{name:'执行已批准模板',exact:true}).click();
      await page.getByRole('cell',{name:'p***@synthetic.example',exact:true}).waitFor();
      expect(await page.locator('main').textContent()).not.toContain('person@synthetic.example');
      expect(await page.getByLabel('数据库当前事实结果').textContent()).toContain('当前事实');
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); expect(errors).toEqual([]);
      const denied = await context.request.get(`${base}/api/v1/knowledge/search?q=付款`, { headers: { 'x-dev-user': 'bob|owner|' } }); expect((await denied.json()).answer).toBe('无依据');
    } catch (error) { console.error((await page.locator('main').textContent())?.slice(-5000)); throw error; }
    finally { await browser.close(); await app.close(); }
  }, 60_000);
});
