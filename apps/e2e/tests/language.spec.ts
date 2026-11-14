/** Interface language: English by default, switchable to Chinese in the top bar, remembered in the browser. */
import { test, expect } from './fixtures.js';

test.describe('nothing chosen yet', () => {
  test.use({ lang: null });

  test('starts in English, switches to Chinese, and keeps the choice after a reload', async ({ page }) => {
    await page.goto('/#employees');
    const nav = page.getByRole('navigation', { name: 'Main menu' });
    await expect(nav.locator('.nav-group')).toHaveText(['Daily work', 'Team & knowledge', 'Configuration']);
    await expect(nav.locator('.nav-item')).toHaveText(['Command room', 'My work', 'Company knowledge', 'Digital employees', 'Employee tools', 'Super agent', 'Admin settings']);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Digital employees');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const language = page.getByRole('group', { name: 'Language' });
    await expect(language.getByRole('button', { name: 'EN' })).toHaveAttribute('aria-pressed', 'true');
    await language.getByRole('button', { name: '中文' }).click();

    const navZh = page.getByRole('navigation', { name: '主菜单' });
    await expect(navZh.locator('.nav-item')).toHaveText(['指挥室', '待我处理', '企业知识', '数字员工', '员工工具', '超级智能体', '管理设置']);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('数字员工');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page.getByRole('group', { name: '语言' }).getByRole('button', { name: '中文' })).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(page.getByRole('navigation', { name: '主菜单' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('数字员工');

    await page.getByRole('group', { name: '语言' }).getByRole('button', { name: 'EN' }).click();
    await expect(page.getByRole('navigation', { name: 'Main menu' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Digital employees');
  });
});
