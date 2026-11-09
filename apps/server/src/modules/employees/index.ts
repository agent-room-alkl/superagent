import type { FastifyPluginAsync } from 'fastify';
import { EmployeeService } from './employees.js';

/** Digital employee routes (T-42). */
export const employeesModule: FastifyPluginAsync<{ service?: EmployeeService }> = async (app, opts) => {
  const svc = opts.service ?? new EmployeeService();
  const view = (id: string) => {
    const e = svc.get(id);
    return { id: e.id, name: e.name, duty: e.duty, status: e.status, source: e.source, promptVersion: svc.currentPrompt(id).version, modelTier: e.modelTier };
  };
  app.get('/', async () => svc.list().map((e) => view(e.id)));
  app.post<{ Body: { name: string; duty: string; prompt: string; source?: 'recommended' | 'manual' } }>('/', async (req) => view(svc.create({ ...req.body, owner: req.user!.userId }).id));
  app.put<{ Params: { id: string }; Body: { prompt: string } }>('/:id/prompt', async (req) => (svc.updatePrompt(req.params.id, req.body.prompt, req.user!.userId), view(req.params.id)));
  app.post<{ Params: { id: string } }>('/:id/pause', async (req) => (svc.pause(req.params.id), view(req.params.id)));
  app.post<{ Params: { id: string } }>('/:id/resume', async (req) => (svc.resume(req.params.id), view(req.params.id)));
  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    try {
      svc.remove(req.params.id);
      return { deleted: true };
    } catch (e) {
      return reply.code(409).send({ error: 'has_active_work', message: (e as Error).message });
    }
  });
};
