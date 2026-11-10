import { expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { EmployeeService } from '../employees/employees.js';
import { employeesState } from '../employees/index.js';
import { createCommandRoom, roomState } from '../room/index.js';
import type { RoomTask } from '../room/room.js';
import { executionState } from '../execution/index.js';
import { gatewayState } from '../gateway/index.js';
import { outcomeOf } from '../room/outcome.js';

it('only resumes the same waiting request after its employee is online, with stable evidence and no duplicate task', async () => {
  const previous = { employees: employeesState.current, room: roomState.current };
  employeesState.current = new EmployeeService(); roomState.current = createCommandRoom();
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 'tenant' } });
  const owner = { 'x-dev-user': 'owner|owner|p' }; const staff = { 'x-dev-user': 'staff|employee|p' }; const other = { 'x-dev-user': 'other|employee|p' };
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/employees/', headers: owner,
      payload: { name: 'SyntheticReviewer', duty: 'Review synthetic records', prompt: 'Draft only', ownerUserId: 'staff' } });
    expect(created.statusCode).toBe(200); const employee = created.json() as { id: string };
    await app.inject({ method: 'POST', url: `/api/v1/employees/${employee.id}/pause`, headers: owner });
    const posted = await app.inject({ method: 'POST', url: '/api/v1/room/messages', headers: owner,
      payload: { roomId: 'room-1', projectId: 'p', body: '@SyntheticReviewer 请核对这份资料', clientMessageId: 'source' } });
    expect(posted.statusCode).toBe(200); const original = posted.json().task as RoomTask;
    expect(original.status).toBe('waiting');
    const resume = (clientMessageId: string, headers = owner) => app.inject({ method: 'POST', url: `/api/v1/room/tasks/${original.id}/resume`, headers, payload: { clientMessageId } });
    expect((await resume('other', other)).statusCode).toBe(404);
    expect((await resume('staff', staff)).statusCode).toBe(403);
    expect((await resume('still-paused')).statusCode).toBe(409);
    const tasks = async () => (await app.inject({ url: '/api/v1/room/tasks?roomId=room-1', headers: owner })).json().tasks as RoomTask[];
    expect(await tasks()).toHaveLength(1); expect((await tasks())[0]!.status).toBe('waiting');
    const online = await app.inject({ method: 'POST', url: `/api/v1/employees/${employee.id}/resume`, headers: owner });
    expect(online.json().status).toBe('online');
    expect((await resume('resume')).statusCode).toBe(200);
    expect((await resume('resume')).statusCode).toBe(200);
    const after = await tasks(); expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: original.id, status: 'assigned', messageId: original.messageId, createdByUserId: original.createdByUserId,
      employeeId: original.employeeId, promptSnapshot: original.promptSnapshot });
    await app.inject({ method: 'POST', url: `/api/v1/room/tasks/${original.id}/cancel`, headers: owner, payload: { clientMessageId: 'cancel' } });
    expect((await resume('after-cancel')).statusCode).toBe(409);
    expect((await tasks())[0]!.status).toBe('cancelled');
  } finally { await app.close(); employeesState.current = previous.employees; roomState.current = previous.room; }
});

it('does not describe a read-only probe as an external write attempt', () => {
  const previous = { runs: executionState.current.snapshot(), gateway: gatewayState.current.snapshot() };
  try {
    executionState.current.load({ seq: 0, runs: [{ id: 'ex_read', tenantId: 'tenant', sopId: 'read', versionId: 'v', versionNumber: 1,
      instanceId: 'read', eventId: 'read-only', startedBy: 'staff', input: {}, status: 'completed', steps: [], exceptionItemId: null }] });
    gatewayState.current.load({ actions: [] });
    const read = gatewayState.current.execute({ tenantId: 'tenant', instanceId: 'read', stepId: 'lookup', businessKey: 'read-only', effect: 'read',
      payload: { record: 'synthetic' }, approvalHash: null, authorize: () => true, call: () => undefined });
    expect(read.action.calls).toBe(1);
    expect(outcomeOf('tenant', 'ex_read')?.attempts).toBe(0);
  } finally { executionState.current.load(previous.runs); gatewayState.current.load(previous.gateway); }
});

it('an employee cannot attach another person\'s execution to a task they created', async () => {
  const previous = { employees: employeesState.current, room: roomState.current, runs: executionState.current.snapshot() };
  employeesState.current = new EmployeeService(); roomState.current = createCommandRoom();
  executionState.current.load({ seq: 0, runs: [{ id: 'ex_private', tenantId: 'tenant', sopId: 'private', versionId: 'v', versionNumber: 1,
    instanceId: 'private', eventId: 'private-record', startedBy: 'another-person', input: {}, status: 'completed', steps: [], exceptionItemId: null }] });
  const app = await buildApp({ auth: { mode: 'dev', platformTenantId: 'tenant' } });
  const owner = { 'x-dev-user': 'owner|owner|p' }; const staff = { 'x-dev-user': 'staff|employee|p' };
  try {
    const created = await app.inject({ method: 'POST', url: '/api/v1/employees/', headers: owner,
      payload: { name: 'SyntheticReviewer', duty: 'Review synthetic records', prompt: 'Draft only', ownerUserId: 'staff' } });
    const id = created.json().id as string;
    await app.inject({ method: 'POST', url: `/api/v1/employees/${id}/pause`, headers: owner });
    await app.inject({ method: 'POST', url: `/api/v1/employees/${id}/resume`, headers: owner });
    const posted = await app.inject({ method: 'POST', url: '/api/v1/room/messages', headers: staff,
      payload: { roomId: 'room-1', projectId: 'p', body: '@SyntheticReviewer 请核对这份资料', clientMessageId: 'own-task' } });
    const task = posted.json().task as RoomTask; expect(task).toBeTruthy();
    const linked = await app.inject({ method: 'POST', url: `/api/v1/room/tasks/${task.id}/run`, headers: staff, payload: { runId: 'ex_private' } });
    const result = await app.inject({ url: `/api/v1/room/tasks/${task.id}/outcome`, headers: staff });
    expect(result.body).not.toContain('private-record');
    expect([403, 404]).toContain(linked.statusCode);
  } finally { await app.close(); employeesState.current = previous.employees; roomState.current = previous.room; executionState.current.load(previous.runs); }
});
