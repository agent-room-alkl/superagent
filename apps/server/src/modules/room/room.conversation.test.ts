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

it('an employee that goes offline holds its task as the same waiting task; the asker resumes it only once it is back', () => {
  const live: EmployeeRef[] = employees.map((employee) => ({ ...employee }));
  const service = new CommandRoom(() => live, () => new Date('2026-11-10T00:00:00.000Z'));
  const posted = say(service, owner, '@销售员工 请核对客户资料');
  const id = posted.task!.id;
  expect(service.holdDisconnected()).toEqual([]); // nothing to do while the employee is online

  live[0]!.status = 'paused';
  const held = service.holdDisconnected();
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({ kind: 'hold', taskIds: [id] });
  expect(service.holdDisconnected()).toEqual([]); // held once
  expect(service.listTasks(owner)).toHaveLength(1);
  expect(service.listTasks(owner)[0]).toMatchObject({ id, status: 'waiting', waitingReason: '等待连接', messageId: posted.message.id });

  expect(() => service.resume(id, owner, 'r1')).toThrow(/employee_offline/);
  expect(() => service.resume(id, sales, 'r2')).toThrow(/forbidden/); // the assignee did not ask for it
  expect(() => service.resume(id, finance, 'r3')).toThrow(/task_not_found/);

  live[0]!.status = 'active';
  expect(service.holdDisconnected()).toEqual([]); // coming back does not resume anything by itself
  expect(service.listTasks(owner)[0]?.status).toBe('waiting');
  const resumed = service.resume(id, owner, 'r4');
  expect(resumed).toMatchObject({ kind: 'resume', taskIds: [id] });
  expect(service.resume(id, owner, 'r4').id).toBe(resumed.id);
  expect(() => service.resume(id, owner, 'r5')).toThrow(/not_waiting/);
  expect(service.listTasks(owner)).toEqual([expect.objectContaining({ id, status: 'assigned', waitingReason: null, messageId: posted.message.id })]);
  // a task waiting for the model is not something reconnecting can fix
  const model = service.post({ roomId: 'room-1', tenantId: 't', authorUserId: 'user-owner', body: '@销售员工 整理报价', clientMessageId: 'm-down', modelAvailable: false });
  expect(() => service.resume(model.task!.id, owner, 'r6')).toThrow(/not_waiting/);
});

it('revising the acceptance contract voids the earlier acceptance and keeps the task, its reports and its run', () => {
  const service = room();
  const posted = say(service, owner, '@销售员工 请登记付款 INV-555');
  const id = posted.task!.id;
  expect(posted.task).toMatchObject({ contract: null, runId: null, approval: 'required' });
  expect(() => service.reviseContract(id, sales, '核对金额', 'k0')).toThrow(/forbidden/); // the assignee did not ask
  expect(() => service.reviseContract(id, owner, '   ', 'k1')).toThrow(/invalid_contract/);

  const first = service.reviseContract(id, owner, '核对金额与供应商', 'k2');
  expect(first).toMatchObject({ revised: false, task: { contract: { version: 1, criteria: '核对金额与供应商' } } });
  expect(first.message).toMatchObject({ kind: 'contract', taskIds: [id] });
  expect(service.reviseContract(id, owner, '核对金额与供应商', 'k2').message.id).toBe(first.message.id); // same click
  expect(() => service.reviseContract(id, owner, '核对金额与供应商', 'k3')).toThrow(/contract_unchanged/);

  service.linkRun(id, owner, 'run_1');
  expect(service.linkRun(id, owner, 'run_1').runId).toBe('run_1');
  expect(() => service.linkRun(id, owner, 'run_2')).toThrow(/run_already_linked/);
  service.report(id, 'user-sales', '已登记，回读一致', 'rep');
  service.review(id, owner, 'rev');
  expect(service.task(id, owner)).toMatchObject({ status: 'reviewed', reviewedByUserId: 'user-owner' });

  const revised = service.reviseContract(id, owner, '必须核对金额、供应商和产品编号，负责人独立复核', 'k4');
  expect(revised.revised).toBe(true);
  expect(revised.message.body).toContain('第 2 版');
  expect(revised.task).toMatchObject({ id, status: 'reported', reviewedByUserId: null, runId: 'run_1', messageId: posted.message.id, contract: { version: 2 } });
  expect(service.listTasks(owner)).toHaveLength(1);
  // acceptance is against the new contract: the person reviews again
  expect(service.review(id, owner, 'rev-2').kind).toBe('review');
  const reloaded = CommandRoom.restore(employees, service.snapshot());
  expect(reloaded.task(id, owner)).toMatchObject({ runId: 'run_1', contract: { version: 2 }, status: 'reviewed' });
});

it('refuses hold and ask-input on reported tasks so a reported task is not overwritten back to waiting (T-82 #6)', () => {
  const service = new CommandRoom(employees);
  const task = say(service, sales, '@销售员工 请整理客户跟进草稿').task!;
  service.report(task.id, 'user-sales', '跟进草稿已整理好', 'rep-t82-1');
  expect(() => service.askInput(task.id, sales)).toThrow(/task_reported/);
  expect(() => service.holdForPermission(task.id, sales, 'crm.contact.read')).toThrow(/task_reported/);
  expect(service.task(task.id, sales).status).toBe('reported');
});
