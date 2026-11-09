/** Real browser + Fastify/service/gateway E2E. Only external source/model/DB drivers are explicitly synthetic. */
import type { Page, APIResponse } from '@playwright/test';
import { test, expect } from './fixtures.js';
// Kept local so Playwright discovery does not load the server's Azure/PG dependency graph.
const KNOWLEDGE_HEADER = 'e2e-knowledge-owner|owner|P-1';
const DB_RESOURCE_ID = 'synthetic-dba-lots';
const MAIL_RESOURCE_ID = 'synthetic-mailbox';
const SHAREPOINT_RESOURCE_ID = 'synthetic-sharepoint';
const ROLE_FILE = [
  '角色：采购专员；责任：核对采购申请并跟踪供应商。',
  '角色：财务专员；责任：核对付款金额与票据。',
  '角色：仓储专员；责任：复核入库批次与库存数量。',
  '角色：业务主管；责任：审核异常并协调部门职责。',
  '工具：只读单据查询；职责：按编号查证业务记录。',
].join('\n');

interface Item { id: string; title: string; version: string; confirmed: boolean; locator: string }
interface Recommendation { id: string; key: string; kind: string; name: string; description: string; humanLocked: boolean; origin?: string; evidence: { sourceId: string; version: string; start: number; end: number; locator: string; quote: string }[]; proposedChange?: { name: string; description: string }; stale?: boolean }
interface Overview { spaceName: string; plugins: { id: string; installed: boolean; builtIn: boolean; enabled: boolean }[]; connections: { id: string; name: string; pluginId: string; status: string }[]; items: Item[]; recommendations: Recommendation[]; analyses: { id: string; status: string }[]; databaseResources: { id: string; tables: Record<string, { columns: string[] }> }[]; sourceResources: { id: string; projectIds: string[] }[] }
interface Preview { items: { id: string; title: string; version: string; locator: string }[]; blocked: number; scope: Record<string, unknown> }
const ROOT = '/api/v1/knowledge';
const OWNER_WITHOUT_PROJECT = 'e2e-knowledge-owner|owner|';
const OTHER_OWNER = 'e2e-other-owner|owner|P-1';
const SQL = 'SELECT lot_id, project_id, quantity, status, manufacturing_order_reference, sensitive_email, inspection_detail_1, inspection_detail_2, inspection_detail_3, inspection_detail_4, inspection_detail_5, inspection_detail_6, inspection_detail_7, inspection_detail_8, inspection_detail_9, inspection_detail_10, final_quality_disposition FROM approved_lots WHERE lot_id = $1';

