import Fastify from 'fastify';
import { beforeEach, expect, it } from 'vitest';
import { canExecute, workGroup } from './work-items.js';
import { humanworkModule, inboxState } from './index.js';
import { WorkInbox } from './work-items.js';

beforeEach(() => {
  inboxState.current = new WorkInbox();
});

const owner = { 'x-user-id': 'owner', 'x-roles': 'owner' };
const alice = { 'x-user-id': 'alice', 'x-roles': 'employee', 'x-projects': 'p1' };
const bob = { 'x-user-id': 'bob', 'x-roles': 'employee', 'x-projects': 'p1' };

async function app() {
  const server = Fastify();
  await server.register(humanworkModule, { prefix: '/api/v1/work-items' });
  return server;
}

it('an employee sees only assigned work, and an exception view hides ordinary items', async () => {
  const server = await app();
  await server.inject({ method: 'POST', url: '/api/v1/work-items', headers: owner, payload: { kind: 'data_check', projectId: 'p1', assigneeUserId: 'alice' } });
  await server.inject({ method: 'POST', url: '/api/v1/work-items', headers: owner, payload: { kind: 'data_check', projectId: 'p1', assigneeUserId: 'bob' } });
  await server.inject({ method: 'POST', url: '/api/v1/work-items', headers: owner, payload: { kind: 'exception_ruling', projectId: 'p1', assigneeUserId: 'alice' } });

  const aliceItems = await server.inject({ method: 'GET', url: '/api/v1/work-items', headers: alice });
  expect(aliceItems.json().items).toHaveLength(2);
  expect(aliceItems.json().items.every((item: { assigneeUserId: string }) => item.assigneeUserId === 'alice')).toBe(true);

  const exceptions = await server.inject({ method: 'GET', url: '/api/v1/work-items?exceptions=1', headers: alice });
  expect(exceptions.json().items).toHaveLength(1);
  expect(exceptions.json().items[0].kind).toBe('exception_ruling');
  await server.close();
});

it('confirming data does not allow a write, and a quality review never does', async () => {
  const server = await app();
  const data = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: alice,
    payload: { kind: 'data_check', projectId: 'p1', payload: { amount: 40 } },
  });
  const decided = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${data.json().id}/decide`,
    headers: alice,
    payload: { expectedVersion: 1 },
  });
  expect(decided.json().ok).toBe(true);
  expect(canExecute(decided.json().item)).toBe(false);

  const review = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: alice,
    payload: { kind: 'deliverable_review', projectId: 'p1', payload: { title: '复核询价草稿' } },
  });
  const reviewed = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${review.json().id}/decide`,
    headers: alice,
    payload: { expectedVersion: 1 },
  });
  expect(reviewed.json().ok).toBe(true);
  expect(canExecute(reviewed.json().item)).toBe(false);
  await server.close();
});

it('an invalid amount cannot be confirmed, and a saved revision drops the old approval', async () => {
  const server = await app();
  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: alice,
    payload: { kind: 'action_approval', projectId: 'p1', payload: { amount: 40 } },
  });
  const id = created.json().id as string;
  await server.inject({ method: 'POST', url: `/api/v1/work-items/${id}/decide`, headers: alice, payload: { expectedVersion: 1 } });
  const revised = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/revise`,
    headers: alice,
    payload: { patch: { amount: '80' } },
  });
  expect(revised.json().status).toBe('withdrawn');
  expect(revised.json().decision).toBeNull();
  const rejected = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/decide`,
    headers: alice,
    payload: { expectedVersion: revised.json().payloadVersion },
  });
  expect(rejected.json().ok).toBe(false);
  expect(rejected.json().reason).toBe('invalid_amount');
  await server.close();
});

