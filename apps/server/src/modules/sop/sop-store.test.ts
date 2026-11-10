import assert from 'node:assert/strict';
import { it } from 'vitest';
import { bindSopStore, commitSop, sopState } from './index.js';
import { SopRuntime, type SopDefinition } from './sop.js';

const ready: SopDefinition = {
  requiredFields: ['title', 'amount'],
  threshold: { field: 'amount', max: 1000 },
  employeeStatus: 'active',
};

it('a failed database write does not leave the published version in memory', async () => {
  sopState.current = new SopRuntime();
  bindSopStore({
    query: async () => {
      throw new Error('db down');
    },
  });
  try {
    await assert.rejects(
      () => commitSop(() => {
        const version = sopState.current.draft('sop-x', ready);
        assert.equal(sopState.current.validate(version.id).status, 'passed');
        return sopState.current.publish(version.id);
      }),
      /db down/,
    );
    assert.equal(sopState.current.list().length, 0);
  } finally {
    bindSopStore(null);
    sopState.current = new SopRuntime();
  }
});