test.use({ extraHTTPHeaders: { 'x-dev-user': KNOWLEDGE_HEADER } });
// Config fullyParallel:false keeps this file sequential; independent resets let later cases run after a failure.
test.describe.configure({ mode: 'default' });
async function response<T>(incoming: Promise<APIResponse>, statuses = [200, 201, 202]): Promise<T> {
  const result = await incoming;
  expect(statuses, await result.text()).toContain(result.status());
  return result.json() as Promise<T>;
}
const getOverview = (page: Page) => response<Overview>(page.request.get(`${ROOT}/overview`));
const post = <T = Record<string, unknown>>(page: Page, path: string, data: unknown = {}) => response<T>(page.request.post(ROOT + path, { data }));
const control = (page: Page, data: unknown) => response(page.request.post('/__test/knowledge/control', { data }));
async function refresh(page: Page) { await page.reload(); await expect(page.getByRole('heading', { name: '企业知识', exact: true })).toBeVisible(); await expect(page.getByTestId('plugin-local-file')).toBeVisible(); }
async function install(page: Page, id: string) { await post(page, `/plugins/${id}/install`); }
async function confirmItems(page: Page) {
  for (const item of (await getOverview(page)).items.filter(item => !item.confirmed)) await post(page, `/items/${item.id}/confirm`, { version: item.version });
}
async function localFile(page: Page, confirmed = true, text = ROLE_FILE) {
  const connection = await post<{ id: string }>(page, '/connections', { name: '本地职责资料', pluginId: 'local-file', scope: {} });
  await post(page, `/connections/${connection.id}/confirm`);
  await refresh(page);
  await page.getByLabel('选择文本文件（.txt / .md / .csv / .markdown，最多 2 MB）').setInputFiles({ name: '实际上传职责.md', mimeType: 'text/markdown', buffer: Buffer.from(text) });
  await expect(page.getByPlaceholder('也可以在此粘贴纯文本…')).toHaveValue(text);
  const submitted = page.waitForResponse(result => result.url().endsWith('/knowledge/uploads') && result.request().method() === 'POST');
  await page.getByRole('button', { name: '提交资料', exact: true }).click();
  expect((await submitted).ok()).toBe(true);
  await expect(page.getByText('实际上传职责.md', { exact: true })).toBeVisible();
  if (confirmed) { await confirmItems(page); await refresh(page); }
  return connection;
}
async function dbSource(page: Page, confirmed = true, sourceConfirmed = true) {
  await install(page, 'database');
  const connection = await post<{ id: string }>(page, '/connections', { name: 'P-1 批次只读数据库', pluginId: 'database', scope: { resourceId: DB_RESOURCE_ID }, readOnlyAcknowledged: true });
  if (confirmed) { await post(page, `/connections/${connection.id}/confirm`); await post(page, `/connections/${connection.id}/sync`); if (sourceConfirmed) await confirmItems(page); }
  await refresh(page); return connection;
}
async function remoteSource(page: Page, pluginId: 'email' | 'sharepoint', imported = true, confirmed = true) {
  await install(page, pluginId);
  const name = pluginId === 'email' ? '邮件只读来源' : '文档库只读来源';
  const connection = await post<{ id: string }>(page, '/connections', { name, pluginId, scope: { resourceId: pluginId === 'email' ? MAIL_RESOURCE_ID : SHAREPOINT_RESOURCE_ID }, readOnlyAcknowledged: true });
  await post(page, `/connections/${connection.id}/confirm`);
  const preview = await response<Preview>(page.request.get(`${ROOT}/connections/${connection.id}/preview`));
  if (imported) { await post(page, `/connections/${connection.id}/import`, { ids: preview.items.map(item => item.id) }); if (confirmed) await confirmItems(page); }
  await refresh(page); return { ...connection, name, preview };
}
async function analyse(page: Page) {
  await post(page, '/analyses');
  await response(page.request.post('/__test/knowledge/advance', { data: {} }));
  await refresh(page);
  expect((await getOverview(page)).analyses.at(-1)?.status).toBe('completed');
}
const card = (page: Page, name: string) => page.locator('.knowledge-recommendation').filter({ has: page.locator(`input[value=${JSON.stringify(name)}]`) });
async function lockRole(page: Page, name: string, replacement = '人工保留职责') {
  const target = card(page, name);
  await target.locator('textarea').fill('这是人工核对后保留的说明。');
  await target.getByLabel('名称', { exact: true }).fill(replacement);
  await card(page, replacement).getByRole('button', { name: '保存并人工锁定', exact: true }).click();
  await expect(card(page, replacement).getByText('人工锁定', { exact: true })).toBeVisible();
  return replacement;
}
async function querySetup(page: Page) {
  const connection = await dbSource(page);
  const template = await post<{ id: string }>(page, `/connections/${connection.id}/templates`, { sql: SQL, params: ['lot_id'] });
  await refresh(page);
  await page.getByLabel('已批准模板').selectOption(template.id);
  await page.getByLabel('执行参数（JSON 数组）').fill('["LOT-P1"]');
  return { connection, template };
}
async function queryUi(page: Page) {
  await page.getByLabel('执行参数（JSON 数组）').fill('["LOT-P1"]');
  const result = page.waitForResponse(response => response.url().endsWith('/query') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '执行已批准模板', exact: true }).click();
  expect((await result).ok()).toBe(true);
  await expect(page.getByRole('region', { name: '数据库当前事实结果' })).toBeVisible();
}
async function assertDenied(page: Page, path: string, data: unknown, identity?: string) {
  const denied = await page.request.post(ROOT + path, { data, headers: identity ? { 'x-dev-user': identity } : undefined });
  expect(denied.status(), await denied.text()).toBeGreaterThanOrEqual(400);
  expect(denied.status()).toBeLessThan(500);
}

test.beforeEach(async ({ page }) => {
  await response(page.request.post('/__test/knowledge/reset', { data: {} }));
  await page.goto('/#knowledge');
  await expect(page.getByTestId('plugin-local-file')).toBeVisible();
});

