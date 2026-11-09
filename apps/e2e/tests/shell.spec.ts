/** App shell — maps prototype QA: qa-room-header, primary navigation (qa-outcomes "Primary navigation changed"). */
import { test, expect } from './fixtures.js';

test('owner navigation has the 7 accepted entries in 3 groups, routed by hash', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主菜单' });
  await expect(nav.locator('.nav-group')).toHaveText(['日常工作', '团队与知识', '配置']);
  await expect(nav.locator('.nav-item')).toHaveText(['指挥室', '待我处理', '企业知识', '数字员工', '员工工具', '超级智能体', '管理设置']);
  await expect(nav.locator('[aria-current="page"]')).toHaveText('指挥室');
  await nav.getByText('管理设置').click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('管理设置');
  await expect(nav.locator('[aria-current="page"]')).toHaveText('管理设置');
});

test('page heading and subtitle share one row and are vertically centred (qa-room-header)', async ({ page, isMobile }) => {
  test.skip(isMobile, 'single-row header is the desktop rule; mobile stacks');
  await page.goto('/#settings');
  const h1 = await page.locator('.page-head h1').boundingBox();
  const sub = await page.locator('.page-head p').boundingBox();
  expect(h1 && sub).toBeTruthy();
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(mid(h1!) - mid(sub!))).toBeLessThanOrEqual(4);
  expect(sub!.x).toBeGreaterThan(h1!.x + h1!.width - 1); // subtitle to the right of the title, same row
});

test('no horizontal page scroll at phone width', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'phone-width rule');
  for (const hash of ['room', 'settings', 'tools']) {
    await page.goto(`/#${hash}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `#${hash}`).toBeLessThanOrEqual(0);
  }
});

test('unbuilt modules say who owns them instead of showing invented data', async ({ page }) => {
  await page.goto('/#room');
  await expect(page.locator('main')).toContainText('T-41');
  await expect(page.locator('main')).not.toContainText(/已完成|已发布/);
});

test('knowledge without configured storage says so instead of inventing sources (fail closed)', async ({ page }) => {
  await page.goto('/#knowledge');
  await expect(page.locator('main')).toContainText('企业知识存储尚未配置');
  await expect(page.locator('main')).not.toContainText(/已确认|已完成|已发布/);
});
