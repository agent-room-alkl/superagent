/**
 * T-48 / qa-outcomes: validation with regression cases, stale validation, revalidation, SOP packs from the knowledge
 * analysis, and knowledge-change impact — all on the real page. The SOP runtime is the contract test double;
 * the knowledge overview is answered in the analysis's response shape.
 */
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

test.describe.configure({ mode: 'serial' });

const ok = { nodes: [{ id: 't', kind: 'trigger', label: '月末对账', ref: 'date:month-end' }, { id: 'a', kind: 'agent', label: '超级智能体分派' }, { id: 'h', kind: 'human_review', label: '财务复核' }], edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'h' }] };
const ev = (sourceId: string, version: string, quote: string, line: number) => ({ sourceId, version, start: 0, end: quote.length, locator: `付款制度.md#L${line}`, quote });

async function knowledge(page: Page, versions: { s1: string; s2: string | null }) {
  const evidence = [ev('s1', versions.s1, '收到发票后先核对采购单', 4), ...(versions.s2 ? [ev('s2', versions.s2, '金额超过 5000 需经理审批', 9)] : [])];
  await page.route('**/api/v1/knowledge/overview', (route) =>
    route.fulfill({ json: { recommendations: [{ id: 'k1', key: 'invoice-intake', kind: 'sop', name: '发票受理', description: '受理供应商发票', evidence, humanLocked: false, deleted: false }] } }),
  );
}
const rules = { requiredFields: ['invoiceNo', 'amount'], threshold: { field: 'amount', max: 5000 } };
const validateBtn = (page: Page) => page.getByRole('button', { name: '校验（运行回归用例）' });
const publishBtn = (page: Page) => page.getByRole('button', { name: '发布', exact: true });

test('validation runs the regression cases; an edit makes it stale and says so; revalidation allows publishing', async ({ page, request }) => {
  expect((await request.post('/api/v1/sop/drafts', { data: { sopId: 'e2e.month-end', definition: { ...rules, employeeStatus: 'active', graph: ok } } })).status()).toBe(200);
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption('e2e.month-end');
  await expect(publishBtn(page)).toBeDisabled(); // never published without a validation
  await validateBtn(page).click();
  await expect(page.getByRole('list', { name: '回归用例' }).locator('li')).toHaveCount(10);
  await expect(publishBtn(page)).toBeEnabled();

  // edit → unsaved, then saved: the old validation no longer counts and the page explains why
  await page.getByLabel('节点类型').selectOption('agent');
  await page.getByLabel('节点名称').fill('归档');
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.getByLabel('从', { exact: true }).selectOption({ label: '财务复核' });
  await page.getByLabel('到', { exact: true }).selectOption({ label: '归档' });
  await page.getByRole('button', { name: '添加连线' }).click();
  await expect(page.locator('[data-block="dirty"]')).toContainText('保存后需要重新校验');
  await expect(publishBtn(page)).toBeDisabled();
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.locator('[data-block="stale"]')).toContainText('草稿已修改，之前的校验已失效（校验于第 1 次修订，当前第 2 次）');
  await expect(publishBtn(page)).toBeDisabled();
  // the runtime refuses a stale publish too
  const versions = (await (await request.get('/api/v1/sop/e2e.month-end/versions')).json()) as { versions: { id: string }[] };
  expect((await request.post(`/api/v1/sop/${versions.versions[0]!.id}/publish`, { data: { employees: {}, tools: {} } })).status()).toBe(409);

  await validateBtn(page).click();
  await expect(page.locator('[data-block="stale"]')).toHaveCount(0);
  await publishBtn(page).click();
  await expect(page.getByRole('status')).toContainText('v1 已发布');
});

