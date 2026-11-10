import { expect, it } from 'vitest';
import { asksAvailability, isExternalAction, isGreeting, needsParameters, workText } from './intent.js';
import { CommandRoom, type EmployeeRef, type Viewer } from './room.js';

const employees: EmployeeRef[] = [
  { id: 'emp-sales', name: '销售员工', ownerUserId: 'user-sales', status: 'active', promptVersion: 3, modelTier: 'default' },
  { id: 'emp-finance', name: '财务员工', ownerUserId: 'user-finance', status: 'active', promptVersion: 1, modelTier: 'economy' },
  { id: 'emp-ops', name: '运营员工', ownerUserId: 'user-ops', status: 'offline' },
];

const owner: Viewer = { userId: 'user-owner', roles: ['owner'], projectScopes: [] };
const sales: Viewer = { userId: 'user-sales', roles: ['employee'], projectScopes: [] };
const finance: Viewer = { userId: 'user-finance', roles: ['employee'], projectScopes: [] };
const stranger: Viewer = { userId: 'user-stranger', roles: ['employee'], projectScopes: [] };

let n = 0;
function say(room: CommandRoom, viewer: Viewer, body: string, followupTo?: string) {
  return room.post({
    roomId: 'room-1', tenantId: 't', authorUserId: viewer.userId, authorRoles: viewer.roles, authorProjectScopes: viewer.projectScopes,
    body, clientMessageId: `c-${++n}`, followupTo,
  });
}
const room = () => new CommandRoom(employees, () => new Date('2026-11-10T00:00:00.000Z'));

it('reads the wording of a message without calling a model', () => {
  expect(isGreeting('你好！')).toBe(true);
  expect(isGreeting('你好，帮我整理报价')).toBe(false);
  expect(asksAvailability('现在有哪些数字员工在线？')).toBe(true);
  expect(asksAvailability('销售员工能不能用')).toBe(true);
  expect(asksAvailability('整理询价草稿')).toBe(false);
  expect(isExternalAction('请发送邮件给客户')).toBe(true);
  expect(isExternalAction('请核对预算')).toBe(false);
  expect(workText('@销售员工  整理询价草稿')).toBe('整理询价草稿');
  expect(workText('@销售员工')).toBe('');
  expect(workText('请 @销售员工 整理询价草稿')).toBe('请 整理询价草稿');
  expect(needsParameters('@销售员工 请发送邮件给客户')).toBe(true);
  expect(needsParameters('@销售员工 请发送报价 Q-1001 给 buyer@synthetic.invalid')).toBe(false);
  expect(needsParameters('@销售员工 请发送邮件给「华东一号客户」')).toBe(false);
  expect(needsParameters('@销售员工 请整理询价草稿')).toBe(false); // drafting is not an outward action
});

it('a new room has no tasks, and small talk, questions and discussion only get a reply', () => {
  const service = room();
  expect(service.listTasks(owner)).toEqual([]);
  expect(say(service, owner, '你好').reply?.body).toContain('你好');
  expect(say(service, owner, '现在有哪些数字员工在线？').reply?.body).toBe('当前有 2 名数字员工在线：销售员工、财务员工。');
  expect(say(service, sales, '有哪些员工在线').reply?.body).toBe('当前有 1 名数字员工在线：销售员工。'); // only their own
  expect(say(service, owner, '我们希望把售后做得更好').reply?.body).toContain('最终要得到什么结果');
  expect(say(service, owner, '@销售员工').reply?.body).toContain('还不是明确的工作请求');
  expect(service.listTasks(owner)).toEqual([]);
});

it('naming an employee with work creates one task carrying who, the source message and the prompt snapshot', () => {
  const service = room();
  const posted = say(service, owner, '@销售员工 请整理一份供应商询价草稿');
  expect(service.listTasks(owner)).toHaveLength(1);
  expect(posted.task).toMatchObject({
    employeeId: 'emp-sales',
    assigneeUserId: 'user-sales',
    createdByUserId: 'user-owner',
    messageId: posted.message.id,
    status: 'assigned',
    approval: 'none',
    followupTo: null,
    promptSnapshot: { employeeId: 'emp-sales', promptVersion: 3, modelTier: 'default', takenAt: '2026-11-10T00:00:00.000Z' },
  });
  expect(posted.reply?.kind).toBe('reply');
  expect(posted.task?.title).toBe('请整理一份供应商询价草稿');
  expect(posted.reply?.body).toBe('已交给 @销售员工：请整理一份供应商询价草稿');
});

it('an outward action with no object asks for it first; with one, the task is marked as needing approval', () => {
  const service = room();
  const vague = say(service, owner, '请发送邮件给客户');
  expect(vague.task).toBeNull();
  expect(vague.reply?.body).toContain('先补充具体对象');
  const named = say(service, owner, '@销售员工 请发送邮件给客户');
  expect(named.task).toBeNull();
  expect(named.reply?.body).toContain('先补充具体对象');
  const concrete = say(service, owner, '@销售员工 请发送报价 Q-1001 给 buyer@synthetic.invalid');
  expect(concrete.task?.approval).toBe('required');
  const readOnly = say(service, owner, '@财务员工 请核对预算');
  expect(readOnly.task?.approval).toBe('none'); // reading needs no payment approval
});

