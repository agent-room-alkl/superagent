/**
 * Runs against a real PostgreSQL when DATABASE_URL is set (CI provides one). Skipped otherwise.
 */
import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { RESERVE_SQL } from '../src/modules/setup/budget.js';

const url = process.env.DATABASE_URL;
const d = url ? describe : describe.skip;

d('migrations against PostgreSQL', () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());

  it('applies once and is idempotent', async () => {
    await migrate(pool, undefined, () => undefined);
    const again = await migrate(pool, undefined, () => undefined);
    expect(again).toEqual([]);
    const t = await pool.query("SELECT to_regclass('public.audit_log') AS a, to_regclass('public.llm_budget') AS b");
    expect(t.rows[0].a).toBe('audit_log');
    expect(t.rows[0].b).toBe('llm_budget');
  });

  it('application role cannot UPDATE or DELETE the audit log', async () => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO audit_log(tenant_id, actor, action, object_type, object_id, result) VALUES (gen_random_uuid(), 'u', 'a', 'o', '1', 'ok')");
      await c.query('SET LOCAL ROLE superagent_app');
      await c.query("INSERT INTO audit_log(tenant_id, actor, action, object_type, object_id, result) VALUES (gen_random_uuid(), 'u', 'a', 'o', '2', 'ok')");
      await expect(c.query("UPDATE audit_log SET result = 'tampered'")).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('atomic reservation never exceeds the cap under concurrent statements', async () => {
    const tenant = '00000000-0000-0000-0000-000000000001';
    await pool.query('DELETE FROM llm_budget WHERE tenant_id = $1', [tenant]);
    await pool.query("INSERT INTO llm_budget(tenant_id, month, cap_micro_usd) VALUES ($1, '2026-11', 1000000)", [tenant]);
    const results = await Promise.all(Array.from({ length: 30 }, () => pool.query(RESERVE_SQL, [tenant, '2026-11', 60000])));
    const granted = results.filter((r) => r.rowCount === 1).length;
    expect(granted).toBe(16);
    const row = (await pool.query('SELECT reserved_micro_usd, cap_micro_usd FROM llm_budget WHERE tenant_id = $1', [tenant])).rows[0];
    expect(Number(row.reserved_micro_usd)).toBeLessThanOrEqual(Number(row.cap_micro_usd));
  });
});
