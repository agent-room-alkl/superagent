import type { FastifyPluginAsync } from 'fastify';
import type { ToolContract, ToolRoute } from '@superagent/shared';
import { roomState } from '../room/index.js';
import { GateError, ToolService } from './lifecycle.js';

/** Process-wide tool service, shared with the SOP executor (tool availability and effect). */
export const toolsState = { current: new ToolService() };

/** Tool card routes (T-42). Reviewer identity for release is the signed-in user — never taken from the body. */
export const toolsModule: FastifyPluginAsync<{ service?: ToolService }> = async (app, opts) => {
  const svc = opts.service ?? toolsState.current;
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof GateError || err instanceof SyntaxError) return reply.code(409).send({ error: 'gate', message: err.message });
    return reply.send(err);
  });

  const resolveEmployee = (toolId: string, explicit?: string): string | undefined => {
    if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
    const t = svc.get(toolId);
    const waitingHeld = roomState.current
      .listTasks({ userId: 'system', roles: ['owner'], projectScopes: [] })
      .filter((task) => task.status === 'waiting' && task.hold?.toolId === toolId);
    const unreadyHeld = waitingHeld.find((task) => !svc.callable(task.employeeId).some((c) => c.toolId === toolId));
    if (unreadyHeld) return unreadyHeld.employeeId;
    if (waitingHeld[0]) return waitingHeld[0].employeeId;
    return t.consumers[0];
  };

  const view = (toolId: string, employeeId?: string) => {
    const t = svc.get(toolId);
    return { toolId, name: t.name, state: t.state, contractVersion: t.contract.version, activeVersion: t.activeVersion, releases: t.releases.map((r) => ({ version: r.version, healthy: r.deploy?.healthy ?? null })), progress: svc.stage(toolId, resolveEmployee(toolId, employeeId)) };
  };

  app.post<{ Body: { name: string; contract: ToolContract; acceptanceCases: string[]; consumers: string[] } }>('/', async (req) => {
    const t = svc.createPlaceholder({ ...req.body, maintainer: req.user!.userId });
    return view(t.toolId);
  });
  /** Compact list for pickers and SOP graph checks: current lifecycle stage and declared effect. */
  app.get<{ Querystring: { employeeId?: string } }>('/', async (req) =>
    svc.list().map((t) => {
      const p = svc.stage(t.toolId, resolveEmployee(t.toolId, req.query?.employeeId));
      return { toolId: t.toolId, name: t.name, state: t.state, effect: t.contract.effect, stage: p.done.length === 7 ? 'available' : p.current };
    }),
  );
  app.get<{ Params: { id: string }; Querystring: { employeeId?: string } }>('/:id', async (req) => view(req.params.id, req.query?.employeeId));
  app.post<{ Params: { id: string } }>('/:id/confirm', async (req) => (svc.confirmContract(req.params.id), view(req.params.id)));
  app.post<{ Params: { id: string }; Body: { route: ToolRoute; artifact: string; developerOnline?: boolean } }>('/:id/acquire', async (req) => {
    svc.acquire(req.params.id, { ...req.body, developer: req.user!.userId });
    return view(req.params.id);
  });
  app.post<{ Params: { id: string }; Body: { results: Record<string, boolean> } }>('/:id/test', async (req) => (svc.recordTest(req.params.id, req.body.results), view(req.params.id)));
  app.post<{ Params: { id: string } }>('/:id/release', async (req) => (svc.release(req.params.id, req.user!.userId), view(req.params.id)));
  app.post<{ Params: { id: string }; Body: { version: string; healthy: boolean; artifact: string } }>('/:id/deploy', async (req) => {
    svc.recordDeploy(req.params.id, req.body.version, req.body.healthy, req.body.artifact);
    return view(req.params.id);
  });
  app.post<{ Params: { id: string }; Body: { employeeId: string; version?: string } }>('/:id/install', async (req) => (svc.install(req.params.id, req.body.employeeId, req.body.version), view(req.params.id, req.body.employeeId)));
  /** Per-employee account binding. Only a Key Vault reference is accepted — never a credential value. */
  app.post<{ Params: { id: string }; Body: { employeeId: string; credentialRef: string; scope?: Record<string, unknown> } }>('/:id/bind', async (req, reply) => {
    const b = req.body;
    if (!b?.employeeId || typeof b.credentialRef !== 'string' || !/^kv:\/\/[A-Za-z0-9-]{1,127}$/.test(b.credentialRef)) {
      return reply.code(400).send({ error: 'invalid_binding', message: 'credentialRef must be a Key Vault reference like kv://name' });
    }
    const t = svc.get(req.params.id);
    const inst = t.installations.find((i) => i.employeeId === b.employeeId);
    // availability check: the version this employee runs is released with a healthy deployment
    const healthy = () => !!inst && !!t.releases.find((r) => r.version === inst.version)?.deploy?.healthy;
    svc.bind(req.params.id, b.employeeId, b.credentialRef, b.scope ?? {}, healthy);
    return view(req.params.id, b.employeeId);
  });
  app.post<{ Params: { id: string }; Body: { rollback: true } }>('/:id/rollback', async (req) => ({ activeVersion: svc.rollback(req.params.id) }));
};
