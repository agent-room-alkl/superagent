import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { WorkInbox } from '../humanwork/work-items.js';
import { insertWorkItem, loadWorkItemsForRun, updateWorkItem } from '../humanwork/pg-inbox.js';

const live = process.env.DATABASE_URL ? it : it.skip;
live('retiring a contract prevents an older process from restoring its previous approval', async () => {
  const schema = `retire_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(fs.readFileSync(new URL('../../../migrations/0012_work_item.sql', import.meta.url), 'utf8').replace(/^GRANT .*$/gm, ''));
    const db = { query: async <T>(sql: string, params: readonly unknown[]) => ({ rows: (await pool.query(sql, params as unknown[])).rows as T[] }) };
    const original = new WorkInbox();
    const item = original.create({ tenantId: 'tenant', assigneeUserId: 'reviewer', kind: 'action_approval', payload: { executionId: 'run_fixture', amount: 10 } });
    expect(original.decide(item.id, 'reviewer', item.payloadVersion).ok).toBe(true);
    original.noteReadback(item.id, true);
    const previouslyApproved = original.get(item.id); await insertWorkItem(db, previouslyApproved);
    const revisingProcess = new WorkInbox(); revisingProcess.load({ items: [previouslyApproved], seq: 0 });
    const retired = revisingProcess.retireDecision(item.id); expect(await updateWorkItem(db, retired)).toBe(true);
    // A late save from the old process must not resurrect its retired decision.
    expect(await updateWorkItem(db, previouslyApproved)).toBe(false);
    const kept = (await loadWorkItemsForRun(db, 'run_fixture'))[0]!;
    expect(kept).toMatchObject({ status: 'closed', decision: null, payloadHash: previouslyApproved.payloadHash,
      submitCount: previouslyApproved.submitCount, systemVerified: true, actionStatus: 'confirmed' });
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
});
