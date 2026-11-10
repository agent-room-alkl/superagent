import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { WorkInbox } from '../humanwork/work-items.js';
import { loadInbox, saveInbox } from '../humanwork/pg-inbox.js';
import { SopExecutor } from './executor.js';
import { loadRuns, saveRuns } from './pg-runs.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;

function bound(pool: pg.Pool, schema: string) {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}"`);
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as T[] };
      } finally {
        client.release();
      }
    },
  };
}

live('a second process loads the saved approval and its run', async () => {
  const schema = `t41run_${randomUUID().replace(/-/g, '')}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const admin = await pool.connect();
  try {
    const sql = fs.readFileSync(new URL('../../../migrations/0010_inbox_and_runs.sql', import.meta.url), 'utf8');
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    await admin.query(sql.replace(/^GRANT .*$/gm, ''));
    const db = bound(pool, schema);
    const inbox = new WorkInbox();
    const item = inbox.create({ tenantId: 't', kind: 'action_approval', assigneeUserId: 'owner-1', payload: { executionId: 'ex_1', stepId: 'w' } });
    const executor = new SopExecutor({
      sop: () => { throw new Error('not used'); },
      inbox: () => inbox,
      gateway: { reserve: () => { throw new Error('not used'); }, finish: () => { throw new Error('not used'); }, abort: () => undefined } as never,
      tools: () => null,
      connectors: new Map(),
      reviewerOf: () => 'owner-1',
      authorize: () => null,
    });
    executor.load({
      seq: 1,
      runs: [{
        id: 'ex_1', tenantId: 't', sopId: 's', versionId: 'v', versionNumber: 1, instanceId: 'i', eventId: 'e',
        startedBy: 'owner-1', input: {}, status: 'waiting_human', exceptionItemId: null,
        steps: [{ nodeId: 'h', kind: 'human_review', label: '审核', status: 'waiting_human', detail: null, workItemId: item.id, actionId: null, readback: null }],
      }],
    });
    await saveInbox(db, inbox.snapshot());
    await saveRuns(db, executor.snapshot());

    const restoredInbox = new WorkInbox();
    restoredInbox.load((await loadInbox(db))!);
    const restored = new SopExecutor({
      sop: () => { throw new Error('not used'); },
      inbox: () => restoredInbox,
      gateway: { reserve: () => { throw new Error('not used'); }, finish: () => { throw new Error('not used'); }, abort: () => undefined } as never,
      tools: () => null,
      connectors: new Map(),
      reviewerOf: () => 'owner-1',
      authorize: () => null,
    });
    restored.load((await loadRuns(db))!);
    expect(restoredInbox.all().map((row) => row.id)).toEqual([item.id]);
    expect(restored.get('t', 'ex_1').status).toBe('waiting_human');
    expect(restored.get('t', 'ex_1').steps[0]?.workItemId).toBe(item.id);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    admin.release();
    await pool.end();
  }
});
