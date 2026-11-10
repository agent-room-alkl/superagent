import { validateSopGraph } from '@superagent/shared';
import type { FastifyPluginAsync } from 'fastify';
import { toolsState } from '../tools/index.js';
import { loadSopSnapshot, saveSopSnapshot, type Queryable } from './pg-sop.js';
import { OriginalRequests } from './original-request.js';
import { setSopGraphCheck, SopRuntime, type SopDefinition, type SopGraphContext } from './sop.js';

setSopGraphCheck((graph, context) => validateSopGraph(graph, context as Parameters<typeof validateSopGraph>[1]));

export const sopState = { current: new SopRuntime() };
export const originalRequestState = { current: new OriginalRequests() };

let sopStore: Queryable | null = null;

export function bindSopStore(db: Queryable | null): void {
  sopStore = db;
}

/** Writes the process cache. A worker reads the tables; it does not trust this process's memory. */
export async function flushSop(): Promise<void> {
  if (sopStore) await saveSopSnapshot(sopStore, sopState.current.snapshot());
}

/** Replaces the process cache when Postgres already has versions, instances, or claimed events. */
export async function hydrateSop(): Promise<void> {
  if (!sopStore) return;
  const saved = await loadSopSnapshot(sopStore);
  if (saved.versions.length === 0 && saved.instances.length === 0 && saved.eventKeys.length === 0) return;
  sopState.current = SopRuntime.restore(saved);
}

/** Latest version must itself be published. A newer draft means the flow is no longer the confirmed one. */
function resumeFacts(toolId: string, target: string): { sopConfirmed: boolean; toolUsable: boolean } {
  const sopConfirmed = sopState.current.list().some((row) => row.latest.status === 'published');
  const toolUsable = toolsState.current.callable(target).some((row) => row.toolId === toolId);
  return { sopConfirmed, toolUsable };
}

export const sopModule: FastifyPluginAsync = async (app) => {
  app.get('/', async () => ({ sops: sopState.current.list() }));

  app.get('/original-requests', async () => ({ requests: originalRequestState.current.list() }));

  app.post('/original-requests', async (req, reply) => {
    const body = (req.body ?? {}) as { toolId?: string; target?: string; title?: string };
    if (!body.toolId || !body.target || !body.title) return reply.code(400).send({ error: 'missing_fields' });
    return originalRequestState.current.create({ toolId: body.toolId, target: body.target, title: body.title });
  });

  app.post('/original-requests/:id/resume', async (req, reply) => {
    const params = req.params as { id: string };
    const existing = originalRequestState.current.list().find((item) => item.id === params.id);
    if (!existing) return reply.code(404).send({ error: 'request_not_found' });
    // Gates come from the published SOP and that employee's callable tools. A request body cannot set them.
    const item = originalRequestState.current.resume(params.id, resumeFacts(existing.toolId, existing.target));
    if (!item) return reply.code(404).send({ error: 'request_not_found' });
    return item;
  });

  app.post('/original-requests/:id/pause', async (req, reply) => {
    const params = req.params as { id: string };
    const item = originalRequestState.current.pause(params.id);
    if (!item) return reply.code(404).send({ error: 'request_not_found' });
    return item;
  });

  app.post('/drafts', async (req, reply) => {
    const body = (req.body ?? {}) as { sopId?: string; definition?: SopDefinition };
    if (!body.sopId || !body.definition) return reply.code(400).send({ error: 'missing_fields' });
    const version = sopState.current.draft(body.sopId, body.definition);
    await flushSop();
    return version;
  });

  app.put('/drafts/:id', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { definition?: SopDefinition };
    if (!body.definition) return reply.code(400).send({ error: 'missing_fields' });
    try {
      const version = sopState.current.revise(params.id, body.definition);
      await flushSop();
      return version;
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'version_not_found' });
    }
  });

  app.get('/versions/:id', async (req, reply) => {
    const params = req.params as { id: string };
    try {
      const version = sopState.current.get(params.id);
      return { ...version, runningInstances: sopState.current.runningInstances(version.id) };
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : 'version_not_found' });
    }
  });

  app.get('/:sopId/versions', async (req) => {
    const params = req.params as { sopId: string };
    return { versions: sopState.current.listVersions(params.sopId) };
  });

  app.post('/:id/validate', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as {
      employees?: SopGraphContext['employees'];
      tools?: SopGraphContext['tools'];
    };
    try {
      const result = sopState.current.validate(params.id, { employees: body.employees ?? {}, tools: body.tools ?? {} });
      await flushSop();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'validation_failed';
      return reply.code(message === 'version_not_found' ? 404 : 409).send({ error: message });
    }
  });

  app.post('/:id/publish', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as {
      effectiveAt?: string;
      employees?: SopGraphContext['employees'];
      tools?: SopGraphContext['tools'];
    };
    try {
      const version = sopState.current.publish(params.id, body.effectiveAt, { employees: body.employees ?? {}, tools: body.tools ?? {} });
      await flushSop();
      return version;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'validation_failed';
      const issues = (error as { issues?: unknown }).issues;
      return reply.code(message === 'version_not_found' ? 404 : 409).send(issues ? { error: message, issues } : { error: message });
    }
  });
};