test('[qa-enablement#1] New company begins without invented knowledge', async ({ page }) => {
  await test.step('real empty tenant has no sources, candidates or analyses', async () => {
    const overview = await getOverview(page); expect(overview.items).toEqual([]); expect(overview.recommendations).toEqual([]); expect(overview.analyses).toEqual([]);
    await expect(page.getByText('还没有资料。上传后将在这里显示解析与确认状态。', { exact: true })).toBeVisible();
  });
});
test('[qa-enablement#2] Recommendations gated before knowledge confirmation', async ({ page }) => {
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
  await assertDenied(page, '/analyses', {}); expect((await getOverview(page)).recommendations).toEqual([]);
});
test('[qa-enablement#3] Manual role is distinguished from document inference', async ({ page }) => {
  await page.getByLabel('人工角色名称', { exact: true }).fill('人工运营协调员'); await page.getByLabel('人工角色说明', { exact: true }).fill('人工记录的既有职责。'); await page.getByRole('button', { name: '添加人工角色', exact: true }).click();
  await expect(card(page, '人工运营协调员')).toContainText('人工补充 · 不是文档推断');
  const manual = (await getOverview(page)).recommendations[0]!; expect(manual.origin).toBe('manual'); expect(manual.evidence).toEqual([]); expect(manual.humanLocked).toBe(true);
  await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-enablement#4] Actual local text file is read', async ({ page }) => {
  await localFile(page, false); await page.getByText('查看当前版本原文与定位', { exact: true }).click();
  await expect(page.locator('.knowledge-item-preview')).toContainText(ROLE_FILE.split('\n')[0]!);
  const item = (await getOverview(page)).items[0]!; const preview = await response<{ chunks: { text: string; locator: string }[] }>(page.request.get(`${ROOT}/items/${item.id}/preview?version=${item.version}`)); expect(preview.chunks.map(chunk => chunk.text).join('\n')).toBe(ROLE_FILE); expect(preview.chunks[0]!.locator).toContain('#L1');
});
test('[qa-enablement#5] Imported but unconfirmed knowledge cannot generate recommendations', async ({ page }) => {
  await localFile(page, false); expect((await getOverview(page)).items.every(item => !item.confirmed)).toBe(true); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled(); await assertDenied(page, '/analyses', {});
});
test('[qa-enablement#6] Four roles follow distinct evidence-bearing responsibilities', async ({ page }) => {
  await localFile(page); await analyse(page); const roles = (await getOverview(page)).recommendations.filter(rec => rec.kind === 'employee'); expect(roles.map(role => role.name).sort()).toEqual(['业务主管', '仓储专员', '财务专员', '采购专员'].sort()); expect(new Set(roles.map(role => role.description)).size).toBe(4); for (const role of roles) await expect(card(page, role.name)).toBeVisible();
});
test('[qa-enablement#7] Every inferred role cites a source line', async ({ page }) => {
  await localFile(page); await analyse(page); for (const role of (await getOverview(page)).recommendations.filter(rec => rec.kind === 'employee')) { expect(role.evidence.length).toBeGreaterThan(0); await card(page, role.name).locator('summary').click(); await expect(card(page, role.name).locator('.knowledge-evidence')).toContainText('#L'); for (const evidence of role.evidence) expect(ROLE_FILE.slice(evidence.start, evidence.end)).toBe(evidence.quote); }
});
test('[qa-enablement#8] Tools proposed alongside roles before business execution', async ({ page }) => {
  await localFile(page); const before = await response<unknown>(page.request.get('/api/v1/tools/')); await analyse(page); const tools = (await getOverview(page)).recommendations.filter(rec => rec.kind === 'tool'); expect(tools).toHaveLength(1); expect(tools[0]!.evidence.length).toBeGreaterThan(0); await expect(card(page, tools[0]!.name)).toContainText('工具草案'); expect(await response(page.request.get('/api/v1/tools/'))).toEqual(before);
});
test('[qa-enablement#10] Reanalysis preserves human edits and presents differences', async ({ page }) => {
  await localFile(page); await analyse(page); const retained = await lockRole(page, '采购专员'); await control(page, { kind: 'model', suffix: '二次分析修改。' }); await analyse(page); const recommendation = (await getOverview(page)).recommendations.find(rec => rec.name === retained)!; expect(recommendation.description).toBe('这是人工核对后保留的说明。'); expect(recommendation.proposedChange?.description).toContain('二次分析修改'); await expect(card(page, retained)).toContainText('分析提出了修改，尚未覆盖人工内容');
});
test('[qa-enablement#50] Reanalysis preserves explicit role deletion instead of recreating it', async ({ page }) => {
  await localFile(page); await analyse(page); await card(page, '采购专员').getByRole('button', { name: '删除草案', exact: true }).click(); await expect(card(page, '采购专员')).toHaveCount(0); await analyse(page); expect((await getOverview(page)).recommendations.some(rec => rec.name === '采购专员')).toBe(false); await expect(card(page, '采购专员')).toHaveCount(0);
});

