/**
 * Synthetic UI evidence only: every knowledge API response is intercepted below.
 * Run against an explicitly supplied Vite/app URL with KnowledgePage mounted:
 *   KNOWLEDGE_UI_BASE_URL=http://127.0.0.1:5173 node apps/web/src/pages/knowledge-ui.e2e.mjs
 * Optional KNOWLEDGE_UI_SCREENSHOT_DIR writes desktop/mobile PNG review artifacts.
 * This does not verify Azure, production authentication, or real backend persistence.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

if (!process.env.KNOWLEDGE_UI_BASE_URL) throw new Error('Set KNOWLEDGE_UI_BASE_URL to a controlled app/preview URL. This script uses synthetic API fixtures.');
const target = new URL(process.env.KNOWLEDGE_UI_BASE_URL);
if (!['http:', 'https:'].includes(target.protocol)) throw new Error('The controlled preview URL must use HTTP or HTTPS.');
target.hash = 'knowledge';

const evidence = { sourceId: 'synthetic-source', version: 'v1', start: 0, end: 4, locator: 'synthetic.md / paragraph 1', quote: '测试依据' };
const state = {
  plugins: [
    { id: 'local-file', name: '本地文件（测试夹具）', enabled: true, configured: true, capabilities: ['文件导入', '版本与行定位'] },
    { id: 'database', name: '数据库（未配置测试夹具）', enabled: true, configured: false, capabilities: ['结构知识'] },
  ],
  connections: [{ id: 'synthetic-connection', name: '测试资料库', pluginId: 'local-file', status: 'confirmed' }],
  items: [{ id: 'synthetic-source', title: '测试操作手册.md', version: 'v1', status: 'pending', confirmed: false, locator: 'synthetic.md' }],
  analyses: [], parseJobs: [],
  recommendations: [{ id: 'synthetic-recommendation', kind: 'sop', name: '测试核对流程', description: '仅用于浏览器测试的建议草案。', humanLocked: false, deleted: false, evidence: [evidence] }],
};
const requests = [];
let emptySearch = false;
let binaryUnavailable = true;
let overviewCount = 0;
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const browserErrors = [];
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.route('**/api/v1/knowledge/**', async route => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const path = url.pathname.replace('/api/v1/knowledge', '');
    const body = incoming.postDataJSON();
    requests.push({ path, body, method: incoming.method() });
    const respond = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/overview') { overviewCount++; return respond(state); }
    if (path === '/connections') {
      state.connections.push({ id: 'synthetic-new-connection', name: body.name, pluginId: body.pluginId, status: 'draft' });
      return respond(state.connections.at(-1), 201);
    }
    if (path === '/connections/synthetic-new-connection/confirm') { state.connections.at(-1).status = 'confirmed'; return respond({}); }
    if (path === '/uploads') return respond({ id: 'synthetic-text-upload' }, 201);
    if (path === '/files') {
      if (binaryUnavailable) return respond({ message: 'Azure 文档服务尚未配置（测试响应）。' }, 503);
      state.parseJobs.push({ id: 'synthetic-parse', name: body.name, status: 'queued', error: null });
      return respond({ id: 'synthetic-parse', status: 'queued' }, 202);
    }
    if (path === '/items/synthetic-source/confirm') {
      assert.equal(body.version, 'v1');
      state.items[0].confirmed = true; state.items[0].status = 'confirmed';
      return respond({});
    }
    if (path === '/search') return respond(emptySearch ? { answer: '', hits: [] } : { answer: '测试检索回答', hits: [evidence] });
    if (path === '/analyses') return respond({ message: '分析模型尚未配置（测试响应）。' }, 503);
    if (path === '/recommendations/synthetic-recommendation/lock') { Object.assign(state.recommendations[0], body, { humanLocked: true }); return respond({}); }
    if (path === '/recommendations/synthetic-recommendation/delete') { state.recommendations[0].deleted = true; return respond({}); }
    return respond({ message: `Unexpected synthetic API request: ${path}` }, 500);
  });
  await page.goto(target.href);
  await page.getByText('测试操作手册.md', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '开始分析', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('option', { name: '数据库（未配置测试夹具）' }).count(), 0);
  await page.getByText('文件导入 · 版本与行定位', { exact: true }).waitFor();

  await page.getByLabel('连接名称', { exact: true }).fill('额外测试来源');
  await page.getByRole('button', { name: '创建连接草案', exact: true }).click();
  await page.getByText('额外测试来源', { exact: true }).waitFor();
  await page.getByRole('button', { name: '确认连接', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '连接已确认' }).waitFor();
  const connectionRequest = requests.find(request => request.path === '/connections');
  assert.equal(connectionRequest.body.pluginId, 'local-file');
  assert.equal('audience' in connectionRequest.body, false);

  await page.getByLabel('选择文本文件（.txt / .md / .csv / .markdown，最多 2 MB）').setInputFiles({ name: 'synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('测试正文') });
  await page.waitForFunction(() => document.querySelector('textarea').value === '测试正文');
  await page.getByRole('button', { name: '提交资料', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '资料已提交' }).waitFor();
  assert.equal(requests.find(request => request.path === '/uploads').body.text, '测试正文');

  const binaryPicker = page.getByLabel('选择待解析文档（最多 20 MiB）');
  await binaryPicker.setInputFiles({ name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([1]) });
  await page.getByRole('alert').filter({ hasText: '文档解析仅支持' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '提交到文档解析队列', exact: true }).isDisabled(), true);
  await binaryPicker.setInputFiles({ name: 'oversized.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(20 * 1024 * 1024 + 1) });
  await page.getByRole('alert').filter({ hasText: '不能超过 20 MiB' }).waitFor();
  assert.equal(requests.some(request => request.path === '/files'), false);
  const syntheticPdf = Buffer.from('%PDF-test-fixture-only');
  await binaryPicker.setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: syntheticPdf });
  await page.getByRole('button', { name: '提交到文档解析队列', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Azure 文档服务尚未配置' }).waitFor();
  assert.equal(await page.getByText('文档已加入解析队列。解析完成后仍需核对并确认资料版本。', { exact: true }).count(), 0);
  assert.deepEqual(requests.find(request => request.path === '/files').body, { connectionId: 'synthetic-connection', name: 'synthetic.pdf', base64: syntheticPdf.toString('base64') });
  binaryUnavailable = false;
  await page.getByRole('button', { name: '提交到文档解析队列', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '文档已加入解析队列' }).waitFor();
  await page.getByLabel('文档解析任务', { exact: true }).getByText('排队中', { exact: true }).waitFor();
  assert.equal(state.items[0].confirmed, false);
  const beforePolling = overviewCount;
  state.parseJobs[0].status = 'completed';
  await page.getByText('解析完成，请核对下方资料并确认当前版本。', { exact: true }).waitFor({ timeout: 9000 });
  assert.ok(overviewCount > beforePolling, 'Queued parse jobs must trigger overview polling.');
  assert.equal(await page.getByRole('button', { name: '确认此版本', exact: true }).count(), 1);
  state.parseJobs.push({ id: 'synthetic-unknown', name: 'unknown.pdf', status: 'outcome_unknown', error: '测试：提交结果无法确认。' });
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await page.getByText('结果未知 · 需人工核对', { exact: true }).waitFor();
  await page.getByText('请人工核对云端任务和文件状态，再决定后续处理。', { exact: true }).waitFor();

  await page.getByRole('button', { name: '确认此版本', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '当前资料版本已确认' }).waitFor();
  await page.getByLabel('查询企业资料', { exact: true }).fill('测试');
  await page.getByRole('button', { name: '查询依据', exact: true }).click();
  await page.getByText('测试检索回答', { exact: true }).waitFor();
  await page.getByLabel('有依据地查询', { exact: true }).getByText('测试依据', { exact: true }).waitFor();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '分析模型尚未配置' }).waitFor();
  assert.equal(await page.getByText('分析任务已提交，进度以服务端状态为准。', { exact: true }).count(), 0);
  await page.getByLabel('名称', { exact: true }).fill('人工修订测试流程');
  await page.getByRole('button', { name: '保存并人工锁定', exact: true }).click();
  await page.getByText('人工锁定', { exact: true }).waitFor();
  assert.equal(requests.find(request => request.path.endsWith('/lock')).body.name, '人工修订测试流程');

  if (process.env.KNOWLEDGE_UI_SCREENSHOT_DIR) {
    await mkdir(process.env.KNOWLEDGE_UI_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: resolve(process.env.KNOWLEDGE_UI_SCREENSHOT_DIR, 'knowledge-synthetic-desktop.png'), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.KNOWLEDGE_UI_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.KNOWLEDGE_UI_SCREENSHOT_DIR, 'knowledge-synthetic-mobile.png'), fullPage: true });
  emptySearch = true;
  await page.getByRole('button', { name: '查询依据', exact: true }).click();
  await page.getByText('没有当前可用的依据。请确认来源版本、访问权限，或调整关键词。', { exact: true }).waitFor();
  assert.equal(await page.getByText('测试检索回答', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '删除草案', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '草案已删除' }).waitFor();
  assert.equal(await page.getByLabel('名称', { exact: true }).count(), 0);

  state.plugins[0].configured = false;
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await page.getByRole('option', { name: '请先创建并确认本地连接', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await binaryPicker.isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '提交到文档解析队列', exact: true }).isDisabled(), true);
  assert.deepEqual(browserErrors, []);
  console.log(JSON.stringify({ result: 'PASS', evidence: 'SYNTHETIC API FIXTURES ONLY; not real Azure/backend evidence', requests: requests.length, checks: ['final plugin/connection DTOs', 'configured connection gate', 'create/confirm connection', 'CSV/text upload', 'binary extension/20MiB validation', 'FileReader base64 payload', 'Azure 503 without queued claim', 'queued parse polling', 'completed parse still unconfirmed', 'unknown result review', 'exact-version confirmation', 'cited search/no evidence', 'analysis 503', 'human edit/lock/delete', '390px no overflow', 'no browser exceptions'] }, null, 2));
} finally { await browser.close(); }
