/**
 * Setup (PRD §3.1) end to end against the real server and a stub model provider.
 * Maps: key-only-to-server, three-part test, selectable = listed ∩ verified, activation, role restriction.
 */
import { test, expect } from './fixtures.js';
import { EMPLOYEE } from '../playwright.config.js';

const GOOD = 'e2e-stub-key-0000GOOD';
const BAD = 'e2e-wrong-key-1111BAD';

test.describe.configure({ mode: 'serial' });

test('a rejected key is reported as invalid, cannot be activated, and is never echoed', async ({ page }) => {
  await page.goto('/#settings');
  await expect(page.locator('main')).toContainText('状态：未配置');
  await page.getByLabel('API Key（只发送到服务端，保存于 Key Vault）').fill(BAD);
  await page.getByLabel('用于测试的模型 ID（Azure 填部署名）').fill('stub-large');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.locator('main')).toContainText('认证：Key 无效');
  await expect(page.getByRole('button', { name: '保存并生效' })).toHaveCount(0);
  expect(await page.locator('main').innerText()).not.toContain(BAD);
});

test('a valid key: only verified models are selectable; activation stores it server-side and shows last 4 only', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/setup/llm')) sent.push(r.url());
  });
  await page.goto('/#settings');
  await page.getByLabel('API Key（只发送到服务端，保存于 Key Vault）').fill(GOOD);
  await page.getByLabel('用于测试的模型 ID（Azure 填部署名）').fill('stub-large');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.locator('main')).toContainText('认证：通过 · 模型列表：已获取 · 工具调用：通过');
  const primary = page.getByLabel('主模型（仅显示已通过平台能力测试的模型）');
  await expect(primary.locator('option')).toHaveText(['请选择', 'stub-large']);
  await expect(page.locator('main')).toContainText('未验证（不可选）：stub-unverified');
  await primary.selectOption('stub-large');
  await page.getByRole('button', { name: '保存并生效' }).click();
  await expect(page.locator('main')).toContainText('已保存到 Key Vault 并生效');
  await expect(page.locator('main')).toContainText('状态：已配置 · Key ••••GOOD · 主模型 stub-large');
  await expect(page.getByLabel('API Key（只发送到服务端，保存于 Key Vault）')).toHaveValue('');
  expect(await page.content()).not.toContain(GOOD);
  expect(sent.every((u) => u.startsWith('http://127.0.0.1'))).toBe(true); // key goes only to our own server

  await page.reload();
  await expect(page.locator('main')).toContainText('状态：已配置 · Key ••••GOOD');
});

test('the status API never returns the key or its secret reference', async ({ request }) => {
  const r = await request.get('/api/v1/setup/llm');
  expect(r.status()).toBe(200);
  const text = await r.text();
  expect(text).not.toContain(GOOD);
  expect(text).not.toMatch(/secret|version|llm-provider-key/i);
});

test('an employee cannot read or change Setup (server-side role check)', async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'x-dev-user': EMPLOYEE } });
  expect((await ctx.get('/api/v1/setup/llm')).status()).toBe(403);
  expect((await ctx.put('/api/v1/setup/llm', { data: { provider: 'anthropic', apiKey: GOOD, probeModel: 'stub-large', primaryModel: 'stub-large' } })).status()).toBe(403);
  const anon = await playwright.request.newContext({ baseURL, extraHTTPHeaders: {} });
  expect((await anon.get('/api/v1/setup/llm', { headers: { 'x-dev-user': '' } })).status()).toBe(401);
  await ctx.dispose();
  await anon.dispose();
});
