import assert from 'node:assert/strict';
import { it } from 'vitest';
import { ToolGateway, payloadHash } from '../gateway/gateway.js';
import type { Viewer } from '../room/room.js';
import { WorkInbox } from './work-items.js';

const owner: Viewer = { userId: 'owner', roles: ['owner'], projectScopes: [] };
const alice: Viewer = { userId: 'alice', roles: ['employee'], projectScopes: ['p1'] };
const bob: Viewer = { userId: 'bob', roles: ['employee'], projectScopes: ['p1'] };

it('changing the amount withdraws the approval that was just recorded', () => {
  const inbox = new WorkInbox();
  const item = inbox.create({
    tenantId: 't',
    kind: 'action_approval',
    assigneeUserId: 'alice',
    payload: { amount: 40 },
  });
  assert.equal(inbox.decide(item.id, 'alice', 1).ok, true);
  const revised = inbox.revise(item.id, { amount: 80 });
  assert.equal(revised.status, 'withdrawn');
  assert.equal(revised.decision, null);
  assert.equal(revised.payloadVersion, 2);
  assert.notEqual(revised.payloadHash, payloadHash({ amount: 40 }));
});

it('an unknown outcome cannot be submitted again', () => {
  const inbox = new WorkInbox();
  const item = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'alice', payload: { amount: 10 } });
  inbox.decide(item.id, 'alice', 1);
  inbox.markOutcomeUnknown(item.id);
  const again = inbox.decide(item.id, 'alice', 1);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'no_resubmit');
  assert.equal(again.item.submitCount, 1);
});

it('a batch executes only the selected clean rows', () => {
  const inbox = new WorkInbox();
  const item = inbox.create({
    tenantId: 't',
    kind: 'action_approval',
    renderer: 'batch_table',
    assigneeUserId: 'alice',
    rows: [
      { id: 'clean-yes', clean: true, selected: true },
      { id: 'clean-no', clean: true, selected: false },
      { id: 'bad', clean: false, selected: true },
    ],
  });
  assert.equal(inbox.decide(item.id, 'alice', 1).ok, true);
  const done = inbox.executeBatch(item.id);
  const byId = Object.fromEntries(done.rows.map((row) => [row.id, row.executed]));
  assert.deepEqual(byId, { 'clean-yes': true, 'clean-no': false, bad: false });
});

it('a human reference is never presented as system-verified', () => {
  const inbox = new WorkInbox();
  const item = inbox.create({ tenantId: 't', kind: 'manual_execution', assigneeUserId: 'alice' });
  const recorded = inbox.recordHumanEvidence(item.id, 'TICKET-44');
  assert.equal(recorded.evidenceSource, 'human_report');
  assert.equal(recorded.systemVerified, false);
  assert.equal(JSON.stringify(recorded).includes('"systemVerified":true'), false);
});

it('employees only receive their own items from the server filter', () => {
  const inbox = new WorkInbox();
  inbox.create({ id: 'a', tenantId: 't', projectId: 'p1', kind: 'data_check', assigneeUserId: 'alice' });
  inbox.create({ id: 'b', tenantId: 't', projectId: 'p1', kind: 'data_check', assigneeUserId: 'bob' });
  assert.deepEqual(inbox.list(alice).map((item) => item.id), ['a']);
  assert.deepEqual(inbox.list(bob).map((item) => item.id), ['b']);
  assert.equal(inbox.list(owner).length, 2);
});

it('the first decision wins when two people approve the same item', () => {
  const inbox = new WorkInbox();
  const item = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'alice', payload: { amount: 5 } });
  const first = inbox.decide(item.id, 'alice', item.payloadVersion);
  const second = inbox.decide(item.id, 'bob', item.payloadVersion);
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'conflict');
  assert.equal(second.item.decision?.by, 'alice');
});

it('permission revoked after approval does not submit the action', () => {
  const inbox = new WorkInbox();
  const gateway = new ToolGateway();
  const payload = { amount: 5 };
  const item = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'alice', payload });
  inbox.decide(item.id, 'alice', 1);
  const result = gateway.execute({
    tenantId: 't',
    instanceId: 'inst',
    stepId: 'pay',
    businessKey: item.id,
    effect: 'write',
    payload,
    intended: payload,
    approvalHash: payloadHash(payload),
    authorize: () => false,
    call: () => {
      throw new Error('should not run');
    },
  });
  const reopened = inbox.noteUnauthorized(item.id);
  assert.equal(result.submitted, false);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.actionStatus, 'not_submitted');
});

it('a recorded branch is not a system approval, and an exception decision keeps the evidence', () => {
  const inbox = new WorkInbox();
  const branch = inbox.create({ tenantId: 't', kind: 'branch_choice', assigneeUserId: 'alice', payload: {} });
  const chosen = inbox.chooseBranch(branch.id, 'alice', '路径乙');
  assert.equal(chosen.systemVerified, false);
  assert.equal(chosen.payload.branch, '路径乙');
  assert.equal(inbox.reopen(branch.id).payload.branch, '路径乙');

  const exception = inbox.create({ tenantId: 't', kind: 'exception_ruling', assigneeUserId: 'alice', payload: {} });
  inbox.recordHumanEvidence(exception.id, 'TICKET-7');
  const ruled = inbox.decide(exception.id, 'alice', 1);
  assert.equal(ruled.ok, true);
  assert.equal(ruled.item.systemVerified, false);
  assert.equal(ruled.item.evidenceSource, 'human_report');
  assert.equal(ruled.item.payload.humanReference, 'TICKET-7');
});

it('a retired approval no longer stands, keeps its evidence, and an executed approval cannot be decided again', () => {
  const inbox = new WorkInbox();
  const item = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'owner', payload: { title: '批准写入', amount: 10 } });
  inbox.decide(item.id, 'owner', 1);
  const retired = inbox.retireDecision(item.id);
  assert.equal(retired.decision, null);
  assert.equal(retired.status, 'closed');
  assert.equal(retired.payloadVersion, item.payloadVersion + 1); // a late save of the older approved copy loses the version guard
  assert.equal(retired.payloadHash, item.payloadHash);
  assert.equal(inbox.decide(item.id, 'owner', 1).reason, 'retired'); // never decided again, even before any read-back
  const executed = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'owner', payload: { title: '批准写入', amount: 20 } });
  inbox.decide(executed.id, 'owner', 1);
  inbox.noteReadback(executed.id, true);
  const after = inbox.retireDecision(executed.id);
  assert.equal(after.actionStatus, 'confirmed');
  assert.equal(after.submitCount, 1);
  assert.equal(after.payloadHash, executed.payloadHash);
  assert.equal(inbox.decide(executed.id, 'owner', 1).ok, false);
  // an executed approval that was never retired cannot be decided again either
  const kept = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'owner', payload: { title: '批准写入', amount: 30 } });
  inbox.decide(kept.id, 'owner', 1);
  inbox.noteReadback(kept.id, true);
  assert.equal(inbox.decide(kept.id, 'owner', 1).ok, false);
});
