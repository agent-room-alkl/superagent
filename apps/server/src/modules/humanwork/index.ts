import type { FastifyPluginAsync } from 'fastify';
import type { WorkItemKind, WorkItemRenderer } from '@superagent/shared';
import { viewerFrom } from '../room/index.js';
import { WorkInbox } from './work-items.js';

export const inboxState = { current: new WorkInbox() };

/** Listeners for decided items (the SOP executor resumes the run an approval belongs to). */
export const workItemEvents: { decided: Array<(item: import('./work-items.js').WorkItem) => void> } = { decided: [] };

const KINDS = new Set<WorkItemKind>([
  'data_check', 'action_approval', 'manual_execution', 'branch_choice', 'exception_ruling', 'supply_info', 'deliverable_review',
]);
const RENDERERS = new Set<WorkItemRenderer>(['field_diff', 'batch_table', 'document_preview', 'issue_list']);

export const humanworkModule: FastifyPluginAsync = async (app) => {
  app.get('/', async (req) => {
    const query = req.query as { exceptions?: string; project?: string };
    return {
      items: inboxState.current.list(viewerFrom(req.headers, req.user), {
        exceptionsOnly: query.exceptions === '1',
        projectId: query.project,
      }),
    };
  });

  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      kind?: WorkItemKind;
      renderer?: WorkItemRenderer;
      projectId?: string;
      payload?: Record<string, unknown>;
      waitingOn?: string;
      assigneeUserId?: string;
      rows?: Array<{ id: string; clean: boolean; selected: boolean }>;
    };
    if (!body.kind || !KINDS.has(body.kind)) return reply.code(400).send({ error: 'bad_kind' });
    if (body.renderer && !RENDERERS.has(body.renderer)) return reply.code(400).send({ error: 'bad_renderer' });
    const viewer = viewerFrom(req.headers, req.user);
    const owner = viewer.roles.includes('owner') || viewer.roles.includes('admin');
    return inboxState.current.create({
      tenantId: 't',
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
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { expectedVersion?: number };
    if (typeof body.expectedVersion !== 'number') return reply.code(400).send({ error: 'missing_version' });
    const result = inboxState.current.decide(params.id, viewerFrom(req.headers, req.user).userId, body.expectedVersion);
    if (result.ok) for (const listener of workItemEvents.decided) listener(result.item);
    return result;
  });

  app.post('/:id/revise', async (req) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { patch?: Record<string, unknown> };
    return inboxState.current.revise(params.id, body.patch ?? {});
  });

  app.post('/:id/evidence', async (req, reply) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { reference?: string };
    try {
      return inboxState.current.recordHumanEvidence(params.id, body.reference ?? '');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'rejected';
      return reply.code(message === 'work_item_not_found' ? 404 : 409).send({ error: message });
    }
  });

  app.post('/:id/note', async (req) => {
    const params = req.params as { id: string };
    const body = (req.body ?? {}) as { note?: string };
    return inboxState.current.annotate(params.id, body.note ?? '');
  });

  app.post('/:id/rows/:rowId', async (req) => {
    const params = req.params as { id: string; rowId: string };
    const body = (req.body ?? {}) as { selected?: boolean };
    return inboxState.current.selectRow(params.id, params.rowId, body.selected === true);
  });
};
