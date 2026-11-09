/**
 * PostgreSQL budget store (PRD §3.1). The check-and-increment is one UPDATE (RESERVE_SQL), so concurrent workers can
 * never push reserved + spent above the cap. Each reservation is one llm_usage row that is later settled, released or
 * left frozen for reconciliation. Prices for the gateway come from the verified-model record.
 */
import type pg from 'pg';
import { RESERVE_SQL, type BudgetStore, type Price, type ReservationMeta } from './budget.js';
import type { PriceBook } from './llm-gateway.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function tx<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export class PgBudgetStore implements BudgetStore {
  constructor(private pool: pg.Pool) {}

  /** Opens the month from llm_config.monthly_cap_micro_usd on first use; null when no cap is configured. */
  async capFor(tenantId: string, month: string): Promise<number | null> {
    await this.pool.query(
      `INSERT INTO llm_budget (tenant_id, month, cap_micro_usd)
       SELECT tenant_id, $2, monthly_cap_micro_usd FROM llm_config WHERE tenant_id = $1 AND monthly_cap_micro_usd IS NOT NULL
       ON CONFLICT (tenant_id, month) DO NOTHING`,
      [tenantId, month],
    );
    const r = await this.pool.query('SELECT cap_micro_usd FROM llm_budget WHERE tenant_id = $1 AND month = $2', [tenantId, month]);
    return r.rows[0] ? Number(r.rows[0].cap_micro_usd) : null;
  }

  async reserve(tenantId: string, month: string, amount: number, meta?: ReservationMeta): Promise<string | null> {
    return tx(this.pool, async (c) => {
      const ok = await c.query(RESERVE_SQL, [tenantId, month, amount]);
      if (!ok.rowCount) return null;
      const row = await c.query(
        `INSERT INTO llm_usage (tenant_id, task_id, provider, model, input_tokens, output_tokens, reserved_micro_usd, status, month)
         VALUES ($1, $2, $3, $4, 0, 0, $5, 'reserved', $6) RETURNING id`,
        [tenantId, meta?.taskId && UUID.test(meta.taskId) ? meta.taskId : null, meta?.provider ?? 'unknown', meta?.model ?? 'unknown', amount, month],
      );
      return row.rows[0].id as string;
    });
  }

  async settle(id: string, actual: number, usage?: { inputTokens: number; outputTokens: number }): Promise<number> {
    return tx(this.pool, async (c) => {
      const u = await this.lock(c, id, ['reserved', 'frozen_unknown']);
      const charged = Math.min(Math.max(0, Math.ceil(actual)), u.reserved);
      await c.query('UPDATE llm_budget SET reserved_micro_usd = reserved_micro_usd - $3, spent_micro_usd = spent_micro_usd + $4 WHERE tenant_id = $1 AND month = $2', [u.tenantId, u.month, u.reserved, charged]);
      await c.query("UPDATE llm_usage SET status = 'settled', cost_micro_usd = $2, input_tokens = $3, output_tokens = $4 WHERE id = $1", [id, charged, usage?.inputTokens ?? 0, usage?.outputTokens ?? 0]);
      return u.reserved - charged;
    });
  }

  async release(id: string): Promise<void> {
    await tx(this.pool, async (c) => {
      const u = await this.lock(c, id, ['reserved', 'frozen_unknown']);
      await c.query('UPDATE llm_budget SET reserved_micro_usd = reserved_micro_usd - $3 WHERE tenant_id = $1 AND month = $2', [u.tenantId, u.month, u.reserved]);
      await c.query("UPDATE llm_usage SET status = 'released', cost_micro_usd = 0 WHERE id = $1", [id]);
    });
  }

  async freeze(id: string): Promise<void> {
    await tx(this.pool, async (c) => {
      await this.lock(c, id, ['reserved']);
      await c.query("UPDATE llm_usage SET status = 'frozen_unknown' WHERE id = $1", [id]);
    });
  }

  private async lock(c: pg.PoolClient, id: string, allowed: string[]) {
    const r = await c.query('SELECT tenant_id, month, reserved_micro_usd, status FROM llm_usage WHERE id = $1 FOR UPDATE', [id]);
    const row = r.rows[0];
    if (!row || !allowed.includes(row.status)) throw new Error(`reservation ${id} not in ${allowed.join('/')}`);
    return { tenantId: row.tenant_id as string, month: row.month as string, reserved: Number(row.reserved_micro_usd) };
  }
}

/** Reads model_capabilities.capabilities.price for verified models only. */
export class PgPriceBook implements PriceBook {
  constructor(private pool: pg.Pool) {}
  async price(provider: string, model: string): Promise<Price | null> {
    const r = await this.pool.query("SELECT capabilities->'price' AS price FROM model_capabilities WHERE provider = $1 AND model_id = $2 AND status = 'verified'", [provider, model]);
    const p = r.rows[0]?.price as Partial<Price> | null | undefined;
    if (!p || typeof p.inputPerMTokMicroUsd !== 'number' || typeof p.outputPerMTokMicroUsd !== 'number') return null;
    return { inputPerMTokMicroUsd: p.inputPerMTokMicroUsd, outputPerMTokMicroUsd: p.outputPerMTokMicroUsd, fullyBoundable: p.fullyBoundable === true };
  }
}