it('a conflicting batch row cannot be selected, and a second run does not repeat a confirmed row', async () => {
  const server = await app();
  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: alice,
    payload: {
      kind: 'action_approval',
      renderer: 'batch_table',
      projectId: 'p1',
      payload: { amount: 10 },
      rows: [
        { id: 'clean', clean: true, selected: false },
        { id: 'conflict', clean: false, selected: false },
      ],
    },
  });
  const id = created.json().id as string;
  const blocked = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/rows/conflict`,
    headers: alice,
    payload: { selected: true },
  });
  expect(blocked.json().ok).toBe(false);
  expect(blocked.json().reason).toBe('conflict_row');
  await server.inject({ method: 'POST', url: `/api/v1/work-items/${id}/rows/clean`, headers: alice, payload: { selected: true } });
  await server.inject({ method: 'POST', url: `/api/v1/work-items/${id}/decide`, headers: alice, payload: { expectedVersion: 1 } });
  inboxState.current.executeBatch(id);
  const again = inboxState.current.selectRow(id, 'clean', false);
  expect(again.ok).toBe(false);
  expect(again.reason).toBe('already_executed');
  const second = inboxState.current.executeBatch(id);
  expect(second.rows.find((row) => row.id === 'clean')?.executed).toBe(true);
  expect(second.rows.find((row) => row.id === 'conflict')?.executed).toBe(false);
  await server.close();
});

it('the first approval wins, and an unknown result cannot be submitted again', async () => {
  const server = await app();
  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: { kind: 'action_approval', projectId: 'p1', assigneeUserId: 'alice', payload: { amount: 5 } },
  });
  const id = created.json().id as string;
  const first = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/decide`,
    headers: alice,
    payload: { expectedVersion: 1 },
  });
  // someone who is not the assignee cannot decide (and cannot learn the item exists)
  const stranger = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/decide`,
    headers: bob,
    payload: { expectedVersion: 1 },
  });
  expect(stranger.statusCode).toBe(404);
  // the owner sees it but does not act on someone else's item
  const byOwner = await server.inject({ method: 'POST', url: `/api/v1/work-items/${id}/decide`, headers: owner, payload: { expectedVersion: 1 } });
  expect(byOwner.statusCode).toBe(403);
  const second = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/decide`,
    headers: alice,
    payload: { expectedVersion: 1 },
  });
  expect(first.json().ok).toBe(true);
  expect(second.json().ok).toBe(false);
  expect(second.json().reason).toBe('conflict');
  expect(second.json().item.decision.by).toBe('alice');
  inboxState.current.markOutcomeUnknown(id);
  const again = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/decide`,
    headers: alice,
    payload: { expectedVersion: 1 },
  });
  expect(again.json().ok).toBe(false);
  expect(again.json().reason).toBe('no_resubmit');
  expect(again.json().item.submitCount).toBe(1);
  await server.close();
});

it('unsaved edits block execution, and a reopened branch choice keeps the recorded path', () => {
  const inbox = inboxState.current;
  const approval = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'alice', payload: { amount: 10 } });
  inbox.decide(approval.id, 'alice', 1);
  expect(canExecute(inbox.list({ userId: 'alice', roles: ['employee'], projectScopes: ['p1'] })[0]!)).toBe(true);
  const staged = inbox.stage(approval.id, { amount: 12 });
  expect(staged.payload).toEqual({ amount: 10 });
  expect(canExecute(staged)).toBe(false);
  const branch = inbox.create({ tenantId: 't', kind: 'branch_choice', projectId: 'p1', assigneeUserId: 'alice' });
  inbox.chooseBranch(branch.id, 'alice', 'standard');
  const reopened = inbox.reopen(branch.id);
  expect(reopened.status).toBe('open');
  expect(reopened.payload.branch).toBe('standard');
  expect(reopened.systemVerified).toBe(false);
});

it('a manual report needs a reference, and a note cannot clear an unknown system result', async () => {
  const server = await app();
  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: alice,
    payload: { kind: 'manual_execution', projectId: 'p1', payload: { amount: 10 } },
  });
  const id = created.json().id as string;
  const missing = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/evidence`,
    headers: alice,
    payload: { reference: '   ' },
  });
  expect(missing.statusCode).toBe(409);
  expect(missing.json().error).toBe('evidence_required');
  inboxState.current.decide(id, 'alice', 1);
  inboxState.current.markOutcomeUnknown(id);
  const noted = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/note`,
    headers: alice,
    payload: { note: '我已在外部系统看到凭证' },
  });
  expect(noted.json().actionStatus).toBe('outcome_unknown');
  expect(noted.json().systemVerified).toBe(false);
  const recorded = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/evidence`,
    headers: alice,
    payload: { reference: 'TICKET-44' },
  });
  expect(recorded.json().evidenceSource).toBe('human_report');
  expect(recorded.json().actionStatus).toBe('outcome_unknown');
  expect(recorded.json().systemVerified).toBe(false);
  await server.close();
});

