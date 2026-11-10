import { test, expect } from './fixtures.js';

const drawer = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: '工作项' });
async function as(page: import('@playwright/test').Page, who: string) { await page.setExtraHTTPHeaders({ 'x-dev-user': who }); await page.goto('/#work'); await page.reload(); }
const owner = { 'x-dev-user': 'e2e-owner|owner|' };

test('durable batch approval submits selected rows once, recovers an unknown outcome only by read-back, and blocks a missing connector', async ({ page }) => {
  const id = `batch-${Date.now()}`; const project = `${id}-project`; const staff = `${id}-staff`;
  await page.request.post('/__e2e/longwork/driver', { data: { enabled: true } });
  const res = await page.request.post('/api/v1/long-items/batches', { headers: owner, data: { id, projectId: project, assigneeUserId: staff, rows: [
    { id: 'conflict', clean: false, payload: { amount: -1 } }, { id: 'one', payload: { amount: 10 } },
    { id: 'two', payload: { amount: 20, fixtureOutcome: 'unknown' } }, { id: 'three', payload: { amount: 30 } },
  ] } }); expect(res.ok()).toBe(true); const actions = await res.json() as Array<{ id: string; rowId: string }>;
  await as(page, `${staff}|employee|${project}`); await page.locator(`[data-item="long-batch:${id}"]`).click();
  const view = drawer(page);
  await expect(view.locator('[data-long-row]').first()).toHaveAttribute('data-long-row', 'conflict');
  await expect(view.getByRole('checkbox', { name: '选择行 conflict', exact: true })).toBeDisabled();
  await view.getByRole('checkbox', { name: '选择行 one', exact: true }).check();
  await view.getByRole('checkbox', { name: '选择行 two', exact: true }).check();
  await view.getByRole('button', { name: '批准所选行', exact: true }).click();
  await expect(view.getByRole('status')).toContainText('尚未执行');
  await view.getByRole('button', { name: '执行已批准的所选行' }).click();
  await expect(view.locator('[data-long-row="one"]')).toContainText('已回读核验');
  await expect(view.locator('[data-long-row="two"]')).toContainText('结果未知，只能回读');
  await expect(view.getByRole('checkbox', { name: '选择行 two', exact: true })).toBeDisabled();
  await view.getByRole('button', { name: '只回读未知结果' }).click();
  await expect(view.locator('[data-long-row="two"]')).toContainText('已回读核验');
  const ledger = (await (await page.request.get('/__e2e/longwork/ledger')).json()) as Record<string, { writes: number; reads: number }>;
  expect(ledger[actions.find(a => a.rowId === 'one')!.id]!.writes).toBe(1);
  expect(ledger[actions.find(a => a.rowId === 'two')!.id]!.writes).toBe(1);
  await view.getByRole('checkbox', { name: '选择行 three', exact: true }).check(); await view.getByRole('button', { name: '批准所选行', exact: true }).click();
  await page.request.post('/__e2e/longwork/driver', { data: { enabled: false } });
  await view.getByRole('button', { name: '执行已批准的所选行' }).click();
  await expect(view.getByRole('status')).toContainText('没有提交任何外部动作');
  await expect(view.locator('[data-long-row="three"]')).toContainText('已批准，未提交');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('batch-mobile.png'), fullPage: true });
});

test('collection requests have separate verified delivery, private personal replies and a frozen deadline summary', async ({ page }) => {
  const id = `collect-${Date.now()}`; const project = `${id}-project`; const collector = `${id}-collector`; const first = `${id}-first`; const missing = `${id}-missing`;
  await page.request.post('/__e2e/longwork/driver', { data: { enabled: true } });
  const res = await page.request.post('/api/v1/long-items/collections', { headers: owner, data: { id, projectId: project, deadline: new Date(Date.now() + 60000).toISOString(), recipients: [first, missing], assigneeUserId: collector, approverUserId: collector } });
  expect(res.ok()).toBe(true);
  await as(page, `${collector}|employee|${project}`); await page.locator(`[data-item="long-collection:${id}"]`).click();
  await expect(drawer(page)).toContainText('已回读核验的请求发送：0 / 2');
  await page.locator(`[data-item="long-batch:collection:${id}"]`).click();
  await drawer(page).getByRole('checkbox', { name: `选择行 ${first}`, exact: true }).check();
  await drawer(page).getByRole('checkbox', { name: `选择行 ${missing}`, exact: true }).check();
  await drawer(page).getByRole('button', { name: '批准所选行', exact: true }).click(); await drawer(page).getByRole('button', { name: '执行已批准的所选行' }).click();
  await expect(drawer(page).getByRole('status')).toContainText('已处理 2 行');
  await page.locator(`[data-item="long-collection:${id}"]`).click(); await expect(drawer(page)).toContainText('已回读核验的请求发送：2 / 2');
  await as(page, `${first}|employee|${project}`); await expect(page.locator('[data-item]')).toHaveCount(1);
  await page.locator(`[data-item="long-response:${id}:${first}"]`).click();
  await drawer(page).getByRole('textbox', { name: '我的回复凭证' }).fill('Private response from the first person');
  await drawer(page).getByRole('button', { name: '保存我的回复' }).click(); await expect(drawer(page).getByRole('status')).toContainText('未经系统核验');
  await as(page, `${missing}|employee|${project}`); await page.locator(`[data-item="long-response:${id}:${missing}"]`).click();
  await expect(drawer(page)).not.toContainText('Private response from the first person');
  await page.request.post('/__e2e/longwork/advance', { data: { ms: 120000 } });
  await as(page, `${collector}|employee|${project}`); await page.locator(`[data-item="long-collection:${id}"]`).click();
  await expect(drawer(page)).toContainText('已截止，汇总固定'); await expect(drawer(page)).toContainText(`截止时未回复：${missing}`);
  await expect(drawer(page)).toContainText('Private response from the first person');
  await page.screenshot({ path: test.info().outputPath('collection-summary.png'), fullPage: true });
  await as(page, `${missing}|employee|${project}`); await page.locator(`[data-item="long-response:${id}:${missing}"]`).click();
  await expect(drawer(page).getByRole('button', { name: '保存我的回复' })).toHaveCount(0);
  await page.request.post('/__e2e/longwork/driver', { data: { enabled: false } });
});
