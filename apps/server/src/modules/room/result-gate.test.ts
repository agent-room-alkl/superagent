import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import type { ToolContract } from '@superagent/shared';
import { toolsState } from '../tools/index.js';
import { createCommandRoom, roomModule, roomState } from './index.js';
import { CommandRoom, type EmployeeRef, type Viewer } from './room.js';
import { resultOverview } from './result-gate.js';

const employees: EmployeeRef[] = [
  { id: 'emp-sales', name: '销售员工', ownerUserId: 'user-sales', status: 'active' },
  { id: 'emp-finance', name: '财务员工', ownerUserId: 'user-finance', status: 'active' },
  { id: 'emp-ops', name: '运营员工', ownerUserId: 'user-ops', status: 'active' },
];

const owner: Viewer = { userId: 'user-owner', roles: ['owner'], projectScopes: [] };
const sales: Viewer = { userId: 'user-sales', roles: ['employee'], projectScopes: [] };
const finance: Viewer = { userId: 'user-finance', roles: ['employee'], projectScopes: [] };

function room(): CommandRoom {
  return new CommandRoom(employees, () => new Date('2026-11-11T00:00:00.000Z'));
}

function post(service: CommandRoom, body: string, clientMessageId: string) {
  return service.post({
    roomId: 'room-1', tenantId: 't', authorUserId: owner.userId, authorRoles: owner.roles, body, clientMessageId,
  });
}

function makeCallable(toolId: string, employeeId: string) {
  const contract: ToolContract = {
    toolId, action: 'crm.read', purpose: 'Read a contact', targetSystem: 'app.example.com', effect: 'read',
    input: { type: 'object', properties: {} }, output: { type: 'object', properties: {} }, risk: 'low', requiresExactApproval: false,
  };
  const svc = toolsState.current;
  svc.createPlaceholder({ name: toolId, contract, acceptanceCases: ['normal'], consumers: [employeeId], maintainer: 'm1' });
  svc.confirmContract(toolId);
  svc.acquire(toolId, { route: 'import', developer: 'd1', artifact: 'script' });
  svc.recordTest(toolId, { normal: true });
  const released = svc.release(toolId, 'reviewer-1');
  svc.recordDeploy(toolId, released.version, true, 'script');
  svc.install(toolId, employeeId);
  svc.bind(toolId, employeeId, 'kv://cred', { projects: ['P-1'] }, () => true);
}

beforeEach(() => {
  roomState.current = createCommandRoom(employees);
});

it('a draft is unsent as soon as the conversation creates it, and it is not marked done', () => {
  const service = room();
  const posted = post(service, '@销售员工 请整理询价草稿', 'draft-now');
  expect(posted.task).toMatchObject({ status: 'assigned', evidence: { fields: { subject: null, body: null }, sent: false } });
  expect(service.overview(posted.task!.id, owner)).toBe('请整理询价草稿。尚未发送');
  expect(service.listTasks(owner)).toHaveLength(1);
  const other = post(service, '@运营员工 请核对客户资料', 'not-draft');
  expect(other.task?.evidence).toBeNull();
  expect(service.overview(other.task!.id, owner)).toBe('请核对客户资料');
});

it('an empty summary invents nothing, and a sales summary does not leak another owner', () => {
  const service = room();
  expect(service.summary(owner)).toEqual({ label: '暂无事项', tasks: [] });
  post(service, '@财务员工 请核对预算', 'fin');
  post(service, '@销售员工 请整理询价草稿', 'sales');
  const mine = service.summary(sales);
  expect(mine.label).toBeNull();
  expect(mine.tasks.map((task) => task.employeeId)).toEqual(['emp-sales']);
  expect(JSON.stringify(mine)).not.toContain('财务员工');
  expect(service.summary(finance).tasks.map((task) => task.title)).toEqual(['请核对预算']);
});