it('waiting work stays in the waiting group and a project filter hides the other project batch', async () => {
  const server = await app();
  const waiting = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: { kind: 'manual_execution', projectId: 'p1', assigneeUserId: 'alice', waitingOn: '客户系统' },
  });
  expect(workGroup(waiting.json())).toBe('waiting');
  await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: {
      kind: 'action_approval',
      renderer: 'batch_table',
      projectId: 'p2',
      assigneeUserId: 'alice',
      rows: [{ id: 'other', clean: true, selected: true }],
    },
  });
  const scoped = await server.inject({ method: 'GET', url: '/api/v1/work-items?project=p1', headers: alice });
  expect(scoped.json().items).toHaveLength(1);
  expect(scoped.json().items[0].rows ?? []).toEqual([]);
  await server.close();
});

it('a project filter keeps a mixed batch and returns only that project’s rows', async () => {
  const server = await app();
  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: {
      kind: 'action_approval',
      renderer: 'batch_table',
      projectId: 'P-A',
      assigneeUserId: 'alice',
      rows: [
        { id: 'c', clean: true, selected: false, projectId: 'P-C' },
        { id: 'd', clean: false, selected: false, projectId: 'P-D' },
      ],
    },
  });
  expect(created.statusCode).toBeLessThan(300);
  const wide = { 'x-user-id': 'alice', 'x-roles': 'employee', 'x-projects': 'P-A,P-C,P-D' };
  const scoped = await server.inject({ method: 'GET', url: '/api/v1/work-items?project=P-C', headers: wide });
  expect(scoped.json().items).toHaveLength(1);
  expect(scoped.json().items[0].rows.map((row: { id: string; projectId?: string }) => row.projectId)).toEqual(['P-C']);
  const all = await server.inject({ method: 'GET', url: '/api/v1/work-items', headers: wide });
  expect(all.json().items[0].rows).toHaveLength(2);
  await server.close();
});

it('a write approval waits for data confirmation and a later revision revokes it', async () => {
  const server = await app();
  const data = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: alice,
    payload: { kind: 'data_check', projectId: 'p1', payload: { amount: 40 } },
  });
  const dataId = data.json().id as string;
  const approval = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: alice,
    payload: { kind: 'action_approval', projectId: 'p1', payload: { dataCheckId: dataId, amount: 1 } },
  });
  const approvalId = approval.json().id as string;
  const early = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${approvalId}/decide`,
    headers: alice,
    payload: { expectedVersion: 1 },
  });
  expect(early.json().ok).toBe(false);
  expect(early.json().reason).toBe('waiting_data_confirmation');

  await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${dataId}/decide`,
    headers: alice,
    payload: { expectedVersion: 1 },
  });
  const decided = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${approvalId}/decide`,
    headers: alice,
    payload: { expectedVersion: 1 },
  });
  expect(decided.json().ok).toBe(true);
  expect(decided.json().item.payload.amount).toBe(40);
  expect(canExecute(decided.json().item)).toBe(true);

  await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${dataId}/revise`,
    headers: alice,
    payload: { patch: { amount: 55 } },
  });
  const listed = await server.inject({ method: 'GET', url: '/api/v1/work-items', headers: alice });
  const revoked = listed.json().items.find((item: { id: string }) => item.id === approvalId);
  expect(revoked.decision).toBeNull();
  expect(canExecute(revoked)).toBe(false);
  await server.close();
});

