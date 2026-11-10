import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { WorkItemKind, WorkItemRenderer } from '@superagent/shared';
import { viewerFrom } from '../room/index.js';
import { loadInbox, loadWorkItems, saveInbox, type Queryable } from './pg-inbox.js';
import { WorkInbox, type WorkItem } from './work-items.js';
import type { LongWorkDeps } from '../longwork/http.js';
import { longInbox } from '../longwork/inbox.js';

export const inboxState = { current: new WorkInbox() };

let inboxStore: Queryable | null = null;

export function bindInboxStore(db: Queryable | null): void {
  inboxStore = db;
}

export async function flushInbox(): Promise<void> {
  if (inboxStore) await saveInbox(inboxStore, inboxState.current.snapshot());
}

export async function hydrateInbox(): Promise<void> {
  if (!inboxStore) return;
  const saved = await loadInbox(inboxStore);
  if (saved) inboxState.current.load(saved);
  for (const item of await loadWorkItems(inboxStore)) inboxState.current.remember(item);
}

/** Listeners for decided items (the SOP executor resumes the run an approval belongs to). */
export const workItemEvents: { decided: Array<(item: WorkItem) => void | Promise<void>> } = { decided: [] };

const KINDS = new Set<WorkItemKind>([
  'data_check', 'action_approval', 'manual_execution', 'branch_choice', 'exception_ruling', 'supply_info', 'deliverable_review',
]);
const RENDERERS = new Set<WorkItemRenderer>(['field_diff', 'batch_table', 'document_preview', 'issue_list']);

/**
 * The caller's tenant. Undefined only when routes are mounted without auth (dev/tests, single tenant); in production
 * viewerFrom refuses a request without an authenticated user.
 */
function tenantOf(req: FastifyRequest): string | undefined {
  return req.user?.tenantId;
}

/** Resolve the item the caller may act on, or reply 404/403 and return null. */
function acting(req: FastifyRequest, reply: FastifyReply): { id: string; userId: string } | null {
  const { id } = req.params as { id: string };
  const viewer = viewerFrom(req.headers, req.user);
  const result = inboxState.current.actor(id, viewer, tenantOf(req));
  if (result.ok) return { id, userId: viewer.userId };
  void reply.code(result.reason === 'not_assignee' ? 403 : 404).send({ error: result.reason });
  return null;
}

function attempt<T>(reply: FastifyReply, run: () => T): T | FastifyReply {
  try {
    return run();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'rejected';
    return reply.code(message === 'work_item_not_found' ? 404 : 409).send({ error: message });
  }
}

export const humanworkModule: FastifyPluginAsync<{ deps?: LongWorkDeps }> = async (app, { deps }) => {
  app.addHook('onResponse', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD') return;
    await flushInbox();
  });
  app.get('/', async (req) => {
    if (inboxStore) {
      for (const item of await loadWorkItems(inboxStore)) inboxState.current.remember(item);
    }
    const query = req.query as { exceptions?: string; project?: string };
    const viewer = viewerFrom(req.headers, req.user);
    const items = inboxState.current.list(viewer, { exceptionsOnly: query.exceptions === '1', projectId: query.project, tenantId: tenantOf(req) });
    // canAct comes from the same guard the mutations use, so the page never offers a control the server would refuse
    const ordinary = items.map((item) => ({ ...item, canAct: inboxState.current.actor(item.id, viewer, tenantOf(req)).ok }));
    const long = deps && req.user ? await longInbox(deps.work, req.user, query) : [];
    return { items: [...ordinary, ...long] };
  });

  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: WorkItemKind;
      renderer?: WorkItemRenderer;
      projectId?: string;
      payload?: Record<string, unknown>;
      waitingOn?: string;
      assigneeUserId?: string;
      rows?: Array<{ id: string; clean: boolean; selected: boolean; projectId?: string | null }>;
    };
    if (!body.kind || !KINDS.has(body.kind)) return reply.code(400).send({ error: 'bad_kind' });
    if (body.renderer && !RENDERERS.has(body.renderer)) return reply.code(400).send({ error: 'bad_renderer' });
    const viewer = viewerFrom(req.headers, req.user);
    const owner = viewer.roles.includes('owner') || viewer.roles.includes('admin');
    return inboxState.current.create({
      tenantId: tenantOf(req) ?? 't',
      kind: body.kind,
      renderer: body.renderer,
      projectId: body.projectId ?? null,
      assigneeUserId: owner && body.assigneeUserId ? body.assigneeUserId : viewer.userId,
      payload: body.payload,
      waitingOn: body.waitingOn ?? null,
      rows: body.rows,
    });
  });

  app.post('/:id/decide', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    const body = (req.body ?? {}) as { expectedVersion?: number };
    if (typeof body.expectedVersion !== 'number') return reply.code(400).send({ error: 'missing_version' });
    const result = inboxState.current.decide(who.id, who.userId, body.expectedVersion);
    if (result.ok) for (const listener of workItemEvents.decided) await listener(result.item);
    return result;
  });

  /** Unsaved edits: they block execution of the old approval but do not change what was approved. */
  app.post('/:id/stage', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    const body = (req.body ?? {}) as { patch?: Record<string, unknown> };
    return attempt(reply, () => inboxState.current.stage(who.id, body.patch ?? {}));
  });

  /** Saved revision: a new payload version; the previous approval no longer applies. */
  app.post('/:id/revise', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    const body = (req.body ?? {}) as { patch?: Record<string, unknown> };
    return attempt(reply, () => inboxState.current.revise(who.id, body.patch ?? {}));
  });

  app.post('/:id/evidence', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    const body = (req.body ?? {}) as { reference?: string };
    return attempt(reply, () => inboxState.current.recordHumanEvidence(who.id, body.reference ?? ''));
  });

  app.post('/:id/note', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    const body = (req.body ?? {}) as { note?: string };
    return attempt(reply, () => inboxState.current.annotate(who.id, body.note ?? ''));
  });

  app.post('/:id/branch', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    const body = (req.body ?? {}) as { choice?: string };
    if (!body.choice) return reply.code(400).send({ error: 'missing_choice' });
    const choice = body.choice;
    return attempt(reply, () => inboxState.current.chooseBranch(who.id, who.userId, choice));
  });

  app.post('/:id/reopen', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    return attempt(reply, () => inboxState.current.reopen(who.id));
  });

  app.post('/:id/rows/:rowId', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    const params = req.params as { rowId: string };
    const body = (req.body ?? {}) as { selected?: boolean };
    return inboxState.current.selectRow(who.id, params.rowId, body.selected === true);
  });

  /** Executes only the selected clean rows of an approved batch; rows already executed are not repeated. */
  app.post('/:id/execute-batch', async (req, reply) => {
    const who = acting(req, reply);
    if (!who) return reply;
    return attempt(reply, () => inboxState.current.executeBatch(who.id));
  });
};
