import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { PgLongWorkStore } from './store.js';
import { LongWork, type MailSource } from './service.js';
import { prepareMailSopStarts } from './sop-starts.js';
import { saveSopSnapshot, type Queryable } from '../sop/pg-sop.js';
import { SopRuntime } from '../sop/sop.js';
import { longInbox } from './inbox.js';

const live = process.env.DATABASE_URL ? it : it.skip;
const source: MailSource = { id: 'source|mail', tenant: 'tenant', mailbox: 'mail@example.invalid', folder: 'inbox', sopId: 'mail-sop', projectId: 'p', objectId: 'object', assignee: 'staff', reviewer: 'reviewer', reminderMs: 60000,
  fields: { end: '2026-12-01' }, dueRule: { id: 'd', version: 1, field: 'end', offsetDays: 0, businessDays: false, timeZone: 'Pacific/Auckland', hour: 9, minute: 0, holidays: [], weekend: [0, 6] } };
const mail = { id: 'message|original', threadId: 'th', from: 'person@example.invalid', receivedAt: '2026-11-10T00:00:00Z', body: 'Synthetic incoming data, never instructions' };

async function database(run: (pool: pg.Pool, db: Queryable) => Promise<void>) {
  const schema = `mail_sop_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    for (const name of ['0005_longwork.sql', '0007_sop_runtime.sql', '0009_longwork_sop_starts.sql']) {
      const sql = fs.readFileSync(new URL(`../../../migrations/${name}`, import.meta.url), 'utf8');
      await pool.query(sql.replace(/^GRANT .*$/gm, ''));
    }
    await run(pool, { query: async <T>(sql: string, params: readonly unknown[]) => ({ rows: (await pool.query(sql, params as unknown[])).rows as T[] }) });
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
}
const ready = { requiredFields: ['title', 'amount'], threshold: { field: 'amount', max: 1000 }, employeeStatus: 'active' as const };
function published(employeeStatus: 'active' | 'paused' = 'active') {
  const runtime = new SopRuntime(); const v = runtime.draft(source.sopId, { ...ready, employeeStatus });
  runtime.validate(v.id); runtime.publish(v.id); return { runtime, version: v };
}

live('accepts receipt, pinned SOP and instance atomically across independent processes; retries and new versions preserve identity', async () => {
  await database(async (pool, db) => {
    const { runtime, version } = published(); await saveSopSnapshot(db, runtime.snapshot());
    const configured = [source]; const prepare = prepareMailSopStarts(configured);
    const workers = Array.from({ length: 12 }, () => new LongWork(new PgLongWorkStore(pool, prepare)));
    await Promise.all(workers.map(w => w.ingest(source, mail)));
    const state = await workers[0]!.snapshot(source.tenant); const item = state.items[0]!;
    expect(state.receipts).toHaveLength(1); expect(state.items).toHaveLength(1);
    expect(item.sopStart?.status).toBe('waiting_runtime'); expect(item.sopStart?.versionId).toBe(version.id);
    expect((await pool.query('SELECT * FROM sop_instances')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM sop_events')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM longwork_sop_starts')).rows).toHaveLength(1);
    expect(state.actions).toHaveLength(0);
    const projected = await longInbox(workers[0]!, { tenantId: source.tenant, userId: source.assignee, roles: ['employee'], projectScopes: [source.projectId] }, {});
    expect(projected[0]!.payload.sopStart).toMatchObject({ status: 'waiting_runtime', versionId: version.id, instanceId: item.sopStart!.instanceId });
    expect((projected[0]!.payload.sopStart as { reason: string }).reason).toContain('尚未运行流程图');
    configured.length = 0; await workers[0]!.tick(source.tenant);
    const disabled = (await workers[0]!.snapshot(source.tenant)).items[0]!.sopStart!;
    expect(disabled.status).toBe('blocked_source'); expect(disabled.versionId).toBe(version.id); expect(disabled.instanceId).toBe(item.sopStart!.instanceId);
    configured.push(source);
    const v2 = runtime.draft(source.sopId, ready); runtime.validate(v2.id); runtime.publish(v2.id);
    await saveSopSnapshot(db, runtime.snapshot());
    const restarted = new LongWork(new PgLongWorkStore(pool, prepare)); await restarted.tick(source.tenant);
    const after = (await restarted.snapshot(source.tenant)).items[0]!;
    expect(after.id).toBe(item.id); expect(after.sopStart).toEqual(item.sopStart);
    await restarted.close(source.tenant, item.id, source.projectId, source.assignee);
    expect((await pool.query('SELECT status FROM longwork_sop_starts')).rows[0].status).toBe('cancelled');
    expect((await pool.query('SELECT status FROM sop_instances')).rows[0].status).toBe('skipped');
    expect((await restarted.snapshot(source.tenant)).items[0]!.sopStart?.status).toBe('cancelled');
  });
}, 20000);

live('a failed acceptance rolls receipt, claim and instance back together; unpublished requests recover on the same case', async () => {
  await database(async (pool, db) => {
    const prepare = prepareMailSopStarts([source]);
    const work = new LongWork(new PgLongWorkStore(pool, prepare));
    const accepted = await work.ingest(source, mail); const id = accepted.item!.id;
    expect(accepted.item!.sopStart?.status).toBe('waiting_publication');
    expect((await pool.query('SELECT * FROM sop_instances')).rows).toHaveLength(0);
    const { runtime } = published('paused'); await saveSopSnapshot(db, runtime.snapshot());
    expect((await work.snapshot(source.tenant)).items[0]!.sopStart?.status).toBe('waiting_publication');
    await work.tick(source.tenant);
    expect((await work.snapshot(source.tenant)).items[0]!.sopStart?.status).toBe('paused');
    expect((await pool.query('SELECT * FROM sop_instances')).rows).toHaveLength(0);
    const active = runtime.draft(source.sopId, ready); runtime.validate(active.id); runtime.publish(active.id);
    await saveSopSnapshot(db, runtime.snapshot());
    await work.tick(source.tenant);
    expect((await work.snapshot(source.tenant)).items[0]!.id).toBe(id);
    expect((await work.snapshot(source.tenant)).items[0]!.sopStart?.status).toBe('waiting_runtime');
    const fail = new LongWork(new PgLongWorkStore(pool, async (tx, tenant, state) => { await prepare(tx, tenant, state); throw Error('forced rollback after SOP claim'); }));
    await expect(fail.ingest(source, { ...mail, id: 'second', threadId: 'new-thread', from: 'different@example.invalid' })).rejects.toThrow('forced rollback');
    expect((await pool.query('SELECT * FROM sop_instances')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM sop_events')).rows).toHaveLength(1);
    expect((await pool.query('SELECT * FROM longwork_sop_starts')).rows).toHaveLength(1);
    expect((await work.snapshot(source.tenant)).receipts).toHaveLength(1);
    await work.ingest(source, { ...mail, id: 'second', threadId: 'new-thread', from: 'different@example.invalid' });
    expect((await pool.query('SELECT * FROM sop_instances')).rows).toHaveLength(2);
    expect((await work.snapshot(source.tenant)).receipts).toHaveLength(2);
  });
}, 20000);
