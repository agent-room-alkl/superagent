import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import type { Execution } from './executor.js';
import { insertRun, loadRunByInstance, saveRuns } from './pg-runs.js';

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

function run(instanceId: string): Execution {
  return {
    id: `run_${instanceId}`, tenantId: 't', sopId: 's', versionId: 'v', versionNumber: 1, instanceId,
    eventId: 'e', startedBy: 'owner-1', input: {}, status: 'waiting_human', exceptionItemId: null,
    steps: [],
  };
}

live('a claimed run stays when another process replaces the shared snapshot', async () => {
  const schema = `t41claim_${randomUUID().replace(/-/g, '')}`;
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const admin = await pool.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    for (const file of ['0010_inbox_and_runs.sql', '0011_execution_run.sql']) {
      const sql = fs.readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8');
      await admin.query(sql.replace(/^GRANT .*$/gm, ''));
    }
    const db = bound(pool, schema);
    const claimed = run('mail_1');
    expect(await insertRun(db, claimed)).toBe(true);
    expect(await insertRun(db, { ...run('mail_1'), id: 'run_other', status: 'running' })).toBe(false);
    await saveRuns(db, { seq: 1, runs: [{ ...run('other'), id: 'ex_1', instanceId: 'other' }] });
    const kept = await loadRunByInstance(db, 't', 'mail_1');
    expect(kept?.id).toBe('run_mail_1');
    expect(kept?.status).toBe('waiting_human');
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    admin.release();
    await pool.end();
  }
});
