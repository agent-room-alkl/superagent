/**
 * 指挥室 (T-58): the command room page against the real server — no sample people, transcript or tasks.
 * Digital employees are created through the employee module (as an owner would) and named in the room by @mention.
 * Maps prototype QA qa-conversation, the conversation part of qa-outcomes, and the employee view of qa-room-header.
 * Each test starts from an empty room (test-only reset) and uses its own employee names and user ids.
 */
import type { APIResponse, Page } from '@playwright/test';
import { test, expect } from './fixtures.js';

let seq = 0;
const tag = () => `${Date.now().toString(36)}${++seq}`;
const OWNER = 'e2e-room-owner|owner|';
const staffHeader = (userId: string) => `${userId}|employee|`;

async function ok<T>(r: Promise<APIResponse>): Promise<T> {
  const res = await r;
  expect(res.status(), await res.text()).toBeLessThan(300);
  return (await res.json()) as T;
}

interface Employee { id: string; name: string; ownerUserId: string }
interface Task {
  id: string; title: string; status: string; employeeId: string; assigneeUserId: string; messageId: string; createdByUserId: string;
  followupTo: string | null; approval: string; waitingReason: string | null;
  verification?: string;
  inputSupplement?: string | null;
  hold?: { responsible: string } | null;
  promptSnapshot: { employeeId: string; promptVersion: number | null; modelTier: string | null; takenAt: string } | null;
}
interface Message { id: string; seq: number; body: string; kind: string; taskIds: string[] }

/** A digital employee from the employee module, answered for by `ownerUserId`. Online unless `online` is false. */
async function employee(page: Page, label: string, ownerUserId: string, online = true): Promise<Employee> {
  const name = `${label}${tag()}`;
  const headers = { 'x-dev-user': OWNER };
  const created = await ok<{ id: string }>(page.request.post('/api/v1/employees/', { data: { name, duty: `${label}的日常工作`, prompt: `你是${label}`, ownerUserId }, headers }));
  if (online) {
    await ok(page.request.post(`/api/v1/employees/${created.id}/pause`, { headers }));
    expect((await ok<{ status: string }>(page.request.post(`/api/v1/employees/${created.id}/resume`, { headers }))).status).toBe('online');
  }
  return { id: created.id, name, ownerUserId };
}

const tasksOf = async (page: Page, who: string) =>
  (await ok<{ tasks: Task[] }>(page.request.get('/api/v1/room/tasks?roomId=room-1', { headers: { 'x-dev-user': who } }))).tasks;

/** Post to the room through the API, as the runtime or another person would. */
async function post(page: Page, who: string, body: string, followupTo?: string) {
  return ok<{ message: Message; reply: Message | null; task: Task | null }>(page.request.post('/api/v1/room/messages', {
    data: { roomId: 'room-1', body, clientMessageId: `e2e-${tag()}`, followupTo },
    headers: { 'x-dev-user': who },
  }));
}

const report = (page: Page, who: string, taskId: string, body: string) =>
  page.request.post(`/api/v1/room/tasks/${taskId}/report`, { data: { body, clientMessageId: `e2e-report-${tag()}` }, headers: { 'x-dev-user': who } });

/** Open the room as someone. */
async function as(page: Page, who: string) {
  await page.setExtraHTTPHeaders({ 'x-dev-user': who });
  await page.goto('/#room');
  await page.reload(); // a hash-only goto does not reload; the room must be fetched as the new identity
  await expect(page.locator(`.exec-room[data-view="${who === OWNER ? 'owner' : 'employee'}"]`)).toBeVisible();
}

const stream = (page: Page) => page.locator('.exec-stream');
const draft = (page: Page) => page.getByLabel('发给指挥室');
const taskCards = (page: Page) => page.locator('[data-task]');
const drawer = (page: Page) => page.getByRole('complementary', { name: '任务详情' });

/** Type a message and send it with Enter; the draft is empty again once the server has it. */
async function say(page: Page, text: string) {
  await draft(page).fill(text);
  await draft(page).press('Enter');
  await expect(draft(page)).toHaveValue('');
}

test.beforeEach(async ({ page }) => {
  await ok(page.request.post('/__e2e/room/reset'));
});

