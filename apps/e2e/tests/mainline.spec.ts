/**
 * T-47 main line, end to end through the real app:
 *   upload → confirm source → analysis → employee + tool → SOP (validate, publish) → trigger
 *   → 待我处理 approval → gateway write → read-back, plus the read-back-mismatch exception path.
 * Synthetic parts are the external ones only: the knowledge source/model drivers (knowledge fixture) and the ERP the
 * tool writes to (in-memory ledger on the E2E server). Everything else is the product code.
 */
import type { APIResponse, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

// the knowledge fixture's synthetic sources and test driver belong to this owner
const OWNER = 'e2e-knowledge-owner|owner|P-1';
const REVIEWER = 'e2e-main-reviewer|reviewer|P-1';
const SOP = 'e2e.invoice-payment';
const TOOL = 'e2e.erp.pay';
const POLICY = [
  '角色：财务专员；责任：核对付款金额与发票，并登记付款。',
  '工具：付款登记；职责：把已批准的付款写入财务系统。',
  '规则：金额超过 5000 需要人工复核。',
].join('\n');

test.use({ extraHTTPHeaders: { 'x-dev-user': OWNER } });

async function json<T>(r: Promise<APIResponse>, ok = [200, 201, 202]): Promise<T> {
  const res = await r;
  expect(ok, await res.text()).toContain(res.status());
  return (await res.json()) as T;
}

interface Overview { items: { id: string; version: string; confirmed: boolean }[]; recommendations: { kind: string; name: string; description: string; evidence: unknown[] }[]; analyses: { status: string }[] }
const overview = (page: Page) => json<Overview>(page.request.get('/api/v1/knowledge/overview'));

test('main line: knowledge → employee and tool → SOP → trigger → approval → write → read-back', async ({ page }) => {
  await json(page.request.post('/__test/knowledge/reset', { data: {} }));

  await test.step('upload a policy file and confirm the source and its version', async () => {
    const conn = await json<{ id: string }>(page.request.post('/api/v1/knowledge/connections', { data: { name: '付款制度', pluginId: 'local-file', scope: {} } }));
    await json(page.request.post(`/api/v1/knowledge/connections/${conn.id}/confirm`, { data: {} }));
    await page.goto('/#knowledge');
    await page.getByLabel('选择文本文件（.txt / .md / .csv / .markdown，最多 2 MB）').setInputFiles({ name: '付款制度.md', mimeType: 'text/markdown', buffer: Buffer.from(POLICY) });
    const submitted = page.waitForResponse((r) => r.url().endsWith('/knowledge/uploads') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '提交资料', exact: true }).click();
    expect((await submitted).ok()).toBe(true);
    for (const item of (await overview(page)).items.filter((i) => !i.confirmed)) {
      await json(page.request.post(`/api/v1/knowledge/items/${item.id}/confirm`, { data: { version: item.version } }));
    }
    expect((await overview(page)).items.every((i) => i.confirmed)).toBe(true);
  });

  let employeeId = '';
  await test.step('analysis recommends the employee and the tool from the cited policy', async () => {
    await json(page.request.post('/api/v1/knowledge/analyses', { data: {} }));
    await json(page.request.post('/__test/knowledge/advance', { data: {} })); // the worker tick, driven by the test
    await expect.poll(async () => (await overview(page)).analyses.at(-1)?.status).toBe('completed');
    const recs = (await overview(page)).recommendations;
    const role = recs.find((r) => r.kind === 'employee' && r.name === '财务专员')!;
    const tool = recs.find((r) => r.kind === 'tool' && r.name === '付款登记')!;
    expect(role.evidence.length).toBeGreaterThan(0);
    expect(tool.evidence.length).toBeGreaterThan(0);

    // the owner turns the recommendations into a real employee and tool (creation grants nothing by itself)
    employeeId = (await json<{ id: string }>(page.request.post('/api/v1/employees/', { data: { name: role.name, duty: role.description, prompt: role.description, source: 'recommended' } }))).id;
    await json(page.request.post(`/api/v1/employees/${employeeId}/pause`));
    expect((await json<{ status: string }>(page.request.post(`/api/v1/employees/${employeeId}/resume`))).status).toBe('online');
  });

  await test.step('the tool goes through every gate to available for this employee', async () => {
    const contract = { toolId: TOOL, action: 'register payment', purpose: tool(), targetSystem: 'synthetic-erp', effect: 'write', input: { type: 'object' }, output: { type: 'object' }, risk: 'high', requiresExactApproval: true };
    function tool() { return '把已批准的付款写入财务系统'; }
    await json(page.request.post('/api/v1/tools/', { data: { name: '付款登记', contract, acceptanceCases: ['normal', 'readback'], consumers: [employeeId] } }));
    await json(page.request.post(`/api/v1/tools/${TOOL}/confirm`));
    await json(page.request.post(`/api/v1/tools/${TOOL}/acquire`, { data: { route: 'import', artifact: 'erp-connector-v1' } }));
    await json(page.request.post(`/api/v1/tools/${TOOL}/test`, { data: { results: { normal: true, readback: true } } }));
    await json(page.request.post(`/api/v1/tools/${TOOL}/release`, { headers: { 'x-dev-user': REVIEWER } }));
    await json(page.request.post(`/api/v1/tools/${TOOL}/deploy`, { data: { version: '1.0.0', healthy: true, artifact: 'erp-connector-v1' } }));
    await json(page.request.post(`/api/v1/tools/${TOOL}/install`, { data: { employeeId } }));
    const bound = await json<{ progress: { done: string[] } }>(page.request.post(`/api/v1/tools/${TOOL}/bind`, { data: { employeeId, credentialRef: 'kv://erp-pay-binding' } }));
    expect(bound.progress.done).toHaveLength(7);
    expect((await page.request.post(`/api/v1/tools/${TOOL}/bind`, { data: { employeeId, credentialRef: 'password=hunter2' } })).status()).toBe(400); // only references
  });

  await test.step('SOP: review before the write, rules set, validated and published on the page', async () => {
    const graph = {
      nodes: [
        { id: 't', kind: 'trigger', label: '收到供应商发票', ref: 'mail:ap-inbox' },
        { id: 'a', kind: 'agent', label: '超级智能体分派' },
        { id: 'e', kind: 'employee', label: '财务专员', ref: employeeId },
        { id: 'h', kind: 'human_review', label: '财务复核' },
        { id: 'w', kind: 'tool', label: '付款登记', ref: TOOL },
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'e' }, { from: 'e', to: 'h' }, { from: 'h', to: 'w' }],
    };
    await json(page.request.post('/api/v1/sop/drafts', { data: { sopId: SOP, definition: { requiredFields: ['invoiceNo', 'amount'], threshold: { field: 'amount', max: 5000 }, employeeStatus: 'active', graph } } }));
    await page.goto('/#brain');
    await page.getByLabel('选择流程').selectOption(SOP);
    await expect(page.locator('main')).toContainText('结构检查通过');
    await page.getByRole('button', { name: '校验（运行回归用例）' }).click();
    await expect(page.getByRole('list', { name: '回归用例' }).locator('li.ok')).toHaveCount(10);
    await page.getByRole('button', { name: '发布', exact: true }).click();
    await expect(page.locator('tr[data-version="1"]')).toContainText('已发布');
  });

  await test.step('trigger: the run stops at the human review; nothing is written yet', async () => {
    const runs = page.getByRole('region', { name: '运行记录' });
    await runs.getByLabel('事件编号').fill('INV-480');
    await runs.getByLabel('输入数据').fill(JSON.stringify({ invoiceNo: 'INV-480', amount: 480 }));
    await runs.getByRole('button', { name: '按已发布版本触发' }).click();
    await expect(page.getByLabel('触发结果')).toContainText('等待人工');
    await expect(runs.locator('[data-step="h"]')).toHaveAttribute('data-step-status', 'waiting_human');
    expect(await json<Record<string, unknown>>(page.request.get('/__e2e/erp/ledger'))).toEqual({});
  });

  await test.step('待我处理: the approver sees exactly what will be written and approves it', async () => {
    await page.goto('/#work');
    const item = page.getByRole('button', { name: /批准写入「付款登记」（事件 INV-480）/ });
    await item.click();
    const drawer = page.getByRole('complementary', { name: '工作项' });
    const fields = drawer.getByLabel('决定的内容');
    await expect(fields).toContainText('invoiceNo');
    await expect(fields).toContainText('INV-480');
    await expect(fields).toContainText('480');
    await drawer.getByRole('button', { name: /按版本 1 决定/ }).click();
  });

  await test.step('the gateway writes once and the read-back matches: the run completes', async () => {
    await expect.poll(async () => json<Record<string, { amount: number }>>(page.request.get('/__e2e/erp/ledger'))).toEqual({ 'INV-480': { invoiceNo: 'INV-480', amount: 480 } });
    await page.goto('/#brain');
    await page.getByLabel('选择流程').selectOption(SOP);
    const run = page.getByRole('region', { name: '运行记录' }).locator('li[data-run]').filter({ hasText: 'INV-480' });
    await expect(run.locator('[data-run-status]')).toHaveText('已完成');
    await expect(run).toContainText('事件 INV-480 · v1'); // which event, which published version
    await expect(run.locator('[data-step="w"]')).toContainText('已写入并回读一致（ERP-INV-480）');
    await expect(run.locator('[data-step="w"] .readback')).toContainText('"amount":480');
  });

  await test.step('missing required input: blocked and asks for it, nothing runs or is written', async () => {
    const runs = page.getByRole('region', { name: '运行记录' });
    await runs.getByLabel('事件编号').fill('INV-000');
    await runs.getByLabel('输入数据').fill(JSON.stringify({ invoiceNo: 'INV-000' }));
    await runs.getByRole('button', { name: '按已发布版本触发' }).click();
    await expect(page.getByLabel('触发结果')).toContainText('已阻塞');
    const run = runs.locator('li[data-run]').filter({ hasText: 'INV-000' });
    await expect(run.locator('[data-run-status]')).toHaveText('已阻塞');
    await expect(run.locator('[data-step="t"]')).toContainText('缺少必填字段：amount');
    await expect(run.locator('[data-step="w"]')).toHaveAttribute('data-step-status', 'pending');
    expect(Object.keys(await json<Record<string, unknown>>(page.request.get('/__e2e/erp/ledger')))).toEqual(['INV-480']);
    await page.goto('/#work');
    await expect(page.getByRole('button', { name: /补资料：缺少 amount（事件 INV-000）/ })).toBeVisible();
    await page.goto('/#brain');
    await page.getByLabel('选择流程').selectOption(SOP);
  });

  await test.step('authorisation is re-checked at the call: a paused employee writes nothing even with an approval', async () => {
    const runs = page.getByRole('region', { name: '运行记录' });
    await runs.getByLabel('事件编号').fill('INV-555');
    await runs.getByLabel('输入数据').fill(JSON.stringify({ invoiceNo: 'INV-555', amount: 555 }));
    await runs.getByRole('button', { name: '按已发布版本触发' }).click();
    await expect(page.getByLabel('触发结果')).toContainText('等待人工');
    await json(page.request.post(`/api/v1/employees/${employeeId}/pause`));
    await page.goto('/#work');
    await page.getByRole('button', { name: /批准写入「付款登记」（事件 INV-555）/ }).click();
    await page.getByRole('complementary', { name: '工作项' }).getByRole('button', { name: /按版本 1 决定/ }).click();
    await page.goto('/#brain');
    await page.getByLabel('选择流程').selectOption(SOP);
    const run = page.getByRole('region', { name: '运行记录' }).locator('li[data-run]').filter({ hasText: 'INV-555' });
    await expect(run.locator('[data-run-status]')).toHaveText('已阻塞');
    await expect(run.locator('[data-step="w"]')).toContainText('未授权，未写入：数字员工当前状态为 paused，不能执行');
    expect(Object.keys(await json<Record<string, unknown>>(page.request.get('/__e2e/erp/ledger')))).toEqual(['INV-480']);
    expect((await json<{ status: string }>(page.request.post(`/api/v1/employees/${employeeId}/resume`))).status).toBe('online');
  });

  await test.step('read-back mismatch: frozen, exception opened, no second write and no resubmission', async () => {
    await json(page.request.post('/__e2e/erp/mode', { data: { mode: 'mismatch' } }));
    const runs = page.getByRole('region', { name: '运行记录' });
    await runs.getByLabel('事件编号').fill('INV-990');
    await runs.getByLabel('输入数据').fill(JSON.stringify({ invoiceNo: 'INV-990', amount: 990 }));
    await runs.getByRole('button', { name: '按已发布版本触发' }).click();
    await expect(page.getByLabel('触发结果')).toContainText('等待人工');
    await page.goto('/#work');
    await page.getByRole('button', { name: /批准写入「付款登记」（事件 INV-990）/ }).click();
    await page.getByRole('complementary', { name: '工作项' }).getByRole('button', { name: /按版本 1 决定/ }).click();

    await page.goto('/#brain');
    await page.getByLabel('选择流程').selectOption(SOP);
    const run = page.getByRole('region', { name: '运行记录' }).locator('li[data-run]').filter({ hasText: 'INV-990' });
    await expect(run.locator('[data-run-status]')).toHaveText('结果未知（已冻结）');
    await expect(run.locator('[data-step="w"]')).toContainText('回读与批准的值不一致，已停止，不会重复写入');
    await expect(run.getByRole('link', { name: /例外事项/ })).toBeVisible();

    await page.goto('/#work');
    await expect(page.getByRole('button', { name: /例外裁定/ }).first()).toBeVisible();
    await page.getByRole('button', { name: /批准写入「付款登记」（事件 INV-990）/ }).click();
    const drawer = page.getByRole('complementary', { name: '工作项' });
    await expect(drawer).toContainText('结果未知，不能再次提交。');
    await expect(drawer.getByRole('button', { name: /决定/ })).toHaveCount(0);
    const ledger = await json<Record<string, { amount: number }>>(page.request.get('/__e2e/erp/ledger'));
    expect(Object.keys(ledger)).toEqual(['INV-480', 'INV-990']); // exactly one write attempt for INV-990
  });

  await test.step('paused read-back cannot finish or repeat the original external write', async () => {
    await json(page.request.post(`/api/v1/employees/${employeeId}/pause`));
    await page.goto('/#brain'); await page.getByLabel('选择流程').selectOption(SOP);
    const run = page.getByRole('region', { name: '运行记录' }).locator('li[data-run]').filter({ hasText: 'INV-990' });
    const originalRunId = await run.getAttribute('data-run');
    await run.getByRole('button', { name: '只回读核对外部结果' }).click();
    await expect(run.getByRole('status', { name: '回读核对结果' })).toContainText('不允许回读');
    await expect(run.locator('[data-run-status]')).toHaveText('结果未知（已冻结）');
    expect((await json<Record<string, number>>(page.request.get('/__e2e/erp/write-counts')))['INV-990']).toBe(1);
    expect((await json<Record<string, number>>(page.request.get('/__e2e/erp/read-counts')))['INV-990'] ?? 0).toBe(0);
    expect(await run.getAttribute('data-run')).toBe(originalRunId);
    await run.screenshot({ path: test.info().outputPath('paused-readback.png') });
    await json(page.request.post(`/api/v1/employees/${employeeId}/resume`));
  });

  await test.step('corrected external data is reread on the same run without another write', async () => {
    const run = page.getByRole('region', { name: '运行记录' }).locator('li[data-run]').filter({ hasText: 'INV-990' });
    const originalRunId = await run.getAttribute('data-run');
    await run.getByRole('button', { name: '只回读核对外部结果' }).click();
    await expect(run.getByRole('status', { name: '回读核对结果' })).toContainText('结果仍待确认');
    await expect(run.locator('[data-run-status]')).toHaveText('结果未知（已冻结）');
    await json(page.request.post('/__e2e/erp/correct', { data: { invoiceNo: 'INV-990', amount: 990 } }));
    await run.getByRole('button', { name: '只回读核对外部结果' }).click();
    await expect(run.getByRole('status', { name: '回读核对结果' })).toContainText('回读已匹配原批准内容');
    await expect(run.locator('[data-run-status]')).toHaveText('已完成');
    await expect(run.locator('[data-step="w"] .readback')).toContainText('"amount":990');
    expect((await json<Record<string, number>>(page.request.get('/__e2e/erp/write-counts')))['INV-990']).toBe(1);
    expect((await json<Record<string, number>>(page.request.get('/__e2e/erp/read-counts')))['INV-990']).toBe(2);
    expect(await run.getAttribute('data-run')).toBe(originalRunId);
    await run.screenshot({ path: test.info().outputPath('matched-readback.png') });
  });
});
