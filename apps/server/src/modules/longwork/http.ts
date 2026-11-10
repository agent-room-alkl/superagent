import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { canAccessProject } from '../../auth.js';
import type { DateRule } from './dates.js';
import type { ActionDriver, LongWork } from './service.js';
import type { MailTrigger } from './graph.js';
import type { Action } from './store.js';

export interface LongWorkDeps { work: LongWork; mail?: MailTrigger; driver?: ActionDriver; ready(): Promise<boolean>; tick(): Promise<void> }
function manager(req: FastifyRequest) { return req.user?.roles.some(r => r === 'admin' || r === 'owner'); }
function reviewer(req: FastifyRequest) { return manager(req) || req.user?.roles.includes('reviewer'); }
function actionVisible(req: FastifyRequest, a: Action) { return manager(req) || a.assigneeUserId === req.user!.userId || (!a.assigneeUserId && reviewer(req)); }
function actionActor(req: FastifyRequest, a: Action) { return a.assigneeUserId ? a.assigneeUserId === req.user!.userId : reviewer(req); }
async function batchActor(req: FastifyRequest, deps: LongWorkDeps, id: string, projectId: string) {
  const rows = (await deps.work.snapshot(req.user!.tenantId)).actions.filter(a => a.batchId === id && a.projectId === projectId && a.payload.kind !== 'ambiguous_incoming');
  if (!rows.length || !rows.every(a => actionVisible(req, a))) throw Error('not_found');
  if (!rows.every(a => actionActor(req, a))) throw Error('forbidden');
  return rows;
}
function project(req: FastifyRequest, id: unknown): string {
  if (typeof id !== 'string' || !id || !canAccessProject(req.user!, id)) throw Error('not_found'); return id;
}
export const longWorkModule: FastifyPluginAsync<{ deps?: LongWorkDeps }> = async (app, { deps }) => {
  app.addHook('preHandler', async (_req, reply) => { if (!deps) return reply.code(503).send({ error: 'longwork_unavailable' }); });
  app.setErrorHandler((e, _req, reply) => {
    const code = e instanceof Error ? e.message : 'invalid_request';
    if (code === 'not_found') return reply.code(404).send({ error: code });
    if (code === 'forbidden' || code === 'not_authorized') return reply.code(403).send({ error: code });
    if (/conflict|closed|resolved|resubmit|approved/.test(code)) return reply.code(409).send({ error: code });
    // Unexpected adapter/database errors must not reveal SQL, connection details or message bodies.
    if (!/^(invalid_|evidence_required|rule_not_found|calendar_exhausted)/.test(code)) return reply.code(503).send({ error: 'longwork_unavailable' });
    return reply.code(400).send({ error: code });
  });
  app.get('/', async req => {
    const state = await deps!.work.snapshot(req.user!.tenantId);
    return {
      items: state.items.filter(i => canAccessProject(req.user!, i.projectId) && (manager(req) || i.assignee === req.user!.userId)),
      exceptions: reviewer(req) ? state.exceptions.filter(e => canAccessProject(req.user!, e.projectId)) : [],
      actions: state.actions.filter(a => canAccessProject(req.user!, a.projectId) && actionVisible(req, a)),
      collections: state.collections.filter(c => canAccessProject(req.user!, c.projectId) && (manager(req) || c.assigneeUserId === req.user!.userId || c.recipients.includes(req.user!.userId)))
        .map(c => manager(req) || c.assigneeUserId === req.user!.userId ? c : { ...c, recipients: [req.user!.userId], replies: Object.fromEntries(Object.entries(c.replies).filter(([person]) => person === req.user!.userId)), missing: c.missing.filter(person => person === req.user!.userId) }),
    };
  });
  app.post<{ Params: { id: string }; Body: { projectId: string; itemId: string } }>('/exceptions/:id/resolve', async req => {
    if (!reviewer(req)) throw Error('forbidden');
    const p = project(req, req.body.projectId);
    const e = (await deps!.work.snapshot(req.user!.tenantId)).exceptions.find(e => e.id === req.params.id && e.projectId === p);
    if (!e) throw Error('not_found');
    if (e.assignee !== req.user!.userId) throw Error('forbidden');
    return deps!.work.resolve(req.user!.tenantId, req.params.id, req.body.itemId, p);
  });
  app.post<{ Params: { id: string }; Body: { projectId: string } }>('/items/:id/close', async req =>
    deps!.work.close(req.user!.tenantId, req.params.id, project(req, req.body.projectId), req.user!.userId));
  app.post<{ Params: { id: string }; Body: { projectId: string } }>('/exceptions/:id/new-item', async req => {
    if (!reviewer(req)) throw Error('forbidden'); const p = project(req, req.body.projectId);
    const state = await deps!.work.snapshot(req.user!.tenantId);
    const e = state.exceptions.find(e => e.id === req.params.id && e.projectId === p); if (!e) throw Error('not_found');
    if (e.assignee !== req.user!.userId) throw Error('forbidden');
    const candidate = state.items.find(i => e.candidates.includes(i.id));
    const source = deps!.mail?.sources.find(s => s.id === (e.sourceId ?? candidate?.sourceId) && s.tenant === req.user!.tenantId && s.projectId === p);
    if (!source) throw Error('not_found');
    return deps!.work.resolveAsNew(source, e.id);
  });
  app.post<{ Body: { sourceId: string; requestId: string; person: string; threadId: string; evidence: string } }>('/items/waits', async req => {
    if (!manager(req)) throw Error('forbidden');
    const s = deps!.mail?.sources.find(s => s.id === req.body.sourceId && s.tenant === req.user!.tenantId);
    if (!s) throw Error('not_found'); project(req, s.projectId);
    return deps!.work.openWaiting(s, req.body);
  });
  app.post<{ Body: DateRule }>('/date-rules', async req => {
    if (!manager(req)) throw Error('forbidden'); return deps!.work.saveRule(req.user!.tenantId, req.body);
  });
  app.post<{ Body: { ruleId: string; version: number; objects: Array<{ id: string; fields: Record<string, unknown> }> } }>('/dates', async req => {
    if (!manager(req)) throw Error('forbidden');
    if (!Array.isArray(req.body.objects) || req.body.objects.length > 500) throw Error('invalid_objects');
    return deps!.work.dates(req.user!.tenantId, req.body.ruleId, req.body.version, req.body.objects);
  });
  app.post<{ Body: { id: string; projectId: string; assigneeUserId?: string; rows: Array<{ id: string; payload: Record<string, unknown>; clean?: boolean }> } }>('/batches', async req => {
    if (!manager(req)) throw Error('forbidden');
    return deps!.work.createBatch(req.user!.tenantId, req.body.id, project(req, req.body.projectId), req.body.rows, req.body.assigneeUserId);
  });
  app.post<{ Params: { id: string }; Body: { projectId: string; selected: Array<{ id: string; hash: string }> } }>('/batches/:id/approve', async req => {
    const p = project(req, req.body.projectId); await batchActor(req, deps!, req.params.id, p);
    return deps!.work.approve(req.user!.tenantId, req.params.id, p, req.body.selected, req.user!.userId);
  });
  app.post<{ Params: { id: string }; Body: { projectId: string; selected: string[] } }>('/batches/:id/selection', async req => {
    const p = project(req, req.body.projectId); await batchActor(req, deps!, req.params.id, p);
    return deps!.work.selectRows(req.user!.tenantId, req.params.id, p, req.body.selected, req.user!.userId);
  });
  for (const mode of ['run-selected', 'readback'] as const) app.post<{ Params: { id: string }; Body: { projectId: string } }>(`/batches/:id/${mode}`, async (req, reply) => {
    const p = project(req, req.body.projectId); await batchActor(req, deps!, req.params.id, p);
    if (!deps!.driver) return reply.code(503).send({ error: 'connector_not_configured', message: 'No external action was submitted' });
    return deps!.work.runSelected(req.user!.tenantId, req.params.id, p, req.user!.userId, deps!.driver, mode === 'readback');
  });
  app.post<{ Params: { id: string }; Body: { projectId: string } }>('/actions/:id/run', async (req, reply) => {
    const p = project(req, req.body.projectId);
    const a = (await deps!.work.snapshot(req.user!.tenantId)).actions.find(a => a.id === req.params.id && a.projectId === p);
    if (!a || !actionVisible(req, a)) throw Error('not_found');
    if (!actionActor(req, a)) throw Error('forbidden');
    if (!deps!.driver) return reply.code(503).send({ error: 'connector_not_configured', message: 'No external action was submitted' });
    return deps!.work.run(req.user!.tenantId, req.params.id, p, deps!.driver);
  });
  app.post<{ Body: { id: string; projectId: string; deadline: string; recipients: string[]; assigneeUserId?: string; approverUserId?: string } }>('/collections', async req => {
    if (!manager(req)) throw Error('forbidden');
    const b = req.body; const assigneeUserId = b.assigneeUserId ?? req.user!.userId;
    return deps!.work.collect(req.user!.tenantId, { id: b.id, projectId: project(req, b.projectId), deadline: b.deadline, recipients: b.recipients, assigneeUserId, approverUserId: b.approverUserId ?? assigneeUserId });
  });
  app.post<{ Params: { id: string }; Body: { projectId: string; evidence: string } }>('/collections/:id/reply', async req => {
    // Respondents are the authenticated user. Supplying another person's identity is never accepted.
    return deps!.work.reply(req.user!.tenantId, req.params.id, project(req, req.body.projectId), req.user!.userId, req.body.evidence);
  });
};

/** Public Graph webhook: validates clientState per subscription and persists only a request to scan. */
export const mailWebhook: FastifyPluginAsync<{ deps?: LongWorkDeps }> = async (app, { deps }) => {
  app.post<{ Querystring: { validationToken?: string }; Body: { value?: Array<{ subscriptionId?: string; clientState?: string; lifecycleEvent?: string }> } }>('/integrations/mail', async (req, reply) => {
    if (!deps?.mail) return reply.code(503).send({ error: 'mail_trigger_unavailable' });
    if (typeof req.query.validationToken === 'string') return reply.type('text/plain').send(req.query.validationToken);
    try { await deps.mail.notified(req.body?.value ?? []); return reply.code(202).send(); }
    catch { return reply.code(503).send({ error: 'mail_trigger_unavailable' }); }
  });
};
