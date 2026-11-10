import type { ToolContract } from '@superagent/shared';
import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import { ToolService } from '../tools/lifecycle.js';
import { toolsState } from '../tools/index.js';
import { originalRequestState, sopModule, sopState } from './index.js';
import { OriginalRequests } from './original-request.js';
import { SopRuntime } from './sop.js';

const definition = {
  requiredFields: ['title', 'amount'],
  threshold: { field: 'amount', max: 1000 },
  employeeStatus: 'active' as const,
};

const contract: ToolContract = {
  toolId: 'invoice.lookup',
  action: 'invoice.read',
  purpose: 'Look up an invoice',
  targetSystem: 'app.example.com',
  effect: 'read',
  input: { type: 'object', properties: { lot: { type: 'string' } } },
  output: { type: 'object', properties: { amount: { type: 'string' } } },
  risk: 'low',
  requiresExactApproval: false,
};

beforeEach(() => {
  sopState.current = new SopRuntime();
  originalRequestState.current = new OriginalRequests();
  toolsState.current = new ToolService();
});

async function publishInquiry() {
  const app = Fastify();
  await app.register(sopModule, { prefix: '/api/v1/sop' });
  const drafted = await app.inject({ method: 'POST', url: '/api/v1/sop/drafts', payload: { sopId: 'inquiry', definition } });
  const id = drafted.json().id as string;
  await app.inject({ method: 'POST', url: `/api/v1/sop/${id}/validate`, payload: { employees: {}, tools: {} } });
  const published = await app.inject({ method: 'POST', url: `/api/v1/sop/${id}/publish`, payload: {} });
  expect(published.statusCode).toBe(200);
  return app;
}

function makeCallable(employeeId: string) {
  const svc = toolsState.current;
  svc.createPlaceholder({
    name: 'Invoice lookup',
    contract,
    acceptanceCases: ['normal'],
    consumers: [employeeId],
    maintainer: 'm1',
  });
  svc.confirmContract('invoice.lookup');
  svc.acquire('invoice.lookup', { route: 'import', developer: 'd1', artifact: 'script' });
  svc.recordTest('invoice.lookup', { normal: true });
  const released = svc.release('invoice.lookup', 'reviewer-1');
  svc.recordDeploy('invoice.lookup', released.version, true, 'script');
  svc.install('invoice.lookup', employeeId);
  svc.bind('invoice.lookup', employeeId, 'kv://cred', { projects: ['P-1'] }, () => true);
}

it('creates an original request only when asked, and a client cannot claim the SOP or the tool is ready', async () => {
  const app = await publishInquiry();
  // Publishing above is for a later step; start from an unpublished runtime for the bypass check.
  sopState.current = new SopRuntime();
  const empty = await app.inject({ method: 'GET', url: '/api/v1/sop/original-requests' });
  expect(empty.json().requests).toEqual([]);

  const missing = await app.inject({ method: 'POST', url: '/api/v1/sop/original-requests', payload: { toolId: 'invoice.lookup' } });
  expect(missing.statusCode).toBe(400);

  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/sop/original-requests',
    payload: { toolId: 'invoice.lookup', target: 'emp-1', title: '按发票准备业务结果' },
  });
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({ id: 'REQ-1', status: 'needs_tool', executed: false });
  const again = await app.inject({
    method: 'POST',
    url: '/api/v1/sop/original-requests',
    payload: { toolId: 'invoice.lookup', target: 'emp-1', title: '再点一次' },
  });
  expect(again.json().id).toBe('REQ-1');
  expect((await app.inject({ method: 'GET', url: '/api/v1/sop/original-requests' })).json().requests).toHaveLength(1);

  makeCallable('emp-1');
  const forged = await app.inject({
    method: 'POST',
    url: '/api/v1/sop/original-requests/REQ-1/resume',
    payload: { sopConfirmed: true, toolUsable: true },
  });
  expect(forged.json().status).toBe('needs_tool');
  expect(forged.json().note).toMatch(/流程尚未/);
  expect(forged.json().executed).toBe(false);
  await app.close();
});

it('keeps a paused request paused, then resumes the same one only after the SOP is published and that employee can call the tool', async () => {
  const app = await publishInquiry();
  makeCallable('emp-2');
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/sop/original-requests',
    payload: { toolId: 'invoice.lookup', target: 'emp-1', title: '按发票准备业务结果' },
  });
  const id = created.json().id as string;

  const otherEmployee = await app.inject({ method: 'POST', url: `/api/v1/sop/original-requests/${id}/resume`, payload: {} });
  expect(otherEmployee.json().status).toBe('needs_tool');
  expect(otherEmployee.json().note).toMatch(/仍缺当前目标员工/);
  expect(otherEmployee.json().executed).toBe(false);

  makeCallableForTarget();
  const paused = await app.inject({ method: 'POST', url: `/api/v1/sop/original-requests/${id}/pause` });
  expect(paused.json().status).toBe('paused');
  const held = await app.inject({ method: 'POST', url: `/api/v1/sop/original-requests/${id}/resume`, payload: {} });
  expect(held.json().status).toBe('paused');
  expect(held.json().executed).toBe(false);

  expect((await app.inject({ method: 'POST', url: `/api/v1/sop/original-requests/${id}/pause` })).json().status).toBe('needs_tool');
  const ready = await app.inject({ method: 'POST', url: `/api/v1/sop/original-requests/${id}/resume`, payload: {} });
  expect(ready.json()).toMatchObject({ id, status: 'ready', executed: false });
  expect(ready.json().note).toMatch(/没有重复创建任务或执行外部调用/);
  expect((await app.inject({ method: 'GET', url: '/api/v1/sop/original-requests' })).json().requests).toHaveLength(1);

  const missing = await app.inject({ method: 'POST', url: '/api/v1/sop/original-requests/REQ-missing/resume', payload: {} });
  expect(missing.statusCode).toBe(404);
  await app.close();
});

/** The first test's helper installs for emp-1. This one installs for emp-1 on the already-created card. */
function makeCallableForTarget() {
  const svc = toolsState.current;
  svc.install('invoice.lookup', 'emp-1');
  svc.bind('invoice.lookup', 'emp-1', 'kv://cred-emp-1', { projects: ['P-1'] }, () => true);
}
