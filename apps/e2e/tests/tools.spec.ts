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
