/**
 * 待我处理 (T-57): the inbox page against the real work-items API — no sample data. Items are created by an owner
 * through the API (as the runtime would) and handled on the page by the person they are assigned to.
 * Every test uses its own user ids, so the shared in-memory inbox of the E2E server does not leak between tests.
 */
import type { APIResponse, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

let seq = 0;
const uid = (name: string) => `e2e-inbox-${name}-${Date.now().toString(36)}-${++seq}`;
const OWNER = 'e2e-inbox-owner|owner|';

async function ok<T>(r: Promise<APIResponse>): Promise<T> {
  const res = await r;
  expect(res.status(), await res.text()).toBeLessThan(300);
  return (await res.json()) as T;
}

/** Create a work item as the owner (the runtime's role) and return its id. */
async function item(page: Page, body: Record<string, unknown>): Promise<string> {
  return (await ok<{ id: string }>(page.request.post('/api/v1/work-items/', { data: body, headers: { 'x-dev-user': OWNER } }))).id;
}

/** Open the inbox as someone. */
async function as(page: Page, who: string) {
  await page.setExtraHTTPHeaders({ 'x-dev-user': who });
  await page.goto('/#work');
  await page.reload(); // a hash-only goto does not reload; the list must be fetched as the new identity
  await expect(page.getByRole('region', { name: '待我处理' })).toBeVisible();
  await expect(page.locator('#page-title')).toHaveText('待我处理');
}

const drawer = (page: Page) => page.getByRole('complementary', { name: '工作项' });
const openItem = async (page: Page, id: string) => {
  await page.locator(`[data-item="${id}"]`).click();
  await expect(drawer(page)).toBeVisible();
};

test('each person sees only their own work, grouped with due dates; the manager sees exceptions, not everyone’s normal work', async ({ page }) => {
  const staff = uid('staff');
  const manager = uid('manager');
  const mine = [
    await item(page, { kind: 'data_check', assigneeUserId: staff, projectId: 'P-1', payload: { title: '核对发票金额', amount: 120, due: '今天 16:00' } }),
    await item(page, { kind: 'action_approval', assigneeUserId: staff, projectId: 'P-1', payload: { title: '批准登记付款', amount: 120, due: '今天 17:00' } }),
    await item(page, { kind: 'manual_execution', assigneeUserId: staff, projectId: 'P-1', waitingOn: '供应商回传', payload: { title: '在客户系统登记', due: '周五' } }),
    await item(page, { kind: 'branch_choice', assigneeUserId: staff, projectId: 'P-1', payload: { title: '选择报价路径', options: ['标准', '例外'], due: '明天 12:00' } }),
    await item(page, { kind: 'supply_info', assigneeUserId: staff, projectId: 'P-1', payload: { title: '补客户税号', due: '明天 15:00' } }),
  ];
  const managerOnly = await item(page, { kind: 'exception_ruling', assigneeUserId: manager, projectId: 'P-1', payload: { title: '裁定没有依据的折扣', reason: 'no_rule', due: '今天 18:00' } });
  const managerWaiting = await item(page, { kind: 'action_approval', assigneeUserId: manager, projectId: 'P-1', waitingOn: '财务总监', payload: { title: '等财务总监确认', due: '周四' } });

  await as(page, `${staff}|employee|P-1`);
  await expect(page.locator('[data-item]')).toHaveCount(5);
  for (const id of mine) await expect(page.locator(`[data-item="${id}"]`)).toBeVisible();
  await expect(page.locator(`[data-item="${managerOnly}"]`)).toHaveCount(0);
  await expect(page.getByRole('region', { name: '需要我行动' })).toContainText('截止 今天 16:00');
  await expect(page.getByRole('region', { name: '等待外部' })).toContainText('等待 供应商回传');
  await expect(page.getByRole('region', { name: '内部未完' })).toContainText('补客户税号');

  await as(page, `${manager}|reviewer|P-1`);
  await expect(page.getByRole('region', { name: '需要我行动' }).locator(`[data-item="${managerOnly}"]`)).toBeVisible();
  await expect(page.getByRole('region', { name: '等待外部' }).locator(`[data-item="${managerWaiting}"]`)).toBeVisible();
  for (const id of mine) await expect(page.locator(`[data-item="${id}"]`)).toHaveCount(0); // not staff's finance items
});

test('data check before write approval: invalid money is refused, the approval waits, then inherits the confirmed amount; edits retire approvals', async ({ page }) => {
  const staff = uid('staff');
  const check = await item(page, { kind: 'data_check', assigneeUserId: staff, payload: { title: '核对付款金额', amount: 'abc' } });
  const approval = await item(page, { kind: 'action_approval', assigneeUserId: staff, payload: { title: '批准写入付款', dataCheckId: check, amount: 0 } });
  await as(page, `${staff}|employee|`);

  // the approval cannot go first
  await openItem(page, approval);
  await drawer(page).getByRole('button', { name: '按版本 1 决定' }).click();
  await expect(page.getByLabel('处理结果')).toHaveText('上游的数据核对还没确认，不能批准写入。');

  // invalid money cannot be confirmed; correct it as a saved revision, then confirm
  await openItem(page, check);
  await drawer(page).getByRole('button', { name: '按版本 1 决定' }).click();
  await expect(page.getByLabel('处理结果')).toHaveText('金额无效，不能确认。');
  await drawer(page).getByLabel('修改 amount').fill('480');
  await drawer(page).getByRole('button', { name: '保存修订' }).click();
  await expect(page.getByLabel('处理结果')).toContainText('已保存为版本 2');
  await drawer(page).getByRole('button', { name: '按版本 2 决定' }).click();
  await expect(drawer(page).locator('[data-decision]')).toContainText('这是决定，不是执行授权。');

  // confirming the data did not execute anything: the approval is still waiting for its own decision
  await openItem(page, approval);
  await expect(drawer(page).locator('[data-status]')).toContainText('待处理');
  await drawer(page).getByRole('button', { name: '按版本 1 决定' }).click();
  await expect(drawer(page).getByLabel('决定的内容')).toContainText('480'); // inherited from the confirmed check
  await expect(drawer(page).locator('[data-decision]')).not.toContainText('已失效');

  // an unsaved edit blocks the old approval; saving it retires the approval
  await drawer(page).getByLabel('修改 amount').fill('490');
  await drawer(page).getByRole('button', { name: '暂存修改' }).click();
  await expect(drawer(page).getByRole('note')).toContainText('旧的批准不能执行');
  await drawer(page).getByRole('button', { name: '保存修订' }).click();
  await expect(drawer(page).locator('[data-status]')).toContainText('已撤回');
  await expect(drawer(page).getByRole('button', { name: '按版本 2 决定' })).toBeVisible();

  // revising the confirmed upstream data revokes the downstream approval again
  await drawer(page).getByRole('button', { name: '按版本 2 决定' }).click();
  await openItem(page, check);
  await drawer(page).getByLabel('修改 amount').fill('500');
  await drawer(page).getByRole('button', { name: '保存修订' }).click();
  await openItem(page, approval);
  await expect(drawer(page).locator('[data-status]')).toContainText('已撤回');
});

test('batch: conflict rows cannot be selected, only selected clean rows run, exceptions stay, continuing does not repeat rows', async ({ page }) => {
  const staff = uid('staff');
  const batch = await item(page, {
    kind: 'action_approval', renderer: 'batch_table', assigneeUserId: staff, projectId: 'P-2',
    payload: { title: '批量登记三张发票' },
    rows: [{ id: 'r1', clean: true, selected: false }, { id: 'r2', clean: false, selected: false }, { id: 'r3', clean: true, selected: false }],
  });
  const other = await item(page, { kind: 'supply_info', assigneeUserId: staff, projectId: 'P-3', payload: { title: '另一个项目的事' } });
  await as(page, `${staff}|employee|`);

  // the project filter selects only that project's work
  await page.getByLabel('项目筛选').selectOption('P-2');
  await expect(page.locator(`[data-item="${other}"]`)).toHaveCount(0);
  await openItem(page, batch);
  const rows = drawer(page).getByRole('table', { name: '批量明细' });
  await expect(rows.getByLabel('勾选 r2')).toBeDisabled();
  await expect(rows.locator('[data-row="r2"]')).toContainText('冲突行，不能选，留在例外里');
  await rows.getByLabel('勾选 r1').click(); // controlled by the server: checked once the server accepts it
  await expect(rows.getByLabel('勾选 r1')).toBeChecked();
  await drawer(page).getByRole('button', { name: '按版本 1 决定' }).click();
  await drawer(page).getByRole('button', { name: '执行勾选的干净行' }).click();
  await expect(page.getByLabel('处理结果')).toHaveText('已执行 1 行；冲突行没有执行。');
  await expect(rows.locator('[data-row="r1"]')).toContainText('已执行');
  await expect(rows.locator('[data-row="r3"]')).toContainText('未勾选');

  // continue with r3: r1 is not executed again, r2 is still an exception
  await rows.getByLabel('勾选 r3').click();
  await expect(rows.getByLabel('勾选 r3')).toBeChecked();
  await drawer(page).getByRole('button', { name: '执行勾选的干净行' }).click();
  await expect(page.getByLabel('处理结果')).toHaveText('已执行 2 行；冲突行没有执行。');
  await expect(rows.locator('[data-row="r3"]')).toContainText('已执行');
  await expect(rows.getByLabel('勾选 r1')).toBeDisabled();
  await expect(rows.locator('[data-row="r2"]')).toContainText('冲突行');
});

test('project filter hides batch rows that belong to another project', async ({ page }) => {
  const staff = uid('staff');
  const batch = await item(page, {
    kind: 'action_approval', renderer: 'batch_table', assigneeUserId: staff, projectId: 'P-A',
    rows: [
      { id: 'c', clean: true, selected: false, projectId: 'P-C' },
      { id: 'd', clean: false, selected: false, projectId: 'P-D' },
    ],
  });
  await as(page, `${staff}|employee|`);
  await page.getByLabel('项目筛选').selectOption('P-C');
  await expect(page.locator(`[data-item="${batch}"]`)).toBeVisible();
  await openItem(page, batch);
  await expect(drawer(page).locator('[data-row="c"]')).toContainText('P-C');
  await expect(drawer(page).locator('[data-row="d"]')).toHaveCount(0);
  await expect(drawer(page)).not.toContainText('P-D');
});

test('manual work needs evidence and stays human-reported; waits stay on the case; branch choice is recorded, not an approval', async ({ page }) => {
  const staff = uid('staff');
  const manual = await item(page, { kind: 'manual_execution', assigneeUserId: staff, payload: { title: '在客户系统登记报价号' } });
  const waiting = await item(page, { kind: 'manual_execution', assigneeUserId: staff, waitingOn: '供应商回传发票', payload: { title: '等供应商发票' } });
  const branch = await item(page, { kind: 'branch_choice', assigneeUserId: staff, payload: { title: '保险是否需要预审', options: ['需要预审', '无需预审'] } });
  const review = await item(page, { kind: 'deliverable_review', assigneeUserId: staff, payload: { title: '复核询价草稿', summary: '三家供应商比价' } });
  await as(page, `${staff}|employee|`);

  await openItem(page, manual);
  await expect(drawer(page).getByRole('button', { name: '提交人工回填' })).toBeDisabled();
  await drawer(page).getByLabel('回填凭证').fill('CRM-778');
  await drawer(page).getByRole('button', { name: '提交人工回填' }).click();
  await expect(drawer(page).locator('[data-evidence]')).toHaveText('人工回报，未经系统核验：CRM-778');

  await openItem(page, waiting);
  await expect(drawer(page)).toContainText('供应商回传发票（仍挂在原事项上）');
  await drawer(page).getByLabel('回填凭证').fill('INV-PDF-1');
  await drawer(page).getByRole('button', { name: '提交人工回填' }).click();
  await expect(drawer(page).locator('[data-evidence]')).toContainText('INV-PDF-1');
  await expect(drawer(page).locator('[data-status]')).toContainText('待处理'); // receiving documents does not complete the case
  await expect(page.getByRole('region', { name: '等待外部' }).locator(`[data-item="${waiting}"]`)).toBeVisible();

  await openItem(page, branch);
  await drawer(page).getByLabel('需要预审').click();
  await drawer(page).getByRole('button', { name: '记录选择' }).click();
  await expect(drawer(page).locator('[data-branch]')).toContainText('已记录的路径：需要预审');
  await expect(drawer(page).locator('[data-branch]')).toContainText('记录路径不等于外部审批已通过');
  await drawer(page).getByRole('button', { name: '重新打开' }).click();
  await page.reload();
  await openItem(page, branch);
  await expect(drawer(page).locator('[data-branch]')).toContainText('已记录的路径：需要预审');

  await openItem(page, review);
  await drawer(page).getByRole('button', { name: '按版本 1 决定' }).click();
  await expect(drawer(page).locator('[data-decision]')).toContainText('复核只决定是否接受成果，不授予任何执行权限');
});

test('mail approval shows recipients, attachments, the original and the AI changes; someone else can only look', async ({ page }) => {
  const staff = uid('staff');
  const mail = await item(page, {
    kind: 'action_approval', renderer: 'document_preview', assigneeUserId: staff,
    payload: {
      title: '批准这一次发信', to: 'buyer@synthetic.invalid',
      attachments: [{ name: '报价单.pdf', id: 'att-7f3a' }], original: '请报 200 件的价格', changes: { quantity: '200 → 250' },
      subject: '报价 Q-1001',
    },
  });
  await as(page, `${staff}|employee|`);
  await openItem(page, mail);
  const preview = drawer(page).getByLabel('邮件预览');
  await expect(preview).toContainText('buyer@synthetic.invalid');
  await expect(preview).toContainText('报价单.pdf（att-7f3a）');
  await expect(preview).toContainText('请报 200 件的价格');
  await expect(preview).toContainText('200 → 250');
  await expect(drawer(page).getByRole('button', { name: '按版本 1 决定' })).toBeVisible();

  // the owner can see it but is not the approver: no send, and the API refuses too
  await as(page, OWNER);
  await openItem(page, mail);
  await expect(drawer(page)).toContainText('这不是分给你的事项，只能查看。');
  await expect(drawer(page).getByRole('button', { name: /决定/ })).toHaveCount(0);
  expect((await page.request.post(`/api/v1/work-items/${mail}/decide`, { data: { expectedVersion: 1 }, headers: { 'x-dev-user': OWNER } })).status()).toBe(403);
  // someone unrelated cannot even learn it exists
  expect((await page.request.post(`/api/v1/work-items/${mail}/decide`, { data: { expectedVersion: 1 }, headers: { 'x-dev-user': `${uid('other')}|employee|` } })).status()).toBe(404);
});

test('exception ruling keeps the evidence; a note cannot erase the mismatched system result', async ({ page }) => {
  const manager = uid('manager');
  const exc = await item(page, {
    kind: 'exception_ruling', assigneeUserId: manager,
    payload: { title: '回读不一致', reason: 'readback_mismatch', intended: { amount: 990 }, readback: { amount: 9900 } },
  });
  await as(page, `${manager}|reviewer|`);
  await page.getByLabel('只看例外').click();
  await expect(page.getByLabel('只看例外')).toBeChecked();
  await openItem(page, exc);
  await expect(drawer(page)).toContainText('例外原因：readback_mismatch');
  await drawer(page).getByLabel('备注', { exact: true }).fill('已电话确认，对方系统录错');
  await drawer(page).getByRole('button', { name: '记录备注' }).click();
  await expect(drawer(page).locator('[data-note]')).toContainText('备注不会改变系统结果');
  await expect(drawer(page)).toContainText('批准的值：{"amount":990}');
  await expect(drawer(page)).toContainText('系统回读：{"amount":9900}');
});
