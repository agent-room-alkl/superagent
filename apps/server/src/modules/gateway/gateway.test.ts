import assert from 'node:assert/strict';
import test from 'node:test';
import { OutcomeUnknownError, ToolGateway, payloadHash } from './gateway.ts';

const base = {
  tenantId: 't',
  instanceId: 'inst',
  stepId: 'write-amount',
  businessKey: 'invoice-9',
  effect: 'write' as const,
  payload: { amount: 40, currency: 'NZD' },
  intended: { amount: 40 },
};

test('a write is stored before the external call and a second attempt does not call again', () => {
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

test('timeout leaves the write unknown and does not retry it', () => {
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

test('revoked permission and a changed payload do not submit', () => {
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

test('read-back mismatch is not confirmed', () => {
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