test('a validation report missing baseline regression cases blocks publishing', async ({ page, request }) => {
  await request.post('/api/v1/sop/drafts', { data: { sopId: 'e2e.partial', definition: { ...rules, employeeStatus: 'active', graph: ok } } });
  const v = ((await (await request.get('/api/v1/sop/e2e.partial/versions')).json()) as { versions: { id: string }[] }).versions[0]!;
  await request.post(`/api/v1/sop/${v.id}/validate`, { data: { employees: {}, tools: {} } });
  // the runtime answers with a report that lacks nine of the ten regression cases
  await page.route('**/api/v1/sop/e2e.partial/versions', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { versions: { report: { gates: Record<string, unknown> } | null }[] };
    for (const x of body.versions) if (x.report) x.report.gates = { read_ok: { ok: true, detail: '' } };
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption('e2e.partial');
  await expect(page.locator('[data-block="incomplete"]')).toContainText('校验缺少回归用例');
  await expect(publishBtn(page)).toBeDisabled();
});

test('a pack starts as a draft with every rule and trigger unconfirmed; it cannot be validated or published until confirmed', async ({ page }) => {
  await knowledge(page, { s1: 'v1', s2: 'v1' });
  await page.goto('/#brain');
  await page.getByLabel('新流程编号').fill('e2e.invoice-intake');
  await page.locator('[data-pack="invoice-intake"]').getByRole('button', { name: '套用到草稿' }).click();
  await expect(page.getByRole('status')).toContainText('已保存为草稿 v1');
  const items = page.getByRole('group', { name: '流程包确认' }).getByRole('checkbox');
  await expect(items).toHaveCount(3);
  for (const c of await items.all()) await expect(c).not.toBeChecked(); // nothing auto-confirmed
  await expect(page.locator('[data-block="pack"]')).toContainText('3 项规则或触发未确认');
  await expect(validateBtn(page)).toBeDisabled();
  await expect(publishBtn(page)).toBeDisabled();

  for (const c of await items.all()) await c.check();
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.locator('[data-block="pack"]')).toHaveCount(0);
  // without run rules the real regression cases fail and say why
  await validateBtn(page).click();
  await expect(page.getByRole('status')).toContainText('校验未通过');
  await expect(page.getByRole('list', { name: '回归用例' }).locator('[data-gate="over_threshold"]')).toContainText('no threshold configured');
  await expect(publishBtn(page)).toBeDisabled();
  await page.getByLabel('必填字段').fill('发票号, 金额');
  await page.getByLabel('阈值字段').fill('金额');
  await page.getByLabel('阈值上限').fill('5000');
  await page.getByRole('button', { name: '保存草稿' }).click();
  await validateBtn(page).click(); // a confirmed pack with its rules validates
  await expect(page.getByRole('status')).toContainText('校验通过');
  await expect(publishBtn(page)).toBeEnabled();
});

test('applying a pack over an existing draft needs explicit confirmation; cancel keeps the draft', async ({ page }) => {
  await knowledge(page, { s1: 'v1', s2: 'v1' });
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption('e2e.month-end');
  // month-end has a published v1; create an open draft first
  await page.getByLabel('节点类型').selectOption('agent');
  await page.getByLabel('节点名称').fill('补充');
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByRole('status')).toContainText('已保存为草稿 v2');
  const before = await page.getByRole('group', { name: '流程图' }).locator('.sop-node').count();

  await page.locator('[data-pack="invoice-intake"]').getByRole('button', { name: '套用到草稿' }).click();
  const dialog = page.getByRole('alertdialog', { name: '确认替换草稿' });
  await expect(dialog).toContainText('替换当前草稿 v2');
  await expect(page.getByRole('group', { name: '流程图' }).locator('.sop-node')).toHaveCount(before); // not replaced yet
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('group', { name: '流程图' }).locator('.sop-node')).toHaveCount(before);
});

test('a pack never modifies the published workflow: applied to a published flow it opens a new draft', async ({ page }) => {
  await knowledge(page, { s1: 'v1', s2: 'v1' });
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption('e2e.invoice-intake');
  await validateBtn(page).click();
  await publishBtn(page).click();
  await expect(page.getByRole('status')).toContainText('v1 已发布');
  await page.locator('[data-pack="invoice-intake"]').getByRole('button', { name: '套用到草稿' }).click();
  await expect(page.getByRole('status')).toContainText('已保存为草稿 v2；已发布版本不受影响');
  await expect(page.locator('tr[data-version="1"]')).toContainText('已发布');
  await expect(page.locator('tr[data-version="2"]')).toContainText('草稿');
});

test('knowledge changes behind a draft are shown with their impact and context', async ({ page }) => {
  await knowledge(page, { s1: 'v2', s2: null }); // s1 revised, s2 withdrawn since the pack was applied
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption('e2e.invoice-intake');
  const impact = page.getByRole('region', { name: '知识变化影响' });
  await expect(impact).toContainText('企业知识已变化');
  await expect(impact.locator('[data-impact="invoice-intake:rule:1"]')).toContainText('收到发票后先核对采购单（付款制度.md#L4）：依据 v1 → v2');
  await expect(impact.locator('[data-impact="invoice-intake:rule:2"]')).toContainText('依据 v1 → 已不可用');
});