it('a draft report keeps the boundary, hides raw fields, and a failed check cannot be accepted', () => {
  const service = room();
  const posted = post(service, '@销售员工 请整理询价草稿', 'draft');
  const id = posted.task!.id;
  service.report(id, 'user-sales', '询价草稿已放在对话里', 'rep');
  const task = service.listTasks(owner)[0]!;
  expect(task.evidence).toEqual({ fields: { subject: null, body: '询价草稿已放在对话里' }, sent: false });
  expect(service.overview(id, owner)).toBe('请整理询价草稿。尚未发送');
  expect(service.overview(id, owner)).not.toContain('"subject"');
  expect(resultOverview(task.title, { fields: { subject: '内部字段', body: task.evidence!.fields.body }, sent: false })).not.toContain('subject');

  service.reviseContract(id, owner, '必须核对金额、供应商和产品编号', 'contract');
  expect(service.verifyEvidence(id, owner).verification).toBe('failed');
  expect(service.task(id, owner).evidence?.fields.body).toBe('询价草稿已放在对话里');
  expect(() => service.review(id, owner, 'rev-fail')).toThrow(/evidence_failed/);
  // Failed verification never counts as completed: the task stays in 'assigned' so the assignee can report again
  expect(service.listTasks(owner)[0]?.status).toBe('assigned');

  // A direct report that fails the contract also stays in 'assigned' with verification='failed'
  service.report(id, 'user-sales', '只核对了金额', 'rep-partial');
  expect(service.task(id, owner)).toMatchObject({ status: 'assigned', verification: 'failed' });

  service.report(id, 'user-sales', '金额、供应商和产品编号都已核对', 'rep-ok');
  expect(service.task(id, owner)).toMatchObject({ status: 'completed', verification: 'verified' });
  expect(service.verifyEvidence(id, owner, { readbackMismatch: true }).verification).toBe('failed');
  expect(service.task(id, owner).status).toBe('assigned');
  expect(service.task(id, owner).evidence?.fields.body).toBe('金额、供应商和产品编号都已核对');
  expect(service.verifyEvidence(id, owner).verification).toBe('verified');
  expect(service.task(id, owner).status).toBe('completed');
  expect(service.listTasks(owner)).toHaveLength(1);
});

it('an empty supplement is refused and a real one stays on the same task', () => {
  const service = room();
  const id = post(service, '@运营员工 请核对客户资料', 'ops').task!.id;
  service.askInput(id, owner);
  expect(() => service.supplement(id, owner, '   ', 'empty')).toThrow(/empty_supplement/);
  expect(service.listTasks(owner)).toHaveLength(1);
  const saved = service.supplement(id, owner, '客户ID C-DEMO-002；使用已确认客户资料', 'sup');
  expect(saved.task.id).toBe(id);
  expect(saved.task.inputSupplement).toContain('C-DEMO-002');
  expect(saved.task.status).toBe('assigned');
  expect(service.listTasks(owner)).toHaveLength(1);
  expect(service.supplement(id, owner, '客户ID C-DEMO-002；使用已确认客户资料', 'sup').message.id).toBe(saved.message.id);
});

it('a permission hold names the enterprise owner and releasing it resumes the same task', () => {
  const service = room();
  const id = post(service, '@运营员工 请核对客户资料', 'hold').task!.id;
  const held = service.holdForPermission(id, owner, 'crm.contact.read');
  expect(held.id).toBe(id);
  expect(held.hold).toMatchObject({ responsible: '企业负责人', toolId: 'crm.contact.read' });
  expect(held.waitingReason).toContain('企业负责人');
  expect(service.listTasks(owner)).toHaveLength(1);
  expect(() => service.releaseHold(id, owner, 'no', { toolUsable: false })).toThrow(/hold_not_satisfied/);
  expect(service.listTasks(owner)[0]).toMatchObject({ id, status: 'waiting', hold: { toolId: 'crm.contact.read' } });
  const released = service.releaseHold(id, owner, 'go', { toolUsable: true });
  expect(released.task).toMatchObject({ id, status: 'assigned', hold: null, waitingReason: null });
  expect(service.listTasks(owner)).toHaveLength(1);
  expect(service.releaseHold(id, owner, 'go', { toolUsable: true }).message.id).toBe(released.message.id);
  expect(() => service.releaseHold(id, owner, 'again', { toolUsable: true })).toThrow(/not_held/);
});

