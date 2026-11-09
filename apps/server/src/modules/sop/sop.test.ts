import assert from 'node:assert/strict';
import { it } from 'vitest';
import { SopRuntime, staleSourceNodes, type SopDefinition } from './sop.js';
import { formatInTimeZone, localStamp, zonedTimeToUtc } from './zoned-time.js';

const ready: SopDefinition = {
  requiredFields: ['title', 'amount'],
  threshold: { field: 'amount', max: 1000 },
  employeeStatus: 'active',
};

it('an SOP cannot publish until every gate passes, and an edit invalidates that pass', () => {
  const runtime = new SopRuntime();
  const incomplete = runtime.draft('sop-1', { requiredFields: ['title'], employeeStatus: 'active' });
  assert.equal(runtime.validate(incomplete.id).status, 'failed');
  assert.throws(() => runtime.publish(incomplete.id), /validation_stale/);
  const revised = runtime.revise(incomplete.id, ready);
  assert.equal(revised.status, 'draft');
  assert.equal(revised.revision, 2);
  assert.throws(() => runtime.publish(incomplete.id), /validation_stale/);
  assert.equal(runtime.validate(incomplete.id).status, 'passed');
  const published = runtime.publish(incomplete.id);
  assert.equal(published.status, 'published');
  const next = runtime.revise(published.id, { ...ready, threshold: { field: 'amount', max: 50 } });
  assert.notEqual(next.id, published.id);
  assert.equal(next.status, 'draft');
  assert.equal(next.revision, 1);
  assert.throws(() => runtime.publish(next.id), /validation_stale/);
  assert.equal(runtime.publish(published.id).status, 'published');
});

it('a changed or deleted source lists the nodes that cited it', () => {
  const nodes = [
    { id: 'n1', evidence: { sourceId: 'policy', version: 'v1', locator: '采购制度.md#L3' } },
    { id: 'n2', evidence: { sourceId: 'policy', version: 'v2', locator: '采购制度.md#L7' } },
    { id: 'n3', evidence: { sourceId: 'gone', version: 'v1', locator: '旧邮件#1' } },
    { id: 'n4' },
  ];
  assert.deepEqual(staleSourceNodes(nodes, { policy: { version: 'v2' }, gone: null }), [
    { nodeId: 'n1', sourceId: 'policy', locator: '采购制度.md#L3', from: 'v1', to: 'v2' },
    { nodeId: 'n3', sourceId: 'gone', locator: '旧邮件#1', from: 'v1', to: null },
  ]);
});

it('a disabled trigger and a paused employee do not create an instance', () => {
  const runtime = new SopRuntime();
  const version = runtime.draft('sop-2', ready);
  assert.equal(runtime.validate(version.id).status, 'passed');
  runtime.publish(version.id);
  assert.equal(runtime.manualStart('t', version.id, 'm1', false), null);
  assert.equal(runtime.instancesOf('sop-2').length, 0);
  const paused = runtime.draft('sop-3', { ...ready, employeeStatus: 'paused' });
  assert.equal(runtime.validate(paused.id).status, 'passed');
  runtime.publish(paused.id);
  assert.equal(runtime.manualStart('t', paused.id, 'm2', true), null);
});

it('the same event opens one instance, and a new version does not rewrite the old one', () => {
  const runtime = new SopRuntime();
  const drafted = runtime.draft('sop-4', ready);
  assert.equal(runtime.validate(drafted.id).status, 'passed');
  const v1 = runtime.publish(drafted.id);
  const first = runtime.manualStart('t', v1.id, 'mail-9', true);
  const second = runtime.manualStart('t', v1.id, 'mail-9', true);
  assert.equal(second, null);
  const revised = runtime.revise(v1.id, { ...ready, threshold: { field: 'amount', max: 20 } });
  assert.equal(runtime.validate(revised.id).status, 'passed');
  const v2 = runtime.publish(revised.id);
  assert.equal(first?.versionNumber, 1);
  assert.equal(first?.sopVersionId, v1.id);
  assert.notEqual(v2.id, v1.id);
  assert.equal(runtime.manualStart('t', v2.id, 'mail-9', true), null);
});

it('a date trigger fires once across a daylight-saving fold and records misses outside the window', () => {
  const zone = 'Pacific/Auckland';
  const fold = { year: 2026, month: 4, day: 5, hour: 2, minute: 30 };
  const resolved = zonedTimeToUtc(fold, zone);
  const wall = formatInTimeZone(resolved.utcMs, zone);
  assert.equal(localStamp(wall), '2026-04-05T02:30');

  const gap = zonedTimeToUtc({ year: 2026, month: 9, day: 27, hour: 2, minute: 30 }, zone);
  assert.equal(gap.exists, false);
  assert.equal(localStamp(formatInTimeZone(gap.utcMs, zone)), '2026-09-27T03:00');

  const runtime = new SopRuntime();
  const drafted = runtime.draft('sop-5', ready);
  assert.equal(runtime.validate(drafted.id).status, 'passed');
  const version = runtime.publish(drafted.id);
  const trigger = {
    id: 'trg',
    tenantId: 't',
    sopId: version.sopId,
    enabled: true,
    timezone: zone,
    hour: 2,
    minute: 30,
    ruleVersion: 1,
    catchupWindowMs: 2 * 60 * 60 * 1000,
    overlap: 'skip' as const,
  };
  const nominal = zonedTimeToUtc({ year: 2026, month: 4, day: 5, hour: 2, minute: 30 }, zone).utcMs;
  assert.equal(runtime.evaluateDate(trigger, { year: 2026, month: 4, day: 5 }, nominal + 60_000), 'ran');
  assert.equal(runtime.evaluateDate(trigger, { year: 2026, month: 4, day: 5 }, nominal + 120_000), 'duplicate');
  assert.equal(runtime.instancesOf('sop-5').length, 1);

  const stale = zonedTimeToUtc({ year: 2026, month: 4, day: 4, hour: 2, minute: 30 }, zone).utcMs;
  assert.equal(runtime.evaluateDate(trigger, { year: 2026, month: 4, day: 4 }, stale + 3 * 60 * 60 * 1000), 'missed');
  assert.equal(runtime.instancesOf('sop-5').length, 1);
  assert.equal(runtime.evaluateDate({ ...trigger, enabled: false }, { year: 2026, month: 4, day: 6 }, nominal), 'disabled');
});
