import assert from 'node:assert/strict';
import { it } from 'vitest';
import { OutcomeUnknownError, ToolGateway, payloadHash } from './gateway.js';

const base = {
  tenantId: 't',
  instanceId: 'inst',
  stepId: 'write-amount',
  businessKey: 'invoice-9',
  effect: 'write' as const,
  payload: { amount: 40, currency: 'NZD' },
  intended: { amount: 40 },
};

it('a write is stored before the external call and a second attempt does not call again', () => {
  const gateway = new ToolGateway();
  const hash = payloadHash(base.payload);
  let sawExecuting = false;
  let calls = 0;
  const first = gateway.execute({
    ...base,
    approvalHash: hash,
    authorize: () => true,
    call: () => {
      calls += 1;
      const stored = gateway.getByKey(`${base.tenantId}:${base.instanceId}:${base.stepId}:${base.businessKey}`);
      sawExecuting = stored?.status === 'executing' && stored.calls === 0;
      return { externalRef: 'erp-1', actual: { amount: 40 } };
    },
  });
  const second = gateway.execute({
    ...base,
    approvalHash: hash,
    authorize: () => true,
    call: () => {
      calls += 1;
      return { externalRef: 'erp-2', actual: { amount: 40 } };
    },
  });
  assert.equal(sawExecuting, true);
  assert.equal(calls, 1);
  assert.equal(first.action.status, 'confirmed');
  assert.equal(second.invoked, false);
  assert.equal(second.action.externalRef, 'erp-1');
  assert.equal(second.action.id, first.action.id);
});

it('timeout leaves the write unknown and does not retry it', () => {
  const gateway = new ToolGateway();
  const hash = payloadHash(base.payload);
  let calls = 0;
  const run = () =>
    gateway.execute({
      ...base,
      approvalHash: hash,
      authorize: () => true,
      call: () => {
        calls += 1;
        throw new OutcomeUnknownError();
      },
    });
  const first = run();
  const second = run();
  assert.equal(first.action.status, 'outcome_unknown');
  assert.equal(calls, 1);
  assert.equal(second.invoked, false);
});

it('revoked permission and a changed payload do not submit', () => {
  const gateway = new ToolGateway();
  const hash = payloadHash(base.payload);
  const denied = gateway.execute({
    ...base,
    approvalHash: hash,
    authorize: () => false,
    call: () => {
      throw new Error('should not run');
    },
  });
  assert.equal(denied.submitted, false);
  assert.equal(denied.action.reason, 'unauthorized');

  const stale = gateway.execute({
    ...base,
    businessKey: 'invoice-10',
    approvalHash: payloadHash({ amount: 1 }),
    authorize: () => true,
    call: () => {
      throw new Error('should not run');
    },
  });
  assert.equal(stale.action.reason, 'approval_mismatch');
  assert.equal(stale.action.calls, 0);
});

it('read-back mismatch is not confirmed', () => {
  const gateway = new ToolGateway();
  const hash = payloadHash(base.payload);
  const result = gateway.execute({
    ...base,
    approvalHash: hash,
    authorize: () => true,
    call: () => ({ externalRef: 'erp-3', actual: { amount: 41 } }),
  });
  assert.equal(result.action.status, 'outcome_unknown');
  assert.equal(result.action.inconsistent, true);
  assert.equal(result.action.reason, 'readback_mismatch');
});

it('an unknown write is resolved by read-back only, and the identity snapshot stays the one from the outbox', () => {
  const gateway = new ToolGateway();
  const hash = payloadHash(base.payload);
  const identity = { employeeId: 'emp-sales', userId: 'user-sales', toolInstallationId: 'inst-1' };
  let calls = 0;
  const first = gateway.execute({
    ...base,
    approvalHash: hash,
    identity,
    authorize: () => true,
    call: () => {
      calls += 1;
      throw new OutcomeUnknownError();
    },
  });
  const key = first.action.idempotencyKey;
  const ignored = gateway.execute({
    ...base,
    approvalHash: hash,
    identity: { ...identity, userId: 'someone-else' },
    authorize: () => true,
    call: () => {
      calls += 1;
      return { actual: { amount: 40 } };
    },
  });
  assert.equal(ignored.invoked, false);
  assert.equal(ignored.action.identitySnapshot?.userId, 'user-sales');
  const mismatch = gateway.readBack(key, { amount: 41 });
  assert.equal(mismatch.invoked, false);
  assert.equal(mismatch.action.status, 'outcome_unknown');
  assert.equal(mismatch.action.calls, 1);
  const matched = gateway.readBack(key, { amount: 40 });
  assert.equal(matched.invoked, false);
  assert.equal(matched.action.status, 'confirmed');
  assert.equal(matched.action.calls, 1);
  assert.equal(calls, 1);
});

it('a reloaded gateway read-back does not send the write again', () => {
  const gateway = new ToolGateway();
  const hash = payloadHash(base.payload);
  const key = `${base.tenantId}:${base.instanceId}:${base.stepId}:${base.businessKey}`;
  gateway.execute({
    ...base,
    approvalHash: hash,
    authorize: () => true,
    call: () => { throw new OutcomeUnknownError(); },
  });
  const restored = new ToolGateway();
  restored.load(gateway.snapshot());
  let calls = 0;
  const again = restored.execute({
    ...base,
    approvalHash: hash,
    authorize: () => true,
    call: () => { calls += 1; return { actual: { amount: 40 } }; },
  });
  assert.equal(again.invoked, false);
  assert.equal(again.action.status, 'outcome_unknown');
  const read = restored.readBack(key, { amount: 40 });
  assert.equal(read.invoked, false);
  assert.equal(read.action.status, 'confirmed');
  assert.equal(read.action.calls, 1);
  assert.equal(calls, 0);
});
