/**
 * Test double for the SOP runtime contract agreed with T-41 (/api/v1/sop). In-memory; used only by the E2E server
 * until the real runtime module is merged. Publish runs the shared structural check (validateSopGraph) against the
 * employee/tool context in the request body (as the runtime does), then reports the ten runtime gates.
 */
import type { FastifyPluginAsync } from 'fastify';
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
  revision: number;
  validatedRevision: number | null;
  definition: { graph?: SopGraph; [k: string]: unknown };
}

export function fakeSopRuntime(): FastifyPluginAsync {
  const versions: Version[] = [];
  let seq = 0;
  const ofSop = (sopId: string) => versions.filter((v) => v.sopId === sopId);
  return async (r) => {
    // Shapes match the runtime on feat/runtime: { sops: [{ sopId, latest }] } and { versions }.
    r.get('/', async () => ({
      sops: [...new Set(versions.map((v) => v.sopId))].map((sopId) => {
        const latest = ofSop(sopId).at(-1)!;
        return { sopId, latest: { id: latest.id, number: latest.number, status: latest.status } };
      }),
    }));
    r.get<{ Params: { sopId: string } }>('/:sopId/versions', async (req) => ({ versions: ofSop(req.params.sopId) }));
    r.get<{ Params: { id: string } }>('/versions/:id', async (req, reply) => versions.find((v) => v.id === req.params.id) ?? reply.code(404).send({ error: 'not_found' }));
    r.post<{ Body: { sopId: string; definition: Version['definition'] } }>('/drafts', async (req) => {
      const v: Version = { id: `v${++seq}`, sopId: req.body.sopId, number: ofSop(req.body.sopId).length + 1, status: 'draft', report: null, runningInstances: 0, effectiveAt: null, revision: 1, validatedRevision: null, definition: req.body.definition };
      versions.push(v);
      return v;
    });
    r.put<{ Params: { id: string }; Body: { definition: Version['definition'] } }>('/drafts/:id', async (req, reply) => {
      const base = versions.find((v) => v.id === req.params.id);
      if (!base) return reply.code(404).send({ error: 'not_found' });
      if (base.status !== 'published') {
        base.definition = req.body.definition;
        base.status = 'draft'; // any saved edit invalidates a previous validation
        base.revision += 1;
        return base;
      }
      // a published version is never edited: revise opens a new draft
      const v: Version = { ...base, id: `v${++seq}`, number: ofSop(base.sopId).length + 1, status: 'draft', report: null, runningInstances: 0, effectiveAt: null, revision: 1, validatedRevision: null, definition: req.body.definition };
      versions.push(v);
      return v;
    });
    type Ctx = { employees?: SopGraphContext['employees']; tools?: SopGraphContext['tools'] };
    const graphIssues = (v: Version, body: Ctx | undefined) => validateSopGraph(v.definition.graph ?? { nodes: [], edges: [] }, { employees: body?.employees ?? {}, tools: body?.tools ?? {} });
    const unconfirmedPack = (v: Version) => ((v.definition.pack as { items?: { confirmed: boolean }[] } | null | undefined)?.items ?? []).some((i) => !i.confirmed);

    // Validate = structure check, then the ten gates as regression cases, without publishing.
    r.post<{ Params: { id: string }; Body: Ctx }>('/:id/validate', async (req, reply) => {
      const v = versions.find((x) => x.id === req.params.id);
      if (!v) return reply.code(404).send({ error: 'version_not_found' });
      const issues = graphIssues(v, req.body);
      if (issues.length) return reply.code(409).send({ error: 'graph_invalid', issues });
      if (unconfirmedPack(v)) return reply.code(409).send({ error: 'pack_unconfirmed' });
      v.report = { ok: true, gates: Object.fromEntries(GATES.map((g) => [g, { ok: true, detail: '' }])) };
      v.status = 'passed';
      v.validatedRevision = v.revision;
      return { status: v.status, report: v.report, validatedRevision: v.validatedRevision };
    });

    r.post<{ Params: { id: string }; Body: Ctx & { effectiveAt?: string } }>('/:id/publish', async (req, reply) => {
      const v = versions.find((x) => x.id === req.params.id);
      if (!v) return reply.code(404).send({ error: 'version_not_found' });
      const issues = graphIssues(v, req.body);
      if (issues.length) return reply.code(409).send({ error: 'graph_invalid', issues });
      if (v.status !== 'passed' || v.validatedRevision !== v.revision) return reply.code(409).send({ error: 'validation_stale' });
      v.status = 'published';
      v.effectiveAt = req.body?.effectiveAt ?? null;
      return v;
    });
    // test-only: start an instance pinned to a version
    r.post<{ Params: { id: string } }>('/versions/:id/instances', async (req) => {
      const v = versions.find((x) => x.id === req.params.id)!;
      v.runningInstances++;
      return v;
    });
  };
}
