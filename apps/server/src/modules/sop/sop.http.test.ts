import { validateSopGraph } from '@superagent/shared';
import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import { originalRequestState, sopModule, sopState } from './index.js';
import { OriginalRequests } from './original-request.js';
import { setSopGraphCheck, SopRuntime } from './sop.js';

beforeEach(() => {
  sopState.current = new SopRuntime();
  originalRequestState.current = new OriginalRequests();
  setSopGraphCheck(null);
});

it('lists versions with the gate report and keeps an optional graph on revise', async () => {
  const app = Fastify();
  await app.register(sopModule, { prefix: '/api/v1/sop' });
  const definition = {
    requiredFields: ['title', 'amount'],
    threshold: { field: 'amount', max: 1000 },
    employeeStatus: 'active' as const,
    graph: {
      nodes: [{ id: 'n1', kind: 'trigger' as const, ref: 'manual', label: '开始' }],
      edges: [] as { from: string; to: string }[],
    },
  };
  const drafted = await app.inject({
    method: 'POST',
    url: '/api/v1/sop/drafts',
    payload: { sopId: 'inquiry', definition },
  });
  expect(drafted.statusCode).toBe(200);
  const id = drafted.json().id as string;

  const revised = await app.inject({
    method: 'PUT',
    url: `/api/v1/sop/drafts/${id}`,
    payload: { definition: { ...definition, graph: { ...definition.graph, edges: [{ from: 'n1', to: 'n1' }] } } },
  });
  expect(revised.json().definition.graph.edges).toEqual([{ from: 'n1', to: 'n1' }]);
  expect(revised.json().status).toBe('draft');
  expect(revised.json().revision).toBe(2);

  const checked = await app.inject({
    method: 'POST',
    url: `/api/v1/sop/${id}/validate`,
    payload: { employees: {}, tools: {} },
  });
  expect(checked.statusCode).toBe(200);
  expect(checked.json().status).toBe('passed');
  expect(checked.json().validatedRevision).toBe(2);
  expect(Object.keys(checked.json().report.gates)).toHaveLength(10);

  const published = await app.inject({
    method: 'POST',
    url: `/api/v1/sop/${id}/publish`,
    payload: { effectiveAt: '2026-11-10T00:00:00.000Z' },
  });
  expect(published.statusCode).toBe(200);
  expect(published.json().status).toBe('published');
  expect(published.json().effectiveAt).toBe('2026-11-10T00:00:00.000Z');
  expect(published.json().report.ok).toBe(true);
  expect(Object.keys(published.json().report.gates)).toHaveLength(10);
  sopState.current.manualStart('t', id, 'evt-1', true);

  const listed = await app.inject({ method: 'GET', url: '/api/v1/sop/inquiry/versions' });
  expect(listed.json().versions).toHaveLength(1);
  expect(listed.json().versions[0].runningInstances).toBe(1);
  expect(listed.json().versions[0].number).toBe(1);
  const index = await app.inject({ method: 'GET', url: '/api/v1/sop' });
  expect(index.json().sops).toEqual([{ sopId: 'inquiry', latest: expect.objectContaining({ id, status: 'published', number: 1 }) }]);

  const one = await app.inject({ method: 'GET', url: `/api/v1/sop/versions/${id}` });
  expect(one.json().sopId).toBe('inquiry');

  const bad = await app.inject({
    method: 'POST',
    url: `/api/v1/sop/${id}/publish`,
    payload: { effectiveAt: 'not-a-time' },
  });
  expect(bad.statusCode).toBe(409);
  expect(bad.json().error).toBe('bad_effective_at');
});