test('[qa-database-knowledge#1] Documents and databases share enterprise knowledge entry', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '导入与确认资料', exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: '只读数据库来源', exact: true })).toBeVisible(); await expect(page.getByTestId('plugin-database')).toContainText('只读数据库');
});
test('[qa-database-knowledge#2] Data source requires explicit read-only policy acknowledgement', async ({ page }) => {
  await install(page, 'database'); await refresh(page); await page.getByLabel('数据库连接名称', { exact: true }).fill('待确认数据库'); await expect(page.getByRole('button', { name: '创建数据库连接草案', exact: true })).toBeDisabled(); await assertDenied(page, '/connections', { name: 'forged', pluginId: 'database', scope: { resourceId: DB_RESOURCE_ID } }); await page.getByLabel('我已核对数据库范围，并确认使用独立只读账号接入', { exact: true }).check(); const created = page.waitForResponse(result => result.url().endsWith('/knowledge/connections') && result.request().method() === 'POST'); await page.getByRole('button', { name: '创建数据库连接草案', exact: true }).click(); expect((await created).status()).toBe(201); expect((await getOverview(page)).connections[0]).toMatchObject({ name: '待确认数据库', status: 'draft' });
});
test('[qa-database-knowledge#3] Connection string cannot be pasted into credential reference', async ({ page }) => {
  await install(page, 'database'); await assertDenied(page, '/connections', { name: 'unsafe', pluginId: 'database', readOnlyAcknowledged: true, credentialRef: 'postgres://raw:secret@outside/database', scope: { resourceId: DB_RESOURCE_ID } }); await assertDenied(page, '/connections', { name: 'unsafe', pluginId: 'database', readOnlyAcknowledged: true, scope: { resourceId: DB_RESOURCE_ID, connectionString: 'postgres://raw:secret@outside/database' } }); expect((await getOverview(page)).connections).toEqual([]); await expect(page.locator('.database-source')).toContainText('请勿');
});
test('[qa-database-knowledge#4] Database source can start without any uploaded file', async ({ page }) => { await dbSource(page); expect((await getOverview(page)).items.length).toBeGreaterThan(0); expect((await getOverview(page)).items.some(item => item.title.endsWith('.md'))).toBe(false); await expect(page.locator('.knowledge-items')).toContainText('approved_lots'); });
test('[qa-database-knowledge#5] Unconfirmed database cannot feed recommendations', async ({ page }) => { const connection = await dbSource(page, false); await assertDenied(page, `/connections/${connection.id}/sync`, {}); await assertDenied(page, '/analyses', {}); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled(); });
test('[qa-database-knowledge#6] Confirming source forms logical enterprise knowledge space', async ({ page }) => { await dbSource(page, true, false); await expect(page.getByRole('form', { name: '知识空间命名' })).toBeVisible(); await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toBeVisible(); await confirmItems(page); await refresh(page); expect((await getOverview(page)).items.every(item => item.confirmed)).toBe(true); });
test('[qa-database-knowledge#7] Knowledge space can be named without copying database', async ({ page }) => {
  await dbSource(page); const before = await response(page.request.get('/__test/knowledge/metadata')); await page.getByLabel('知识空间名称', { exact: true }).fill('批次管理知识空间'); await page.getByRole('button', { name: '保存知识空间名称', exact: true }).click(); await expect(page.getByLabel('知识空间名称', { exact: true })).toHaveValue('批次管理知识空间'); expect((await getOverview(page)).spaceName).toBe('批次管理知识空间'); expect(await response(page.request.get('/__test/knowledge/metadata'))).toEqual(before);
});
test('[qa-database-knowledge#8] Confirmed metadata can support role candidates', async ({ page }) => { await dbSource(page); await analyse(page); await expect(card(page, '数据分析员')).toBeVisible(); expect((await getOverview(page)).recommendations.find(rec => rec.name === '数据分析员')!.evidence[0]!.locator).toContain('@schema '); });
test('[qa-database-knowledge#10] Schema does not become a published SOP', async ({ page }) => { await dbSource(page); await analyse(page); expect((await getOverview(page)).recommendations.some(rec => rec.kind === 'sop')).toBe(false); await expect(page.locator('.knowledge-recommendations')).not.toContainText('已发布'); });
test('[qa-database-knowledge#11] Database metadata recommends read-only query placeholder without inventing mail workflow', async ({ page }) => { await dbSource(page); await analyse(page); await expect(card(page, '只读批次查询')).toContainText('工具草案'); const candidates = (await getOverview(page)).recommendations; expect(candidates.map(candidate => candidate.name).join(' ')).not.toMatch(/邮件|发送|发票审批/); expect(candidates.every(candidate => candidate.evidence.length > 0)).toBe(true); });
test('[qa-database-knowledge#20] Row update expires fact result without changing metadata analysis', async ({ page }) => {
  await querySetup(page); await analyse(page); await queryUi(page); const before = await response(page.request.get('/__test/knowledge/metadata')); await control(page, { kind: 'database', rowValue: 144 }); await page.getByRole('button', { name: '核对事实是否仍有效', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('结果已过期'); await expect(page.getByRole('region', { name: '数据库当前事实结果' })).toHaveCount(0); expect(await response(page.request.get('/__test/knowledge/metadata'))).toEqual(before);
});
test('[qa-database-knowledge#21] Next query reads new synthetic value', async ({ page }) => { await querySetup(page); await queryUi(page); await expect(page.getByRole('cell', { name: '120', exact: true })).toBeVisible(); await control(page, { kind: 'database', rowValue: 144 }); await page.getByRole('button', { name: '核对事实是否仍有效', exact: true }).click(); await queryUi(page); await expect(page.getByRole('cell', { name: '144', exact: true })).toBeVisible(); await expect(page.getByRole('cell', { name: '120', exact: true })).toHaveCount(0); });
test('[qa-database-knowledge#22] Data change does not silently rewrite schema rules or team', async ({ page }) => { const connection = await dbSource(page); await analyse(page); const before = await getOverview(page); await control(page, { kind: 'database', rowValue: 155 }); await post(page, `/connections/${connection.id}/sync`); const after = await getOverview(page); expect(after.recommendations).toEqual(before.recommendations); expect(after.items.map(item => item.version)).toEqual(before.items.map(item => item.version)); await refresh(page); await expect(card(page, '数据分析员')).toBeVisible(); });
test('[qa-database-knowledge#24] Reads and denials leave audit metadata', async ({ page }) => {
  const { connection, template } = await querySetup(page); await queryUi(page); await assertDenied(page, `/connections/${connection.id}/query`, { templateId: template.id, args: ['LOT-P1'] }, OTHER_OWNER); const audit = await response<{ entries: { action: string; result: string }[] }>(page.request.get('/__test/knowledge/audit')); expect(audit.entries.some(entry => entry.result === 'ok' && /fact|query/.test(entry.action))).toBe(true); expect(audit.entries.some(entry => entry.result === 'denied')).toBe(true); expect(JSON.stringify(audit)).not.toMatch(/driver-private|SELECT |LOT-P1|synthetic-quantity/); await expect(page.getByRole('region', { name: '数据库当前事实结果' })).toBeVisible();
});
test('[qa-database-knowledge#25] Unavailable source cannot be queried', async ({ page }) => { const { connection, template } = await querySetup(page); await control(page, { kind: 'database', available: false }); const denied = await page.request.post(`${ROOT}/connections/${connection.id}/query`, { data: { templateId: template.id, args: ['LOT-P1'] } }); expect(denied.ok()).toBe(false); const audit = await response<{ counters: { database: number } }>(page.request.get('/__test/knowledge/audit')); expect(audit.counters.database).toBe(0); await expect(page.getByRole('region', { name: '数据库当前事实结果' })).toHaveCount(0); });
test('[qa-database-knowledge#26] Parameterized Lot lookup stays inside approved project', async ({ page }) => {
  const { connection, template } = await querySetup(page); const fact = await post<{ rows: Record<string, unknown>[] }>(page, `/connections/${connection.id}/query`, { templateId: template.id, args: ['LOT-P1'] }); expect(fact.rows.every(row => row.project_id === 'P-1')).toBe(true); expect((await post<{ rows: unknown[] }>(page, `/connections/${connection.id}/query`, { templateId: template.id, args: ['LOT-P2'] })).rows).toEqual([]); await assertDenied(page, `/connections/${connection.id}/query`, { templateId: template.id, args: ['LOT-P1'] }, OWNER_WITHOUT_PROJECT); await queryUi(page); await expect(page.getByRole('cell', { name: 'P-1', exact: true })).toBeVisible();
});
test('[qa-database-knowledge#27] Database column names do not split words', async ({ page }) => { await querySetup(page); await queryUi(page); const heading = page.getByRole('columnheader', { name: 'manufacturing_order_reference', exact: true }); await expect(heading).toBeVisible(); expect(await heading.evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); return range.getClientRects().length; })).toBe(1); });
test('[qa-database-knowledge#28] Last fact column is reachable through local horizontal scroll', async ({ page }) => { await querySetup(page); await queryUi(page); await page.setViewportSize({ width: 390, height: 844 }); const scroller = page.getByLabel('可横向滚动的查询结果', { exact: true }); await scroller.scrollIntoViewIfNeeded(); expect(await scroller.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true); await scroller.evaluate(element => { element.scrollLeft = element.scrollWidth; }); await expect(page.getByRole('columnheader', { name: 'final_quality_disposition', exact: true })).toBeInViewport(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); });
test('[qa-database-knowledge#30] Database capability cannot be changed to write in UI', async ({ page }) => { await install(page, 'database'); await refresh(page); await expect(page.locator('.database-source')).toContainText('独立只读'); await expect(page.locator('.database-source').getByRole('option', { name: /写入|write|delete/i })).toHaveCount(0); await expect(page.locator('.database-source').getByLabel(/执行模式|读写模式/)).toHaveCount(0); });
test('[qa-database-knowledge#31] Saving write effect is refused even if DOM is manipulated', async ({ page }) => {
  await install(page, 'database'); await refresh(page); await page.locator('.database-source form').first().evaluate(form => { const input = document.createElement('input'); input.name = 'effect'; input.value = 'write'; form.append(input); }); await assertDenied(page, '/connections', { name: 'forged DOM write', pluginId: 'database', readOnlyAcknowledged: true, effect: 'write', scope: { resourceId: DB_RESOURCE_ID } }); expect((await getOverview(page)).connections).toEqual([]); await expect(page.locator('.database-source')).toContainText('只读');
});
test('[qa-database-knowledge#33] Personal project options stay inside source permission', async ({ page }) => { await install(page, 'database'); await refresh(page); const overview = await getOverview(page); expect(overview.databaseResources.map(resource => resource.id)).toEqual([DB_RESOURCE_ID]); await expect(page.locator('.database-source')).not.toContainText('P-2'); const denied = await response<Overview>(page.request.get(`${ROOT}/overview`, { headers: { 'x-dev-user': OWNER_WITHOUT_PROJECT } })); expect(denied.databaseResources).toEqual([]); });
test('[qa-database-knowledge#34] Forged personal scope cannot expand source permission', async ({ page }) => {
  await install(page, 'database'); await assertDenied(page, '/connections', { name: 'expanded', pluginId: 'database', readOnlyAcknowledged: true, projectIds: ['P-2'], scope: { resourceId: DB_RESOURCE_ID, projectIds: ['P-2'] } }); await assertDenied(page, '/connections', { name: 'expanded', pluginId: 'database', readOnlyAcknowledged: true, scope: { resourceId: DB_RESOURCE_ID, tables: { payroll: { columns: ['salary'] } }, maxRows: 99999 } }); expect((await getOverview(page)).connections).toEqual([]); await refresh(page); await expect(page.locator('.database-source')).not.toContainText('payroll');
});
test('[qa-database-knowledge#35] Schema change withdraws source confirmation and invalidates old analysis', async ({ page }) => {
  const connection = await dbSource(page); await analyse(page); await control(page, { kind: 'database', schemaChanged: true }); await post(page, `/connections/${connection.id}/sync`); const overview = await getOverview(page); expect(overview.items.every(item => !item.confirmed)).toBe(true); expect(overview.analyses.some(run => run.status === 'stale')).toBe(true); await refresh(page); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-database-knowledge#36] Metadata reanalysis preserves human role edits', async ({ page }) => { const connection = await dbSource(page); await analyse(page); const retained = await lockRole(page, '数据分析员'); await control(page, { kind: 'database', schemaChanged: true }); await post(page, `/connections/${connection.id}/sync`); await confirmItems(page); await analyse(page); await expect(card(page, retained)).toContainText('人工锁定'); await expect(card(page, retained)).toContainText('分析提出了修改'); });

test('[qa-source-plugins#1] Four knowledge-source manifests visible', async ({ page }) => { for (const id of ['local-file', 'database', 'email', 'sharepoint']) await expect(page.getByTestId(`plugin-${id}`)).toBeVisible(); expect((await getOverview(page)).plugins).toHaveLength(4); });
test('[qa-source-plugins#2] Local single-import built in, remote plugin not installed', async ({ page }) => { const overview = await getOverview(page); expect(overview.plugins.find(plugin => plugin.id === 'local-file')).toMatchObject({ builtIn: true, installed: true }); expect(overview.plugins.filter(plugin => plugin.id !== 'local-file').every(plugin => !plugin.installed)).toBe(true); await expect(page.getByTestId('plugin-local-file')).toContainText('内置插件'); await expect(page.getByTestId('plugin-email')).toContainText('未安装'); });
test('[qa-source-plugins#3] Catalog install has no implied connection or source', async ({ page }) => { await page.getByRole('button', { name: '安装SharePoint插件', exact: true }).click(); await expect(page.getByTestId('plugin-sharepoint')).not.toContainText('未安装'); const overview = await getOverview(page); expect(overview.connections).toEqual([]); expect(overview.items).toEqual([]); expect(overview.recommendations).toEqual([]); });
test('[qa-source-plugins#6] Import does not imply source confirmation', async ({ page }) => { await localFile(page, false); await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toBeVisible(); expect((await getOverview(page)).items[0]!.confirmed).toBe(false); });
test('[qa-source-plugins#7] Mail plugin installation creates no connection or source', async ({ page }) => { await page.getByRole('button', { name: '安装企业邮件插件', exact: true }).click(); await expect(page.getByTestId('plugin-email')).toContainText('已启用'); expect((await getOverview(page)).connections).toEqual([]); expect((await getOverview(page)).items).toEqual([]); });
test('[qa-source-plugins#9] Connection requires explicit read-only scope', async ({ page }) => {
  await install(page, 'email'); await refresh(page); await page.getByRole('combobox', { name: /来源插件/ }).selectOption('email'); await page.getByLabel('连接名称', { exact: true }).fill('邮件范围'); await expect(page.getByRole('button', { name: '创建连接草案', exact: true })).toBeDisabled(); await assertDenied(page, '/connections', { name: 'forged mail', pluginId: 'email', scope: { resourceId: MAIL_RESOURCE_ID } }); await page.getByLabel('我已核对来源范围，并确认仅以只读方式接入', { exact: true }).check(); const created = page.waitForResponse(result => result.url().endsWith('/knowledge/connections') && result.request().method() === 'POST'); await page.getByRole('button', { name: '创建连接草案', exact: true }).click(); expect((await created).status()).toBe(201); expect((await getOverview(page)).connections[0]).toMatchObject({ name: '邮件范围', status: 'draft' });
});
test('[qa-source-plugins#11] Preview shows mailbox folder and date scope', async ({ page }) => {
  const connection = await remoteSource(page, 'email', false); const row = page.locator('.knowledge-source-list > li').filter({ has: page.getByText(connection.name, { exact: true }) }); await row.getByRole('button', { name: '预览来源范围与资料', exact: true }).click(); const preview = page.getByRole('region', { name: `${connection.name} 来源元数据预览` }); await expect(preview).toContainText('finance@synthetic.invalid'); await expect(preview).toContainText('Inbox'); await expect(preview).toContainText('2026-01-01'); await expect(preview).toContainText('权限受限资料：1'); await expect(preview).not.toContainText('禁止泄露的私人薪资标题');
});
test('[qa-source-plugins#14] Forged preview selection cannot bypass ACL', async ({ page }) => {
  const connection = await remoteSource(page, 'email', false); await assertDenied(page, `/connections/${connection.id}/import`, { ids: ['email-denied', 'forged-selection-hash'] }); await control(page, { kind: 'mail', acl: 'revoked' }); await assertDenied(page, `/connections/${connection.id}/import`, { ids: connection.preview.items.map(item => item.id) }); const audit = await response<{ counters: { email: number } }>(page.request.get('/__test/knowledge/audit')); expect(audit.counters.email).toBe(0); expect((await getOverview(page)).items).toEqual([]); await expect(page.locator('main')).not.toContainText('禁止泄露的私人薪资标题');
});
test('[qa-source-plugins#16] Imported mail independently awaits confirmation with references and versions', async ({ page }) => {
  const connection = await remoteSource(page, 'email', false); const row = page.locator('.knowledge-source-list > li').filter({ has: page.getByText(connection.name, { exact: true }) }); await row.getByRole('button', { name: '预览来源范围与资料', exact: true }).click(); const preview = page.getByRole('region', { name: `${connection.name} 来源元数据预览` }); await expect(preview.getByRole('checkbox')).toHaveCount(1); await preview.getByRole('checkbox').check(); const imported = page.waitForResponse(result => result.url().endsWith(`/connections/${connection.id}/import`)); await preview.getByRole('button', { name: '导入所选资料（1）', exact: true }).click(); expect((await imported).ok()).toBe(true); await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toBeVisible(); const item = (await getOverview(page)).items[0]!; expect(item.confirmed).toBe(false); expect(item.version).toBe('v1'); expect(item.locator).toContain('synthetic-mail://'); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-source-plugins#17] Confirmed mixed knowledge creates evidence-based candidates', async ({ page }) => {
  await remoteSource(page, 'email'); await remoteSource(page, 'sharepoint'); await analyse(page); const roles = (await getOverview(page)).recommendations.filter(rec => rec.kind === 'employee'); expect(roles).toHaveLength(4); expect(new Set(roles.flatMap(role => role.evidence.map(evidence => evidence.sourceId))).size).toBe(2); for (const role of roles) { expect(role.evidence.length).toBeGreaterThan(0); await expect(card(page, role.name)).toBeVisible(); }
});
test('[qa-source-plugins#20] Delta does not overwrite human role edit', async ({ page }) => { const connection = await remoteSource(page, 'email'); await analyse(page); const retained = await lockRole(page, '采购专员'); await control(page, { kind: 'mail', text: '角色：采购专员；责任：核对新增供应商与采购版本。' }); await post(page, `/connections/${connection.id}/sync`); await refresh(page); await expect(card(page, retained)).toBeVisible(); expect((await getOverview(page)).recommendations.find(rec => rec.name === retained)!.description).toBe('这是人工核对后保留的说明。'); });
test('[qa-source-plugins#21] Reanalysis preserves human edits', async ({ page }) => { const connection = await remoteSource(page, 'email'); await analyse(page); const retained = await lockRole(page, '采购专员'); await control(page, { kind: 'mail', text: '角色：采购专员；责任：核对新增供应商与采购版本。' }); await post(page, `/connections/${connection.id}/sync`); await confirmItems(page); await analyse(page); await expect(card(page, retained)).toContainText('分析提出了修改'); expect((await getOverview(page)).recommendations.find(rec => rec.name === retained)!.proposedChange?.description).toContain('新增供应商'); });
test('[qa-source-plugins#23] Recovery requires source confirmation again', async ({ page }) => {
  const connection = await remoteSource(page, 'email'); await control(page, { kind: 'mail', acl: 'unknown' }); await post(page, `/connections/${connection.id}/sync`); expect((await getOverview(page)).items).toEqual([]); await control(page, { kind: 'mail', acl: 'allowed', bumpVersion: true }); await post(page, `/connections/${connection.id}/sync`); await refresh(page); expect((await getOverview(page)).items.every(item => !item.confirmed)).toBe(true); await expect(page.getByRole('button', { name: '确认此版本', exact: true })).toBeVisible(); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-source-plugins#25] Forged source confirmation cannot override revoked ACL', async ({ page }) => {
  const connection = await remoteSource(page, 'email'); const item = (await getOverview(page)).items[0]!; await control(page, { kind: 'mail', acl: 'revoked' }); await assertDenied(page, `/items/${item.id}/confirm`, { version: item.version }); await post(page, `/connections/${connection.id}/sync`); await assertDenied(page, `/items/${item.id}/confirm`, { version: item.version }); await refresh(page); expect((await getOverview(page)).items).toEqual([]); await expect(page.getByRole('button', { name: '开始分析', exact: true })).toBeDisabled();
});
test('[qa-source-plugins#28] Paused knowledge plugin blocks its source references', async ({ page }) => {
  await remoteSource(page, 'email'); await analyse(page); await page.getByRole('button', { name: '暂停企业邮件插件', exact: true }).click(); await expect(page.getByTestId('plugin-email')).toContainText('已暂停'); expect((await getOverview(page)).items).toEqual([]); expect((await getOverview(page)).recommendations).toEqual([]); const search = await response<{ hits: unknown[] }>(page.request.get(`${ROOT}/search?q=${encodeURIComponent('采购')}`)); expect(search.hits).toEqual([]); await expect(card(page, '采购专员')).toHaveCount(0);
});
test('[qa-source-plugins#29] Database plugin leads to existing scoped read-only configuration', async ({ page }) => { await page.getByRole('button', { name: '安装只读数据库插件', exact: true }).click(); await page.getByRole('button', { name: '配置只读数据库来源', exact: true }).click(); await expect(page.getByRole('heading', { name: '只读数据库来源', exact: true })).toBeInViewport(); await expect(page.getByLabel('DBA 批准的资源')).toBeVisible(); await expect(page.locator('.database-source-scope')).toContainText('approved_lots'); });
test('[qa-source-plugins#30] Installing knowledge plugins did not install employee business tools', async ({ page }) => { const before = await response(page.request.get('/api/v1/tools/')); for (const id of ['database', 'email', 'sharepoint']) await install(page, id); expect(await response(page.request.get('/api/v1/tools/'))).toEqual(before); expect((await getOverview(page)).connections).toEqual([]); await refresh(page); await expect(page.getByTestId('plugin-email')).toContainText('已启用'); });