test('a new room has no tasks; greetings, questions and discussion only get a reply; one @mention with work makes one task', async ({ page }) => {
  const staff = `e2e-room-staff-${tag()}`;
  const sales = await employee(page, '销售员工', staff);
  await as(page, OWNER);

  // nothing is invented before anyone speaks
  await expect(taskCards(page)).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: '任务列表' })).toContainText('当前没有由对话产生的任务。');
  await expect(stream(page).locator('[data-message]')).toHaveCount(0);

  await say(page, '你好'); // Enter sends
  await expect(stream(page)).toContainText('需要派活时直接 @数字员工');
  await say(page, '现在有哪些数字员工在线？');
  await expect(stream(page)).toContainText(/当前有 \d+ 名数字员工在线/);
  await expect(stream(page).locator('[data-kind="reply"]').last()).toContainText(sales.name);
  await say(page, '我们希望把售后做得更好');
  await expect(stream(page)).toContainText('这件事最终要得到什么结果？');
  await say(page, '请发送邮件给客户'); // an outward action with nobody named: ask first
  await expect(stream(page)).toContainText('请先补充具体对象');
  await expect(taskCards(page)).toHaveCount(0);
  expect(await tasksOf(page, OWNER)).toEqual([]);

  // the mention picker opens, lists the real employee, and writes "@name " into the draft
  await page.getByRole('button', { name: '@ 提及' }).click();
  const picker = page.getByRole('listbox', { name: '选择数字员工' });
  await expect(picker).toBeVisible();
  await picker.locator(`[data-mention="${sales.id}"]`).click();
  await expect(picker).toHaveCount(0);
  await expect(draft(page)).toHaveValue(`@${sales.name} `);
  await draft(page).pressSequentially('请整理一份供应商询价草稿');
  await page.getByRole('button', { name: '发送' }).click();

  await expect(taskCards(page)).toHaveCount(1);
  const [task] = await tasksOf(page, OWNER);
  expect(task).toMatchObject({ title: '请整理一份供应商询价草稿', employeeId: sales.id, assigneeUserId: staff, createdByUserId: 'e2e-room-owner', status: 'assigned', followupTo: null });
  expect(task!.promptSnapshot).toMatchObject({ employeeId: sales.id, promptVersion: 1 });
  expect(task!.messageId).toBeTruthy();

  // the task carries who it went to, the message it came from and the prompt snapshot
  await taskCards(page).first().click();
  await expect(drawer(page).locator('[data-assignee]')).toHaveText(`@${sales.name}`);
  await expect(drawer(page).locator('[data-source]')).toContainText(`@${sales.name} 请整理一份供应商询价草稿`);
  await expect(drawer(page).locator('[data-snapshot]')).toContainText('提示词第 1 版');
  await expect(drawer(page).locator('[data-evidence]')).toContainText('还没有回报。');
  await drawer(page).getByRole('button', { name: '关闭' }).click();

  // Shift+Enter is a new line and sends nothing; Enter sends both lines as one message
  const before = await stream(page).locator('[data-message]').count();
  await draft(page).pressSequentially('背景第一行');
  await draft(page).press('Shift+Enter');
  await draft(page).pressSequentially('背景第二行');
  await expect(draft(page)).toHaveValue('背景第一行\n背景第二行');
  expect(await stream(page).locator('[data-message]').count()).toBe(before);
  await draft(page).press('Enter');
  await expect(draft(page)).toHaveValue('');
  await expect(stream(page).locator('[data-message]')).toHaveCount(before + 2); // the message and the reply
  await expect(taskCards(page)).toHaveCount(1);

  // the transcript is the scroll area; the page itself does not get a second scrollbar
  expect(await stream(page).evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto');
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 1)).toBe(true);
});