it('a follow-up continues the original task: same employee, same project, linked both ways', () => {
  const service = room();
  const first = service.post({ roomId: 'room-1', tenantId: 't', projectId: 'p1', authorUserId: 'user-owner', body: '@销售员工 请整理询价草稿', clientMessageId: 'f1' });
  const next = say(service, owner, '请补充交期问题', first.task!.id);
  expect(next.task).toMatchObject({ followupTo: first.task!.id, employeeId: 'emp-sales', projectId: 'p1', assigneeUserId: 'user-sales' });
  expect(next.message.taskIds).toEqual([first.task!.id, next.task!.id]);
  expect(next.reply?.body).toContain('的追问交给 @销售员工');
  // a follow-up to a task the author cannot see says nothing about it
  const hidden = say(service, finance, '继续', first.task!.id);
  expect(hidden.task).toBeNull();
  expect(hidden.reply?.body).toContain('找不到要追问的任务');
  expect(hidden.message.taskIds).toEqual([]);
});

it('a reported task stays listed until a person accepts it; the assignee cannot accept their own report', () => {
  const service = room();
  const posted = say(service, owner, '@销售员工 请整理询价草稿');
  const id = posted.task!.id;
  expect(() => service.review(id, owner, 'r0')).toThrow(/not_reported/);
  const report = service.report(id, 'user-sales', '询价草稿已放在对话里，尚未发送', 'rep-1');
  expect(report.kind).toBe('report');
  expect(service.listTasks(owner).map((task) => task.status)).toEqual(['reported']);
  expect(() => service.review(id, sales, 'r1')).toThrow(/forbidden/);
  expect(() => service.review(id, stranger, 'r2')).toThrow(/task_not_found/);
  const accepted = service.review(id, owner, 'r3');
  expect(accepted.kind).toBe('review');
  expect(service.review(id, owner, 'r3').id).toBe(accepted.id); // the same click twice is one message
  expect(service.listTasks(owner)[0]).toMatchObject({ status: 'reviewed', reviewedByUserId: 'user-owner' });
  expect(() => service.report(id, 'user-sales', '再报一次', 'rep-2')).toThrow(/task_closed/);
});

it('the person who asked can cancel an open task, once; nobody else can', () => {
  const service = room();
  const id = say(service, owner, '@运营员工 请核对当前库存').task!.id;
  expect(service.listTasks(owner)[0]?.status).toBe('waiting');
  expect(() => service.cancel(id, sales, 'x1')).toThrow(/task_not_found/);
  const notice = service.cancel(id, owner, 'x2');
  expect(notice).toMatchObject({ kind: 'cancel', body: '已取消：请核对当前库存', taskIds: [id] });
  expect(service.listTasks(owner)[0]).toMatchObject({ status: 'cancelled', waitingReason: null });
  expect(() => service.cancel(id, owner, 'x3')).toThrow(/task_closed/);
  expect(() => service.report(id, 'user-ops', '已核对', 'x4')).toThrow(/task_closed/);
});

it('someone answering for one employee sees and assigns only that employee', () => {
  const service = room();
  say(service, owner, '你好');
  say(service, owner, '@财务员工 请核对预算');
  const mine = say(service, owner, '@销售员工 请整理询价草稿');

  expect(service.roster(owner).map((employee) => employee.id)).toEqual(['emp-sales', 'emp-finance', 'emp-ops']);
  expect(service.roster(sales).map((employee) => employee.id)).toEqual(['emp-sales']);
  expect(service.listTasks(sales).map((task) => task.id)).toEqual([mine.task!.id]);
  const seen = service.eventsAfter('room-1', 0, sales).map((message) => message.body).join('\n');
  expect(seen).toContain('请整理询价草稿');
  expect(seen).not.toContain('核对预算'); // neither the request nor the super agent's hand-over
  expect(seen).not.toContain('你好'); // the owner's own conversation is not theirs to read

  const other = say(service, sales, '@财务员工 请核对预算');
  expect(other.task).toBeNull();
  expect(other.reply?.body).toContain('不在当前身份');
  const own = say(service, sales, '@销售员工 请整理客户回复草稿');
  expect(own.task).toMatchObject({ employeeId: 'emp-sales', createdByUserId: 'user-sales', assigneeUserId: 'user-sales' });
  // they read their own messages and the replies to them, including the refusal
  const after = service.eventsAfter('room-1', 0, sales).map((message) => message.body);
  expect(after).toContain(other.reply!.body);
  // the finance owner never sees that the sales owner tried
  expect(service.eventsAfter('room-1', 0, finance).some((message) => message.authorUserId === 'user-sales')).toBe(false);
  // someone answering for nobody is not in the room at all
  expect(service.eventsAfter('room-1', 0, stranger)).toEqual([]);
  expect(service.listTasks(stranger)).toEqual([]);
});

it('a snapshot written before tasks carried context still loads, and reports keep their kind', () => {
  const service = room();
  const posted = say(service, owner, '@销售员工 请整理询价草稿');
  service.report(posted.task!.id, 'user-sales', '询价草稿已放在对话里', 'old-report');
  const saved = service.snapshot();
  const old = {
    ...saved,
    messages: saved.messages.map(({ kind: _kind, ...message }) => message),
    tasks: saved.tasks.map(({ createdByUserId: _c, followupTo: _f, promptSnapshot: _p, approval: _a, reviewedByUserId: _r, ...task }) => task),
  } as unknown as typeof saved;
  const reloaded = CommandRoom.restore(employees, old);
  expect(reloaded.eventsAfter('room-1', 0, owner).map((message) => message.kind)).toEqual(['message', 'reply', 'report']);
  expect(reloaded.listTasks(owner)[0]).toMatchObject({ approval: 'none', followupTo: null, promptSnapshot: null, reviewedByUserId: null });
  expect(CommandRoom.restore(employees, saved).listTasks(owner)[0]?.promptSnapshot?.promptVersion).toBe(3);
});