it('an async report leaves the workflow draft the person is editing', () => {
  const service = room();
  const id = post(service, '@运营员工 请核对客户资料', 'sop').task!.id;
  const draft = { steps: [{ task: '保持正在编辑的业务步骤' }] };
  const reported = service.reportBesideDraft(id, 'user-ops', '资料已核对', 'rep-sop', draft);
  expect(reported.draft).toBe(draft);
  expect(draft.steps[0]?.task).toBe('保持正在编辑的业务步骤');
  expect(service.listTasks(owner)).toHaveLength(1);
});

it('serves the summary, the failed check, and the same-task supplement over HTTP', async () => {
  const app = Fastify();
  await app.register(roomModule, { prefix: '/api/v1/room' });
  const ownerHeaders = { 'x-user-id': 'user-owner', 'x-roles': 'owner' };
  const salesHeaders = { 'x-user-id': 'user-sales', 'x-roles': 'employee' };

  const empty = await app.inject({ method: 'GET', url: '/api/v1/room/summary', headers: salesHeaders });
  expect(empty.json()).toEqual({ label: '暂无事项', tasks: [] });

  const posted = await app.inject({
    method: 'POST', url: '/api/v1/room/messages', headers: ownerHeaders,
    payload: { roomId: 'room-1', body: '@销售员工 请整理询价草稿', clientMessageId: 'http-1' },
  });
  const id = posted.json().task.id as string;

  await app.inject({ method: 'POST', url: `/api/v1/room/tasks/${id}/ask-input`, headers: ownerHeaders });
  const blank = await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/supplement`, headers: ownerHeaders,
    payload: { text: '  ', clientMessageId: 'http-blank' },
  });
  expect(blank.statusCode).toBe(400);
  const filled = await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/supplement`, headers: ownerHeaders,
    payload: { text: '客户ID C-DEMO-002', clientMessageId: 'http-sup' },
  });
  expect(filled.json().task.id).toBe(id);
  expect(filled.json().task.inputSupplement).toBe('客户ID C-DEMO-002');
  const listed = await app.inject({ method: 'GET', url: '/api/v1/room/tasks', headers: ownerHeaders });
  expect(listed.json().tasks).toHaveLength(1);

  const employeeId = posted.json().task.employeeId as string;
  const toolId = `room.hold.${Date.now()}`;
  const held = await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/hold`, headers: ownerHeaders,
    payload: { toolId },
  });
  expect(held.statusCode).toBe(200);
  const blocked = await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/release-hold`, headers: ownerHeaders,
    payload: { clientMessageId: 'http-release-blocked', toolUsable: true },
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json()).toEqual({ error: 'hold_not_satisfied' });
  makeCallable(toolId, employeeId);
  const released = await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/release-hold`, headers: ownerHeaders,
    payload: { clientMessageId: 'http-release' },
  });
  expect(released.statusCode).toBe(200);
  expect(released.json().task).toMatchObject({ id, status: 'assigned', hold: null });

  await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/report`, headers: salesHeaders,
    payload: { body: '草稿已整理', clientMessageId: 'http-rep' },
  });
  expect((await app.inject({ method: 'POST', url: `/api/v1/room/tasks/${id}/ask-input`, headers: ownerHeaders })).statusCode).toBe(409);
  expect((await app.inject({ method: 'POST', url: `/api/v1/room/tasks/${id}/hold`, headers: ownerHeaders, payload: { toolId } })).statusCode).toBe(409);
  await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/contract`, headers: ownerHeaders,
    payload: { criteria: '必须核对金额、供应商和产品编号', clientMessageId: 'http-contract' },
  });
  const failed = await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/verify`, headers: ownerHeaders,
    payload: { body: '改写成通过，金额、供应商、产品编号' },
  });
  expect(failed.json().task.verification).toBe('failed');
  expect(failed.json().task.evidence.fields.body).toBe('草稿已整理');
  expect(failed.json().overview).toBe('请整理询价草稿。尚未发送');
  expect(failed.json().overview).not.toContain('"subject"');
  const refused = await app.inject({
    method: 'POST', url: `/api/v1/room/tasks/${id}/review`, headers: ownerHeaders,
    payload: { clientMessageId: 'http-rev' },
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toEqual({ error: 'evidence_failed' });

  await app.close();
});