test('a report shows up without touching the draft; the reported task stays, links its evidence, and waits for a person to accept it', async ({ page }) => {
  const staff = `e2e-room-staff-${tag()}`;
  const sales = await employee(page, '销售员工', staff);
  await as(page, OWNER);
  await say(page, `@${sales.name} 请整理一份供应商询价草稿`);
  await expect(taskCards(page)).toHaveCount(1);
  await expect(stream(page)).toContainText(`已交给 @${sales.name}`);
  const [task] = await tasksOf(page, OWNER);

  // the owner is in the middle of typing when the employee's report arrives
  await draft(page).fill('我还在补充背景，请不要丢失这段文字');
  await draft(page).evaluate((el) => { (window as unknown as { composer?: Element }).composer = el; });
  expect((await report(page, OWNER, task!.id, '不是我的任务')).status()).toBe(403); // only the assignee reports
  expect((await report(page, staffHeader(staff), task!.id, '询价草稿已放在对话里，尚未发送给供应商')).status()).toBe(200);
  await expect(stream(page).locator('[data-kind="report"]')).toContainText('尚未发送给供应商', { timeout: 15_000 });
  await expect(stream(page).locator('[data-kind="report"] strong')).toHaveText(sales.name);
  await expect(draft(page)).toHaveValue('我还在补充背景，请不要丢失这段文字');
  expect(await draft(page).evaluate((el) => (window as unknown as { composer?: Element }).composer === el)).toBe(true); // same composer, not re-created
  await draft(page).fill('');

  // reported is not accepted: the task is still listed, with its evidence linked back to the conversation
  await expect(taskCards(page)).toHaveCount(1);
  await expect(taskCards(page).first()).toContainText('已回报，待复核');
  await taskCards(page).first().click();
  await expect(drawer(page).locator('[data-status]')).toHaveText('已回报，待复核');
  await expect(drawer(page).locator('[data-evidence]')).toContainText('询价草稿已放在对话里，尚未发送给供应商');
  await expect(drawer(page).locator('[data-evidence]')).toContainText('回报不等于已被接受');
  await drawer(page).getByRole('button', { name: '回到原消息' }).click();
  await expect(stream(page).locator(`#room-msg-${task!.messageId}`)).toHaveClass(/exec-message-focus/);
  await expect(stream(page).locator(`#room-msg-${task!.messageId}`)).toBeInViewport();

  // a person accepts the result; it is still on the list afterwards
  await drawer(page).getByRole('button', { name: '复核通过' }).click();
  await expect(drawer(page).locator('[data-status]')).toHaveText('已复核');
  await expect(taskCards(page).first()).toContainText('已复核');
  await expect(stream(page).locator('[data-kind="review"]')).toContainText('已复核通过');
  expect((await tasksOf(page, OWNER))[0]).toMatchObject({ status: 'reviewed', reviewedByUserId: 'e2e-room-owner' });
});

