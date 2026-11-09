/**
 * Test double for the SOP runtime contract agreed with T-41 (/api/v1/sop). In-memory; used only by the E2E server
 * until the real runtime module is merged. Publish runs the shared structural check (validateSopGraph) against the
 * live tool and employee lists, then reports the ten runtime gates.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { validateSopGraph, type SopGraph, type SopGraphContext } from '@superagent/shared';

const GATES = ['read_ok', 'missing_field', 'over_threshold', 'approval_denied', 'duplicate_event', 'employee_offline', 'paused', 'outcome_unknown', 'permission_revoked', 'write_approval'];

interface Version {
  id: string;
  sopId: string;
  number: number;
  status: 'draft' | 'passed' | 'failed' | 'published';
  report: { ok: boolean; gates: Record<string, { ok: boolean; detail: string }> } | null;
  runningInstances: number;
  effectiveAt: string | null;
  definition: { graph?: SopGraph; [k: string]: unknown };
}

export function fakeSopRuntime(app: FastifyInstance, owner: string): FastifyPluginAsync {
  const versions: Version[] = [];
  let seq = 0;
  const ofSop = (sopId: string) => versions.filter((v) => v.sopId === sopId);
  const context = async (): Promise<SopGraphContext> => {
    const headers = { 'x-dev-user': owner };
    const tools = (await app.inject({ url: '/api/v1/tools/', headers })).json() as { toolId: string; stage: never; effect: never }[];
    const emps = (await app.inject({ url: '/api/v1/employees/', headers })).json() as { id: string; status: string }[];
    return {
      tools: Object.fromEntries(tools.map((t) => [t.toolId, { stage: t.stage, effect: t.effect }])),
      employees: Object.fromEntries(emps.map((e) => [e.id, { status: e.status === 'online' ? 'active' : e.status === 'paused' ? 'paused' : 'offline' }])),
    };
  };

  return async (r) => {
    r.get('/', async () => [...new Set(versions.map((v) => v.sopId))].map((sopId) => ({ sopId })));
    r.get<{ Params: { sopId: string } }>('/:sopId/versions', async (req) => ofSop(req.params.sopId));
    r.get<{ Params: { id: string } }>('/versions/:id', async (req, reply) => versions.find((v) => v.id === req.params.id) ?? reply.code(404).send({ error: 'not_found' }));
    r.post<{ Body: { sopId: string; definition: Version['definition'] } }>('/drafts', async (req) => {
      const v: Version = { id: `v${++seq}`, sopId: req.body.sopId, number: ofSop(req.body.sopId).length + 1, status: 'draft', report: null, runningInstances: 0, effectiveAt: null, definition: req.body.definition };
      versions.push(v);
      return v;
    });
    r.put<{ Params: { id: string }; Body: { definition: Version['definition'] } }>('/drafts/:id', async (req, reply) => {
      const base = versions.find((v) => v.id === req.params.id);
      if (!base) return reply.code(404).send({ error: 'not_found' });
      if (base.status !== 'published') {
        base.definition = req.body.definition;
        base.status = 'draft';
        base.report = null;
        return base;
      }
      // a published version is never edited: revise opens a new draft
      const v: Version = { ...base, id: `v${++seq}`, number: ofSop(base.sopId).length + 1, status: 'draft', report: null, runningInstances: 0, effectiveAt: null, definition: req.body.definition };
      versions.push(v);
      return v;
    });
    r.post<{ Params: { id: string }; Body: { effectiveAt?: string } }>('/:id/publish', async (req, reply) => {
      const v = versions.find((x) => x.id === req.params.id);
      if (!v) return reply.code(404).send({ error: 'not_found' });
      const issues = validateSopGraph(v.definition.graph ?? { nodes: [], edges: [] }, await context());
      const report = { ok: !issues.length, gates: Object.fromEntries(GATES.map((g) => [g, { ok: !issues.length, detail: issues.length ? 'structure check failed' : '' }])) };
      v.report = report;
      if (issues.length) {
        v.status = 'failed';
        return reply.code(409).send({ error: 'validation_failed', report, issues });
      }
      v.status = 'published';
      v.effectiveAt = req.body?.effectiveAt ?? null;
      return { ...v, report };
    });
    // test-only: start an instance pinned to a version
    r.post<{ Params: { id: string } }>('/versions/:id/instances', async (req) => {
      const v = versions.find((x) => x.id === req.params.id)!;
      v.runningInstances++;
      return v;
    });
  };
}
