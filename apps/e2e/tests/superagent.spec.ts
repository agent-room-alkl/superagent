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
  expect((await request.post('/api/v1/sop/drafts', { data: { sopId: SOP, definition: { requiredFields: ['title'], employeeStatus: 'active', graph } } })).status()).toBe(200);
});

test('the graph shows every node; an unimplemented tool and an unreviewed write block publishing', async ({ page }, info) => {
  await page.goto('/#brain');
  await page.getByLabel('选择流程').selectOption(SOP);
  const graph = page.getByRole('group', { name: '流程图' });
  await expect(graph.locator('.sop-node')).toHaveCount(4);
  const issues = page.getByRole('list', { name: '结构问题' });
  await expect(issues).toContainText('未实现的工具节点不能发布');
  await expect(issues).toContainText('之前必须经过人工审核');
  await expect(page.getByRole('button', { name: '校验并发布' })).toBeDisabled();

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
  await page.getByLabel('生效时间（可选）').fill('2026-12-01T09:00');
  await page.getByRole('button', { name: '校验并发布' }).click();
  await expect(page.getByRole('status')).toContainText('v1 已发布；在途实例继续按原版本运行');
  await expect(page.getByRole('list', { name: '门禁结果' }).locator('li.ok')).toHaveCount(10);
  await expect(page.locator('tr[data-version="1"]')).toContainText('已发布');
  await info.attach('t48-sop-published', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
});

test('editing after publish opens a new draft; the published version and its running instances are untouched', async ({ page, request }) => {
  const v1 = ((await (await request.get(`/api/v1/sop/${SOP}/versions`)).json()) as { id: string; number: number }[]).find((v) => v.number === 1)!;
  await request.post(`/api/v1/sop/versions/${v1.id}/instances`);
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
  await expect(page.getByRole('button', { name: '校验并发布' })).toBeDisabled();
});

test('ontology without configured knowledge storage says so instead of inventing objects', async ({ page }) => {
  await page.goto('/#brain');
  await page.getByRole('tab', { name: '本体关系' }).click();
  await expect(page.locator('main')).toContainText('企业知识存储尚未配置');
});