test('a new message lands in view; a follow-up keeps the original task; read-only work needs no approval; a task can be cancelled', async ({ page }) => {
  const staff = `e2e-room-staff-${tag()}`;
  const sales = await employee(page, '销售员工', staff);
  const finance = await employee(page, '财务员工', `e2e-room-fin-${tag()}`);
  const ops = await employee(page, '运营员工', `e2e-room-ops-${tag()}`, false); // never connected
  const first = (await post(page, OWNER, `@${sales.name} 请整理询价草稿`)).task!;
  for (let i = 1; i <= 8; i++) await post(page, OWNER, `我们讨论一下第 ${i} 个想法`); // enough lines to scroll
  await as(page, OWNER);
  await expect(stream(page).locator('[data-message]')).toHaveCount(18);

  // reading old history, then sending: the new message is where the reader is looking
  await stream(page).evaluate((el) => { el.scrollTop = 0; });
  await say(page, '我们再看看交期');
  await expect(stream(page).locator('[data-message]')).toHaveCount(20);
  await expect.poll(() => stream(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(100);
  await expect(stream(page).locator('[data-message]').last()).toBeInViewport();

  // follow-up: no employee named again, the original task's employee and context carry over
  await page.locator(`[data-task="${first.id}"]`).click();
  await drawer(page).getByRole('button', { name: '追问' }).click();
  await expect(page.locator(`[data-followup="${first.id}"]`)).toContainText('追问：');
  await say(page, '请补充交期问题');
  await expect(taskCards(page)).toHaveCount(2);
  const followup = (await tasksOf(page, OWNER)).find((task) => task.followupTo === first.id);
  expect(followup).toMatchObject({ employeeId: sales.id, assigneeUserId: staff, title: '请补充交期问题' });
  await expect(page.locator('[data-followup]')).toHaveCount(0); // one follow-up, then back to normal sending
  await page.locator(`[data-task="${followup!.id}"]`).click();
  await expect(drawer(page).locator('[data-followup-of]')).toContainText('请整理询价草稿');
  await expect(drawer(page).locator('[data-assignee]')).toHaveText(`@${sales.name}`);

  // read-only finance work is a task with no action approval: nothing lands in anyone's approval inbox
  const inbox = async () => (await ok<{ items: unknown[] }>(page.request.get('/api/v1/work-items/', { headers: { 'x-dev-user': OWNER } }))).items.length;
  const approvalsBefore = await inbox();
  await say(page, `@${finance.name} 请核对预算`);
  await expect(taskCards(page)).toHaveCount(3);
  const budget = (await tasksOf(page, OWNER)).find((task) => task.employeeId === finance.id);
  expect(budget).toMatchObject({ approval: 'none', status: 'assigned' });
  await page.locator(`[data-task="${budget!.id}"]`).click();
  await expect(drawer(page).locator('[data-approval]')).toContainText('不需要动作审批');
  expect(await inbox()).toBe(approvalsBefore);

  // an employee that is not connected gets a waiting task, never a pretend result; the owner cancels it
  await say(page, `@${ops.name} 请核对当前库存`);
  await expect(taskCards(page)).toHaveCount(4);
  const stock = (await tasksOf(page, OWNER)).find((task) => task.employeeId === ops.id);
  expect(stock).toMatchObject({ status: 'waiting', waitingReason: '等待连接' });
  await page.locator(`[data-task="${stock!.id}"]`).click();
  await drawer(page).getByRole('button', { name: '取消任务' }).click();
  await expect(drawer(page).locator('[data-status]')).toHaveText('已取消');
  await expect(stream(page).locator('[data-kind="cancel"]')).toHaveText(/已取消：请核对当前库存/);
  await expect(drawer(page).getByRole('button', { name: '取消任务' })).toHaveCount(0);
  await expect(taskCards(page)).toHaveCount(4); // cancelled, not deleted
  expect((await tasksOf(page, OWNER)).find((task) => task.id === stock!.id)?.status).toBe('cancelled');
});

test('an employee sees and assigns only their own digital employee; drafts stay with the person who wrote them', async ({ page }) => {
  const staff = `e2e-room-staff-${tag()}`;
  const other = `e2e-room-fin-${tag()}`;
  const sales = await employee(page, '销售员工', staff);
  const finance = await employee(page, '财务员工', other);
  const budget = (await post(page, OWNER, `@${finance.name} 请核对预算`)).task!;
  const mine = (await post(page, OWNER, `@${sales.name} 请整理询价草稿`)).task!;
  await post(page, OWNER, '你好');

  // the owner leaves an unsent draft
  await as(page, OWNER);
  await expect(page.locator('.sidebar a')).toHaveCount(7);
  await expect(page.locator('a[href="#brain"].exec-action')).toBeVisible();
  await draft(page).fill('负责人私有草稿');

  // the employee signs in on the same browser
  await as(page, staffHeader(staff));
  await expect(draft(page)).toHaveValue(''); // the owner's draft does not follow the identity
  await expect(page.locator('a[href="#brain"]')).toHaveCount(0); // no super-agent configuration for an employee
  await expect(page.locator('.sidebar a')).toHaveCount(2); // 指挥室 and 待我处理 only
  await expect(page.locator('.page-head p')).toContainText('跟进自己负责');
  const h1 = await page.locator('.page-head h1').boundingBox();
  const sub = await page.locator('.page-head p').boundingBox();
  const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(mid(h1!) - mid(sub!))).toBeLessThanOrEqual(4); // same single row as the owner's header
  expect(sub!.x).toBeGreaterThan(h1!.x + h1!.width - 1);

  // their own task is there; the other employee's work is nowhere on the page
  await expect(taskCards(page)).toHaveCount(1);
  await expect(page.locator(`[data-task="${mine.id}"]`)).toBeVisible();
  await expect(stream(page)).toContainText('请整理询价草稿');
  await expect(page.locator('body')).not.toContainText('核对预算');
  await expect(page.locator('body')).not.toContainText(finance.name);
  expect((await tasksOf(page, staffHeader(staff))).map((task) => task.id)).toEqual([mine.id]);
  for (const action of ['cancel', 'review']) {
    const res = await page.request.post(`/api/v1/room/tasks/${budget.id}/${action}`, { data: { clientMessageId: `e2e-${tag()}` }, headers: { 'x-dev-user': staffHeader(staff) } });
    expect(res.status()).toBe(404); // not even that it exists
  }

  // the mention menu offers only their own employee
  await page.getByRole('button', { name: '@ 提及' }).click();
  const picker = page.getByRole('listbox', { name: '选择数字员工' });
  await expect(picker.getByRole('option')).toHaveCount(1);
  await expect(picker.locator(`[data-mention="${sales.id}"]`)).toBeVisible();
  await expect(picker.locator(`[data-mention="${finance.id}"]`)).toHaveCount(0);
  await draft(page).press('Escape');
  await expect(picker).toHaveCount(0);

  // typing the other employee's name by hand is refused and creates nothing
  await say(page, `@${finance.name} 请核对预算`);
  await expect(stream(page)).toContainText('不在当前身份可以指派的范围内');
  await expect(taskCards(page)).toHaveCount(1);
  expect((await tasksOf(page, OWNER)).filter((task) => task.employeeId === finance.id)).toHaveLength(1); // still only the owner's

  // work for their own employee goes through
  await say(page, `@${sales.name} 请整理客户回复草稿`);
  await expect(taskCards(page)).toHaveCount(2);
  expect((await tasksOf(page, staffHeader(staff))).map((task) => task.createdByUserId)).toContain(staff);

  // the person answering for the other employee sees none of this
  const theirs = await ok<{ messages: Message[] }>(page.request.get('/api/v1/room/messages?roomId=room-1&after=0', { headers: { 'x-dev-user': staffHeader(other) } }));
  expect(theirs.messages.map((message) => message.body).join('\n')).not.toContain(sales.name);

  // they report on their own task from the page
  await page.locator(`[data-task="${mine.id}"]`).click();
  await expect(drawer(page).locator('[data-assignee]')).toContainText('由你负责');
  await expect(drawer(page).getByRole('button', { name: '提交回报' })).toBeDisabled(); // an empty report is not a report
  await drawer(page).getByLabel('回报内容').fill('询价草稿已整理好，尚未发送');
  await drawer(page).getByRole('button', { name: '提交回报' }).click();
  await expect(drawer(page).locator('[data-status]')).toHaveText('已回报，待复核');
  await expect(drawer(page).getByRole('button', { name: '复核通过' })).toHaveCount(0); // they did not ask for it, so they do not accept it

  // back as the owner: the draft they left is restored
  await as(page, OWNER);
  await expect(draft(page)).toHaveValue('负责人私有草稿');
  await expect(taskCards(page)).toHaveCount(3);
});

test('an empty summary invents nothing; an unsent draft stays unsent; failed evidence cannot be accepted', async ({ page }) => {
  await as(page, OWNER);
  await expect(page.locator('[data-outcome="summary"]')).toContainText('暂无事项');
  await expect(page.locator('[data-outcome="summary-message"]')).toHaveCount(0);

  const staff = `e2e-room-staff-${tag()}`;
  const fin = `e2e-room-fin-${tag()}`;
  const sales = await employee(page, '销售员工', staff);
  const finance = await employee(page, '财务员工', fin);
  const draftTask = (await post(page, OWNER, `@${sales.name} 请整理询价草稿`)).task!;
  const financeTask = (await post(page, OWNER, `@${finance.name} 请核对预算`)).task!;
  expect((await report(page, staffHeader(staff), draftTask.id, '询价草稿已放在对话里')).status()).toBe(200);

  await as(page, staffHeader(staff));
  await expect(page.locator('[data-outcome="summary"]')).toContainText('请整理询价草稿');
  await expect(page.locator('[data-outcome="summary"]')).not.toContainText('请核对预算');
  await expect(page.locator('[data-outcome="summary"]')).not.toContainText(finance.name);
  await page.locator('[data-outcome="summary-message"]').click();
  await expect(stream(page).locator(`#room-msg-${draftTask.messageId}`)).toBeVisible();

  await as(page, OWNER);
  await page.locator(`[data-task="${draftTask.id}"]`).click();
  await expect(drawer(page).locator('[data-overview]')).toContainText('尚未发送');
  await expect(drawer(page).locator('[data-overview]')).not.toContainText('"subject"');
  await expect(drawer(page).locator('[data-boundary]')).toHaveText('尚未发送');

  expect((await page.request.post(`/api/v1/room/tasks/${draftTask.id}/verify`, {
    data: { body: null },
    headers: { 'x-dev-user': OWNER },
  })).status()).toBe(200);
  await expect.poll(async () => (await tasksOf(page, OWNER)).find((task) => task.id === draftTask.id)?.verification).toBe('failed');
  await expect(drawer(page).locator('[data-review]')).toBeDisabled();

  expect((await page.request.post(`/api/v1/room/tasks/${draftTask.id}/verify`, {
    data: { body: '请核对报价、可交付数量与交期。' },
    headers: { 'x-dev-user': OWNER },
  })).status()).toBe(200);
  await expect(drawer(page).locator('[data-review]')).toBeEnabled();

  expect((await page.request.post(`/api/v1/room/tasks/${financeTask.id}/ask-input`, { headers: { 'x-dev-user': OWNER } })).status()).toBe(200);
  await page.reload();
  await page.locator(`[data-task="${financeTask.id}"]`).click();
  await page.locator('#outcome-input').fill('   ');
  await page.getByRole('button', { name: '保存补充' }).click();
  await expect(page.locator('#outcome-input-help')).toHaveText('请填写');
  await page.locator('#outcome-input').fill('客户ID C-DEMO-002');
  await page.getByRole('button', { name: '保存补充' }).click();
  await expect.poll(async () => (await tasksOf(page, OWNER)).find((task) => task.id === financeTask.id)?.inputSupplement).toBe('客户ID C-DEMO-002');
  expect(await tasksOf(page, OWNER)).toHaveLength(2);

  expect((await page.request.post(`/api/v1/room/tasks/${financeTask.id}/hold`, { headers: { 'x-dev-user': OWNER } })).status()).toBe(200);
  await page.reload();
  await page.locator(`[data-task="${financeTask.id}"]`).click();
  await expect(drawer(page).locator('[data-blocker]')).toContainText('企业负责人');
  expect((await page.request.post(`/api/v1/room/tasks/${financeTask.id}/release-hold`, {
    data: { clientMessageId: `e2e-release-${tag()}` },
    headers: { 'x-dev-user': OWNER },
  })).status()).toBe(200);
  const resumed = (await tasksOf(page, OWNER)).find((task) => task.id === financeTask.id);
  expect(resumed).toMatchObject({ id: financeTask.id, status: 'assigned', hold: null });
  expect(await tasksOf(page, OWNER)).toHaveLength(2);
});

test('an employee that disconnects keeps the same task waiting; the owner reconnects it and resumes that task, never a new one', async ({ page }) => {
  const staff = `e2e-room-staff-${tag()}`;
  const ops = await employee(page, '运营员工', staff);
  await as(page, OWNER);
  await say(page, `@${ops.name} 请核对客户资料`);
  await expect(taskCards(page)).toHaveCount(1);
  const [task] = await tasksOf(page, OWNER);
  expect(task).toMatchObject({ status: 'assigned', employeeId: ops.id });

  // the employee goes offline in the employee module (the client disconnects or the owner pauses it)
  await ok(page.request.post(`/api/v1/employees/${ops.id}/pause`, { headers: { 'x-dev-user': OWNER } }));
  await expect(taskCards(page).first()).toContainText('等待连接', { timeout: 15_000 });
  await expect(taskCards(page)).toHaveCount(1); // not dropped, not re-created
  await expect(stream(page).locator('[data-kind="hold"]')).toContainText('保留为等待连接');
  expect((await tasksOf(page, OWNER)).map((t) => [t.id, t.status, t.waitingReason])).toEqual([[task!.id, 'waiting', '等待连接']]);

  // resuming before the employee is back is refused and changes nothing
  await taskCards(page).first().click();
  await drawer(page).getByRole('button', { name: '恢复任务' }).click();
  await expect(page.getByLabel('指挥室提示')).toHaveText('数字员工还没有重新连接。请先在「数字员工」里恢复它，再恢复这条任务。');
  await expect(drawer(page).locator('[data-status]')).toHaveText('等待连接');

  // the owner reconnects the employee; that alone does not restart anything
  expect((await ok<{ status: string }>(page.request.post(`/api/v1/employees/${ops.id}/resume`, { headers: { 'x-dev-user': OWNER } }))).status).toBe('online');
  await page.reload();
  await expect(taskCards(page).first()).toContainText('等待连接');

  // resuming continues the same task: same id, same source message, still one task
  await taskCards(page).first().click();
  await drawer(page).getByRole('button', { name: '恢复任务' }).click();
  await expect(drawer(page).locator('[data-status]')).toHaveText('进行中');
  await expect(drawer(page).getByRole('button', { name: '恢复任务' })).toHaveCount(0);
  await expect(stream(page).locator('[data-kind="resume"]')).toContainText('同一任务');
  const after = await tasksOf(page, OWNER);
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: task!.id, messageId: task!.messageId, status: 'assigned', waitingReason: null });

  // the employee's report lands on that same task
  expect((await report(page, staffHeader(staff), task!.id, '客户资料已核对')).status()).toBe(200);
  expect((await tasksOf(page, OWNER))[0]).toMatchObject({ id: task!.id, status: 'reported' });
});
