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
  for (const hash of ['room', 'settings', 'tools', 'knowledge', 'brain']) {
    await page.goto(`/#${hash}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `#${hash}`).toBeLessThanOrEqual(0);
  }
});

test('the language switch fits inside the top bar (desktop and phone width)', async ({ page }) => {
  await page.goto('/');
  const bar = await page.locator('.topbar').boundingBox();
  const sw = await page.locator('.lang-switch').boundingBox();
  expect(bar && sw).toBeTruthy();
  expect(sw!.x).toBeGreaterThanOrEqual(bar!.x);
  expect(sw!.x + sw!.width).toBeLessThanOrEqual(bar!.x + bar!.width);
  expect(sw!.y).toBeGreaterThanOrEqual(bar!.y);
  expect(sw!.y + sw!.height).toBeLessThanOrEqual(bar!.y + bar!.height);
  const product = await page.locator('.topbar .product').boundingBox();
  expect(product!.x + product!.width, 'product name and switch do not overlap').toBeLessThanOrEqual(sw!.x);
});

test('unbuilt modules say who owns them instead of showing invented data', async ({ page }) => {
  await page.goto('/#employees');
  await expect(page.locator('main')).toContainText('T-42');
  await expect(page.locator('main')).not.toContainText(/已完成|已发布/);
});

test('configured knowledge starts with an empty source list for an ungranted owner', async ({ page }) => {
  await page.goto('/#knowledge');
  await expect(page.locator('main')).toContainText('还没有资料。上传后将在这里显示解析与确认状态。');
  await expect(page.locator('.knowledge-item')).toHaveCount(0);
  await expect(page.locator('.knowledge-recommendation')).toHaveCount(0);
});
