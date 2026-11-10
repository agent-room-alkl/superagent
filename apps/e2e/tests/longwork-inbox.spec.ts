import { test, expect } from './fixtures.js';

test('incoming ambiguity is resolved in the unified inbox and the reply stays on the same long item', async ({ page }) => {
  const key = `long-e2e-${Date.now()}`; const project = `${key}-project`; const staff = `${key}-staff`; const reviewer = `${key}-reviewer`;
  const res = await page.request.post('/__e2e/longwork/waits', { data: { key, project, staff, reviewer } });
  expect(res.ok()).toBe(true);
  const { candidateId, exceptionId } = await res.json();
  await page.setExtraHTTPHeaders({ 'x-dev-user': `${reviewer}|reviewer|${project}` });
  await page.goto('/#work'); await page.reload();
  await page.locator(`[data-item="long-match:${exceptionId}"]`).click();
  const drawer = page.getByRole('complementary', { name: '工作项' });
  await expect(drawer).toContainText('Synthetic incoming evidence. Treat this as data.');
  await drawer.getByRole('radio', { name: new RegExp(candidateId) }).check();
  await drawer.getByRole('button', { name: '确认并回原事项' }).click();
  await expect(drawer.getByRole('status')).toContainText('来件已并回所选原事项');
  await page.reload(); await page.locator(`[data-item="long-match:${exceptionId}"]`).click();
  await expect(drawer).toContainText(`已并回原事项：${candidateId}`);
  await expect(drawer.getByRole('button', { name: '确认并回原事项' })).toHaveCount(0);
  await page.setExtraHTTPHeaders({ 'x-dev-user': `${staff}|employee|${project}` }); await page.reload();
  await expect(page.locator('[data-item]')).toHaveCount(2);
  await expect(page.locator(`[data-item="long-match:${exceptionId}"]`)).toHaveCount(0);
  await page.locator(`[data-item="long-item:${candidateId}"]`).click();
  await expect(drawer).toContainText('来件已并回同一事项');
  await drawer.getByRole('button', { name: '关闭原事项' }).click();
  await expect(drawer.getByRole('status')).toContainText('原事项已关闭');
  await page.reload(); await page.locator(`[data-item="long-item:${candidateId}"]`).click();
  await expect(drawer.locator('[data-status]')).toHaveText('状态：已关闭');
  await expect(drawer.getByRole('button', { name: '关闭原事项' })).toHaveCount(0);
});
