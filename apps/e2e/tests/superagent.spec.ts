/**
 * T-48 super agent page: SOP graph view, editing a draft without touching the published version, publish gates,
 * effective date, in-flight instances on the old version, node detail, ontology empty state, phone width.
 * Maps qa-outcomes: "Unvalidated draft can be published", "Valid draft cannot publish", "Publishing rewrote old
 * instance", "Stale validation published"; qa-enablement: "Unimplemented tool nodes are explicitly blocked".
 */
import { test, expect } from './fixtures.js';

const SOP = 'e2e.invoice.intake';
test.describe.configure({ mode: 'serial' });

let empId = '';
const placeholderTool = 'e2e.sop.newtool';

test('setup: an online employee, a placeholder tool and a first SOP draft', async ({ request }) => {
  const emp = (await (await request.post('/api/v1/employees/', { data: { name: '应付专员', duty: '处理供应商发票', prompt: '按制度处理发票' } })).json()) as { id: string };
  empId = emp.id;
  await request.post(`/api/v1/employees/${empId}/pause`);
  expect(((await (await request.post(`/api/v1/employees/${empId}/resume`)).json()) as { status: string }).status).toBe('online');
  await request.post('/api/v1/tools/', {
    data: {
      name: '新登记工具',
      contract: { toolId: placeholderTool, action: 'register', purpose: 'p', targetSystem: 'sample-erp', effect: 'write', input: {}, output: {}, risk: 'medium', requiresExactApproval: true },
      acceptanceCases: ['normal'],
      consumers: [empId],
    },
  });
  const graph = {
    nodes: [
      { id: 't', kind: 'trigger', label: '收到发票邮件', ref: 'mail:inbox' },
      { id: 'a', kind: 'agent', label: '超级智能体分派' },
      { id: 'e', kind: 'employee', label: '应付专员', ref: empId },
      { id: 'x', kind: 'tool', label: '新登记工具', ref: placeholderTool },
    ],
    edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'e' }, { from: 'e', to: 'x' }],
  };
  expect((await request.post('/api/v1/sop/drafts', { data: { sopId: SOP, definition: { requiredFields: ['title', 'amount'], threshold: { field: 'amount', max: 1000 }, employeeStatus: 'active', graph } } })).status()).toBe(200);
});

