import assert from 'node:assert/strict';
import { it } from 'vitest';
import { OriginalRequests, sopNodeMode } from './original-request.js';

it('an original request is created only by an explicit call, and a second call does not add one', () => {
  const requests = new OriginalRequests();
  assert.equal(requests.list().length, 0);
  const first = requests.create({ toolId: 'invoice', target: 'sales', title: '按发票准备业务结果' });
  const again = requests.create({ toolId: 'invoice', target: 'sales', title: '再点一次' });
  assert.equal(requests.list().length, 1);
  assert.equal(again.id, first.id);
  assert.equal(first.executed, false);
  assert.equal(first.status, 'needs_tool');
});

it('tool availability does not resume a request while the SOP is unconfirmed', () => {
  const requests = new OriginalRequests();
  const created = requests.create({ toolId: 'invoice', target: 'sales', title: '按发票准备业务结果' });
  const waiting = requests.resume(created.id, { sopConfirmed: false, toolUsable: true });
  assert.equal(waiting?.status, 'needs_tool');
  assert.match(waiting?.note ?? '', /流程尚未/);
  assert.equal(waiting?.executed, false);
});

it('an unimplemented node stays blocked until the owner chooses a manual fallback', () => {
  assert.equal(sopNodeMode({ usable: false, manualFallback: false }), 'blocked');
  assert.equal(sopNodeMode({ usable: false, manualFallback: true }), 'manual');
  assert.equal(sopNodeMode({ usable: true, manualFallback: false }), 'tool');
});

it('a paused request does not resume, and lifting the pause resumes the same request without executing it', () => {
  const requests = new OriginalRequests();
  const created = requests.create({ toolId: 'invoice', target: 'sales', title: '按发票准备业务结果' });
  assert.equal(requests.pause(created.id)?.status, 'paused');
  const held = requests.resume(created.id, { sopConfirmed: true, toolUsable: true });
  assert.equal(held?.status, 'paused');
  assert.equal(requests.pause(created.id)?.status, 'needs_tool');
  const ready = requests.resume(created.id, { sopConfirmed: true, toolUsable: true });
  assert.equal(ready?.id, created.id);
  assert.equal(ready?.status, 'ready');
  assert.match(ready?.note ?? '', /已恢复待执行（未调用）|没有重复创建任务或执行外部调用/);
  assert.equal(ready?.executed, false);
  assert.equal(requests.list().length, 1);
});
