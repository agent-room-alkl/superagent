/**
 * Tool card lifecycle end to end (PRD §3.5). Maps qa-enablement items:
 * "Missing tool starts as stable placeholder", "Progress exposes exactly one current accessible step",
 * "Failed tests block release", "Current progress explains test blocker", "Test pass alone is not release authority",
 * "Released tool still requires execution environment deployment", "Failed environment check blocks installation",
 * "Tool list exposes same compact lifecycle progress".
 */
import { test, expect } from './fixtures.js';

const TOOL = 'e2e.invoice.lookup';
const owner = { 'x-dev-user': 'e2e-owner|owner|' };
const reviewer = { 'x-dev-user': 'e2e-reviewer|reviewer|' };
const contract = {
  toolId: TOOL,
  action: 'lookup invoice',
  purpose: 'read invoice amount by lot',
  targetSystem: 'sample-erp',
  effect: 'read',
  input: { type: 'object', properties: { lot: { type: 'string' } }, required: ['lot'] },
  output: { type: 'object', properties: { amount: { type: 'string' } } },
  risk: 'low',
  requiresExactApproval: false,
};

test.describe.configure({ mode: 'serial' });

test('an empty catalogue shows an empty state and no sample tool', async ({ page }) => {
  await page.route('**/api/v1/tools/', (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('/#tools');
  await expect(page.getByText('还没有工具。', { exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: '工具列表' })).toHaveCount(0);
});

test('[qa-enablement#49] the tool list shows the same current step as the card', async ({ page, request }) => {
  const id = 'e2e.list.progress';
  const created = await request.post('/api/v1/tools/', {
    data: { name: 'List progress', contract: { ...contract, toolId: id }, acceptanceCases: ['normal', 'missing lot'], consumers: ['emp-1'] },
  });
  expect(created.status()).toBe(200);
  await page.goto('/#tools');
  const row = page.getByRole('list', { name: '工具列表' }).getByRole('listitem').filter({ hasText: id });
  await expect(row.locator('[aria-current="step"]')).toContainText('占位');
  await row.getByRole('button', { name: id }).click();
  const cardSteps = page.getByRole('list', { name: '工具进度' });
  await expect(cardSteps.locator('[aria-current="step"]')).toContainText('占位');

  expect((await request.post(`/api/v1/tools/${id}/confirm`)).status()).toBe(200);
  await page.reload();
  await expect(row.locator('[aria-current="step"]')).toContainText('获取');
  await row.getByRole('button', { name: id }).click();
  await expect(cardSteps.locator('[aria-current="step"]')).toContainText('获取');
});

async function card(page: import('@playwright/test').Page) {
  await page.goto('/#tools');
  await page.getByRole('textbox').first().fill(TOOL);
  await page.getByRole('button', { name: '打开工具卡' }).click();
  return page.getByRole('list', { name: '工具进度' });
}

test('a missing tool starts as a stable placeholder with exactly one current step', async ({ page, request }) => {
  const r = await request.post('/api/v1/tools/', { data: { name: 'Invoice lookup', contract, acceptanceCases: ['normal', 'missing lot'], consumers: ['emp-1'] } });
  expect(r.status()).toBe(200);
  const steps = await card(page);
  await expect(page.getByRole('heading', { level: 2 })).toContainText(TOOL);
  await expect(steps.locator('li')).toHaveCount(7);
  await expect(steps.locator('[aria-current="step"]')).toHaveCount(1);
  await expect(page.locator('main')).toContainText('卡点：contract not confirmed');
});

test('failed tests block release and the card explains why; a pass alone is not release', async ({ page, request }) => {
  await request.post(`/api/v1/tools/${TOOL}/confirm`);
  await request.post(`/api/v1/tools/${TOOL}/acquire`, { data: { route: 'import', artifact: 'script-v1' } });
  await request.post(`/api/v1/tools/${TOOL}/test`, { data: { results: { normal: true, 'missing lot': false } } });
  await card(page);
  await expect(page.locator('main')).toContainText('卡点：failed: missing lot');
  expect((await request.post(`/api/v1/tools/${TOOL}/release`, { headers: reviewer })).status()).toBe(409);

  await request.post(`/api/v1/tools/${TOOL}/test`, { data: { results: { normal: true, 'missing lot': true } } });
  await card(page);
  await expect(page.locator('main')).toContainText('waiting for an independent reviewer');
  expect((await request.post(`/api/v1/tools/${TOOL}/release`, { headers: owner })).status()).toBe(409); // owner acted as developer
});

test('release still needs a healthy deployment; a failed health check blocks installation', async ({ page, request }) => {
  expect((await request.post(`/api/v1/tools/${TOOL}/release`, { headers: reviewer })).status()).toBe(200);
  const steps = await card(page);
  await expect(steps.locator('[aria-current="step"]')).toContainText('部署'); // released ≠ deployed
  await request.post(`/api/v1/tools/${TOOL}/deploy`, { data: { version: '1.0.0', healthy: false, artifact: 'script-v1' } });
  await card(page);
  await expect(page.locator('main')).toContainText('health check failed');
  expect((await request.post(`/api/v1/tools/${TOOL}/install`, { data: { employeeId: 'emp-1' } })).status()).toBeGreaterThanOrEqual(400);
});

test('tool store lists preset tools, keeps unimplemented connectors disabled, and installs onto an employee', async ({ page, request }) => {
  const empRes = await request.post('/api/v1/employees/', {
    data: { name: 'Store Tester', duty: 'Answer questions', prompt: 'Use knowledge base' },
  });
  expect(empRes.status()).toBe(200);
  const emp = (await empRes.json()) as { id: string; name: string };

  await page.goto('/#tools');
  const store = page.getByRole('region', { name: '工具商店' });
  await expect(store).toBeVisible();
  await expect(store.getByText('知识库问答')).toBeVisible();
  await expect(store.getByRole('button', { name: '即将提供' }).first()).toBeDisabled();

  const card = store.locator('article').filter({ hasText: 'knowledge.search' });
  await card.getByRole('button', { name: '安装到员工' }).click();
  await card.getByLabel('选择员工').selectOption(emp.id);
  await card.getByRole('button', { name: '确认安装' }).click();

  await expect(store.getByRole('status')).toContainText(emp.name);
  await expect(card).toContainText('已安装');
});