test('the graph shows every node; an unimplemented tool and an unreviewed write block publishing', async ({ page }, info) => {
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption(SOP);
  const graph = page.getByRole('group', { name: '流程图' });
  await expect(graph.locator('.sop-node')).toHaveCount(4);
  const issues = page.getByRole('list', { name: '结构问题' });
  await expect(issues).toContainText('未实现的工具节点不能发布');
  await expect(issues).toContainText('之前必须经过人工审核');
  await expect(page.getByRole('button', { name: '校验（运行回归用例）' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '发布', exact: true })).toBeDisabled();

  // node detail links to the real record
  await graph.locator('[data-node="x"]').click();
  const detail = page.getByLabel('节点详情');
  await expect(detail).toContainText('当前阶段 placeholder');
  await expect(detail.getByRole('link', { name: '打开工具卡' })).toHaveAttribute('href', '#tools');
  await info.attach('t48-sop-blocked', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

test('fix the draft (remove the tool, add a review), save, publish with an effective date: all gates reported', async ({ page }, info) => {
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption(SOP);
  const graph = page.getByRole('group', { name: '流程图' });
  await graph.locator('[data-node="x"]').click();
  await page.getByRole('button', { name: '从草稿删除此节点' }).click();
  await expect(graph.locator('.sop-node')).toHaveCount(3);

  await page.getByLabel('节点类型').selectOption('human_review');
  await page.getByLabel('节点名称').fill('财务复核');
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.getByLabel('从', { exact: true }).selectOption({ label: '应付专员' });
  await page.getByLabel('到', { exact: true }).selectOption({ label: '财务复核' });
  await page.getByRole('button', { name: '添加连线' }).click();
  await expect(graph.locator('.sop-node')).toHaveCount(4);
  await expect(page.locator('main')).toContainText('结构检查通过');

  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByRole('status')).toContainText('已保存为草稿 v1');
  await page.getByRole('button', { name: '校验（运行回归用例）' }).click();
  await expect(page.getByRole('status')).toContainText('校验通过，可以发布');
  await expect(page.getByRole('list', { name: '回归用例' }).locator('li.ok')).toHaveCount(10);
  await page.getByLabel('生效时间（可选）').fill('2026-12-01T09:00');
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('v1 已发布；在途实例继续按原版本运行');
  await expect(page.locator('tr[data-version="1"]')).toContainText('已发布');
  await info.attach('t48-sop-published', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

test('editing after publish opens a new draft; the published version and its running instances are untouched', async ({ page, request }) => {
  const v1 = ((await (await request.get(`/api/v1/sop/${SOP}/versions`)).json()) as { versions: { id: string; number: number }[] }).versions.find((v) => v.number === 1)!;
  expect((await request.post(`/__e2e/sop/versions/${v1.id}/instances`)).ok()).toBe(true);
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption(SOP);
  await expect(page.locator('main')).toContainText('已发布 v1（编辑将新建草稿）');
  await page.getByLabel('节点类型').selectOption('agent');
  await page.getByLabel('节点名称').fill('归档');
  await page.getByRole('button', { name: '添加节点' }).click();
  await page.getByRole('button', { name: '保存草稿' }).click();
  await expect(page.getByRole('status')).toContainText('已保存为草稿 v2；已发布版本不受影响');
  await expect(page.locator('tr[data-version="1"]')).toContainText('已发布');
  await expect(page.locator('tr[data-version="1"] td').nth(3)).toHaveText('1');
  await expect(page.locator('tr[data-version="2"]')).toContainText('草稿');
  // the new node is unreachable, so this draft cannot be published as is
  await expect(page.getByRole('list', { name: '结构问题' })).toContainText('无法从触发点到达');
  await expect(page.getByRole('button', { name: '发布', exact: true })).toBeDisabled();
});

test('ontology with configured knowledge but no readable objects stays empty', async ({ page }) => {
  await page.goto('/#brain');
  await page.getByRole('tab', { name: '本体关系' }).click();
  await expect(page.locator('main')).toContainText('还没有经确认来源支持的对象。先在企业知识里确认来源并运行分析。');
  await expect(page.locator('[data-object], [data-relation]')).toHaveCount(0);
});

test('ontology renders objects, a relation and their evidence on the real page (desktop and phone width)', async ({ page }) => {
  // Response in the shape the knowledge analysis returns (kind object / relation with relation {from,to,label}).
  const evidence = (quote: string, line: number) => [{ sourceId: 's1', version: 'v1', start: 0, end: quote.length, locator: `采购制度.md#L${line}`, quote }];
  await page.route('**/api/v1/knowledge/overview', (route) =>
    route.fulfill({
      json: {
        recommendations: [
          { id: 'r1', key: 'invoice', kind: 'object', name: '供应商发票', description: '供应商开具的付款凭证', evidence: evidence('供应商发票须附采购单号', 3), humanLocked: false, deleted: false },
          { id: 'r2', key: 'po', kind: 'object', name: '采购单', description: '内部审批后的采购凭证', evidence: evidence('采购单经部门负责人审批', 7), humanLocked: false, deleted: false },
          { id: 'r3', key: 'invoice-po', kind: 'relation', name: '发票匹配采购单', description: '', relation: { from: 'invoice', to: 'po', label: '须匹配' }, evidence: evidence('付款前发票须与采购单金额一致', 12), humanLocked: false, deleted: false },
          { id: 'r4', key: 'ap-clerk', kind: 'employee', name: '应付专员', description: '不是本体对象', evidence: evidence('应付专员负责付款', 20), humanLocked: false, deleted: false },
        ],
      },
    }),
  );
  await page.goto('/#brain');
  await page.getByRole('tab', { name: '本体关系' }).click();
  const objects = page.getByRole('region', { name: '对象与实体' });
  await expect(objects.locator('[data-object]')).toHaveCount(2); // the employee recommendation is not an ontology object
  await expect(objects.locator('[data-object="invoice"]')).toContainText('供应商发票');
  await expect(objects.locator('[data-object="invoice"]')).toContainText('采购制度.md#L3');
  await expect(objects.locator('[data-object="invoice"]')).toContainText('供应商发票须附采购单号');
  const relation = page.getByRole('region', { name: '关系' }).locator('[data-relation="invoice-po"]');
  await expect(relation).toContainText('供应商发票 —须匹配→ 采购单');
  await expect(relation).toContainText('采购制度.md#L12');
  await expect(relation).toContainText('付款前发票须与采购单金额一致');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(relation).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