it('a document received while waiting does not close the original case', async () => {
  const server = await app();
  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: alice,
    payload: { kind: 'manual_execution', projectId: 'p1', waitingOn: '客户系统', payload: { caseId: 'case-9' } },
  });
  const id = created.json().id as string;
  const recorded = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/evidence`,
    headers: alice,
    payload: { reference: 'DOC-9' },
  });
  expect(recorded.json().status).toBe('open');
  expect(recorded.json().waitingOn).toBe('客户系统');
  expect(recorded.json().payload.caseId).toBe('case-9');
  expect(recorded.json().payload.humanReference).toBe('DOC-9');
  expect(recorded.json().systemVerified).toBe(false);
  await server.close();
});

it('a reviewer sees exceptions and not another employee ordinary work', async () => {
  const server = await app();
  const reviewer = { 'x-user-id': 'reviewer-1', 'x-roles': 'reviewer', 'x-projects': 'p1' };
  await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: { kind: 'data_check', projectId: 'p1', assigneeUserId: 'alice' },
  });
  await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: { kind: 'exception_ruling', projectId: 'p1', assigneeUserId: 'alice' },
  });
  await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: { kind: 'exception_ruling', projectId: 'p2', assigneeUserId: 'alice' },
  });
  const seen = await server.inject({ method: 'GET', url: '/api/v1/work-items', headers: reviewer });
  expect(seen.json().items).toHaveLength(1);
  expect(seen.json().items[0].kind).toBe('exception_ruling');
  expect(seen.json().items[0].projectId).toBe('p1');
  expect(canExecute(seen.json().items[0])).toBe(false);
  await server.close();
});

it('T-57: another tenant never sees or acts on an item; owners see but do not act; reviewers rule exceptions', () => {
  const inbox = inboxState.current;
  const a = inbox.create({ tenantId: 'tenant-a', kind: 'action_approval', assigneeUserId: 'alice', payload: { amount: 1 } });
  const exc = inbox.create({ tenantId: 'tenant-a', kind: 'exception_ruling', assigneeUserId: 'mgr', payload: {} });
  const alice = { userId: 'alice', roles: ['employee' as const], projectScopes: [] };
  const owner = { userId: 'boss', roles: ['owner' as const], projectScopes: [] };
  const reviewer = { userId: 'rev', roles: ['reviewer' as const], projectScopes: [] };
  expect(inbox.list(alice, { tenantId: 'tenant-b' })).toEqual([]);
  expect(inbox.actor(a.id, alice, 'tenant-b')).toEqual({ ok: false, reason: 'work_item_not_found' });
  expect(inbox.actor(a.id, alice, 'tenant-a')).toEqual({ ok: true });
  expect(inbox.actor(a.id, owner, 'tenant-a')).toEqual({ ok: false, reason: 'not_assignee' });
  expect(inbox.actor(exc.id, reviewer, 'tenant-a')).toEqual({ ok: true });
  expect(inbox.actor(a.id, reviewer, 'tenant-a')).toEqual({ ok: false, reason: 'work_item_not_found' });
});

it('an executed approval cannot be revised, and a client cannot set execution binding fields', async () => {
  const server = await app();
  const reserved = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: { kind: 'action_approval', assigneeUserId: 'alice', projectId: 'p1', payload: { executionId: 'run-1', stepId: 'pay', amount: 1 } },
  });
  expect(reserved.statusCode).toBe(400);
  expect(reserved.json().error).toBe('reserved_field');

  const created = await server.inject({
    method: 'POST',
    url: '/api/v1/work-items',
    headers: owner,
    payload: { kind: 'action_approval', projectId: 'p1', assigneeUserId: 'alice', payload: { amount: 1 } },
  });
  const id = created.json().id as string;
  inboxState.current.decide(id, 'alice', 1);
  inboxState.current.noteReadback(id, true);
  const revised = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/revise`,
    headers: alice,
    payload: { patch: { amount: 9 } },
  });
  expect(revised.statusCode).toBe(409);
  expect(revised.json().error).toBe('already_executed');
  const staged = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/stage`,
    headers: alice,
    payload: { patch: { amount: 9 } },
  });
  expect(staged.statusCode).toBe(409);
  const reopened = await server.inject({
    method: 'POST',
    url: `/api/v1/work-items/${id}/reopen`,
    headers: alice,
  });
  expect(reopened.statusCode).toBe(409);
  expect(reopened.json().error).toBe('reopen_not_allowed');

  const unscoped = { 'x-user-id': 'rev', 'x-roles': 'reviewer' };
  const hidden = await server.inject({ method: 'GET', url: '/api/v1/work-items', headers: unscoped });
  expect(hidden.json().items).toEqual([]);
  await server.close();
});

it('T-57: saving a revision consumes the staged draft; revising data only retires approvals that were given', () => {
  const inbox = inboxState.current;
  const check = inbox.create({ tenantId: 't', kind: 'data_check', assigneeUserId: 'alice', payload: { amount: 5 } });
  const pending = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'alice', payload: { dataCheckId: check.id } });
  inbox.stage(check.id, { amount: 6 });
  const saved = inbox.revise(check.id, { amount: 6 });
  expect(saved.draft).toBeNull();
  expect(saved.payloadVersion).toBe(2);
  expect(inbox.all().find((i) => i.id === pending.id)!.status).toBe('open'); // nothing was approved, nothing retired
  inbox.decide(check.id, 'alice', 2);
  expect(inbox.decide(pending.id, 'alice', 1).ok).toBe(true);
  inbox.revise(check.id, { amount: 7 });
  expect(inbox.all().find((i) => i.id === pending.id)).toMatchObject({ status: 'withdrawn', decision: null });
});