it('publish returns 409 and leaves the draft when the graph check reports an issue', async () => {
  setSopGraphCheck(() => [{ code: 'write_without_review', nodeId: 'tool-1', message: '写入前需要人工审核' }]);
  const app = Fastify();
  await app.register(sopModule, { prefix: '/api/v1/sop' });
  const drafted = await app.inject({
    method: 'POST',
    url: '/api/v1/sop/drafts',
    payload: {
      sopId: 'inquiry',
      definition: {
        requiredFields: ['title', 'amount'],
        threshold: { field: 'amount', max: 1000 },
        employeeStatus: 'active',
        graph: { nodes: [{ id: 'tool-1', kind: 'tool', label: '写入' }], edges: [] },
      },
    },
  });
  const id = drafted.json().id as string;
  const checked = await app.inject({
    method: 'POST',
    url: `/api/v1/sop/${id}/validate`,
    payload: { employees: {}, tools: { 'tool-1': { stage: 'available', effect: 'write' } } },
  });
  expect(checked.statusCode).toBe(200);
  expect(checked.json().status).toBe('failed');
  expect(checked.json().validatedRevision).toBe(1);
  expect(checked.json().issues).toEqual([{ code: 'write_without_review', nodeId: 'tool-1', message: '写入前需要人工审核' }]);
  expect(Object.keys(checked.json().report.gates)).toHaveLength(10);
  expect(sopState.current.get(id).status).toBe('failed');

  setSopGraphCheck(null);
  const passed = await app.inject({
    method: 'POST',
    url: `/api/v1/sop/${id}/validate`,
    payload: { employees: {}, tools: {} },
  });
  expect(passed.json().status).toBe('passed');

  setSopGraphCheck(() => [{ code: 'write_without_review', nodeId: 'tool-1', message: '写入前需要人工审核' }]);
  const blocked = await app.inject({
    method: 'POST',
    url: `/api/v1/sop/${id}/publish`,
    payload: { employees: {}, tools: { 'tool-1': { stage: 'available', effect: 'write' } } },
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error).toBe('graph_invalid');
  expect(blocked.json().issues).toEqual([{ code: 'write_without_review', nodeId: 'tool-1', message: '写入前需要人工审核' }]);
  expect(sopState.current.get(id).status).toBe('passed');
});

it('validate uses the shared graph check, so a self-loop fails before publish', async () => {
  setSopGraphCheck((graph, context) => validateSopGraph(graph, context as Parameters<typeof validateSopGraph>[1]));
  const app = Fastify();
  await app.register(sopModule, { prefix: '/api/v1/sop' });
  const drafted = await app.inject({
    method: 'POST',
    url: '/api/v1/sop/drafts',
    payload: {
      sopId: 'inquiry',
      definition: {
        requiredFields: ['title', 'amount'],
        threshold: { field: 'amount', max: 1000 },
        employeeStatus: 'active',
        graph: {
          nodes: [{ id: 'n1', kind: 'trigger', label: '开始' }],
          edges: [{ from: 'n1', to: 'n1' }],
        },
      },
    },
  });
  const id = drafted.json().id as string;
  const checked = await app.inject({
    method: 'POST',
    url: `/api/v1/sop/${id}/validate`,
    payload: { employees: {}, tools: {} },
  });
  expect(checked.statusCode).toBe(200);
  expect(checked.json().status).toBe('failed');
  expect(checked.json().issues.some((issue: { code: string }) => issue.code === 'self_loop')).toBe(true);
  const refused = await app.inject({ method: 'POST', url: `/api/v1/sop/${id}/publish`, payload: {} });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toBe('validation_stale');
  await app.close();
});

it('publish refuses a draft whose revision moved after the last pass', async () => {
  const app = Fastify();
  await app.register(sopModule, { prefix: '/api/v1/sop' });
  const definition = { requiredFields: ['title', 'amount'], threshold: { field: 'amount', max: 1000 }, employeeStatus: 'active' as const };
  const drafted = await app.inject({ method: 'POST', url: '/api/v1/sop/drafts', payload: { sopId: 'inquiry', definition } });
  const id = drafted.json().id as string;
  const passed = await app.inject({ method: 'POST', url: `/api/v1/sop/${id}/validate`, payload: { employees: {}, tools: {} } });
  expect(passed.json().status).toBe('passed');
  const revised = await app.inject({ method: 'PUT', url: `/api/v1/sop/drafts/${id}`, payload: { definition } });
  expect(revised.json().revision).toBe(2);
  expect(revised.json().status).toBe('draft');
  const refused = await app.inject({ method: 'POST', url: `/api/v1/sop/${id}/publish`, payload: {} });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toBe('validation_stale');
  expect(sopState.current.get(id).status).toBe('draft');
  await app.close();
});
