/**
 * PostgreSQL adapters for Setup (production). The model key itself is never stored here: only the Key Vault secret
 * name/version (PRD §7.1). Config history goes to the append-only audit_log in the same transaction as the update.
 */
import type pg from 'pg';
import type { LlmProviderId, ModelInfo } from '@superagent/shared';
import { sanitize } from '../audit/audit.js';
import type { Allowlist, ConfigRepo, LlmConfigRecord } from './service.js';

const OBJECT_TYPE = 'llm_config';

export class PgConfigRepo implements ConfigRepo {
  constructor(private pool: pg.Pool) {}

  async get(tenantId: string): Promise<LlmConfigRecord> {
    const r = await this.pool.query('SELECT * FROM llm_config WHERE tenant_id = $1', [tenantId]);
    const h = await this.pool.query(
      'SELECT action, detail, created_at FROM audit_log WHERE tenant_id = $1 AND object_type = $2 AND object_id = $3 ORDER BY created_at, id',
      [tenantId, OBJECT_TYPE, tenantId],
    );
    const row = r.rows[0];
    return {
      tenantId,
      provider: (row?.provider as LlmProviderId | null) ?? null,
      endpoint: row?.endpoint ?? null,
      secret: row?.key_vault_secret && row?.key_vault_version ? { name: row.key_vault_secret, version: row.key_vault_version } : null,
      keyLast4: row?.key_last4 ?? null,
      primaryModel: row?.primary_model ?? null,
      economyModel: row?.economy_model ?? null,
      status: (row?.status as LlmConfigRecord['status']) ?? 'unconfigured',
      monthlyCapMicroUsd: row?.monthly_cap_micro_usd == null ? null : Number(row.monthly_cap_micro_usd),
      history: h.rows.map((x) => ({ at: new Date(x.created_at).toISOString(), event: x.action, detail: x.detail ?? {} })),
    };
  }

  /** One transaction: upsert the config row and append the history entries not yet in the audit log. */
  async save(rec: LlmConfigRecord): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        `INSERT INTO llm_config (tenant_id, provider, endpoint, key_vault_secret, key_vault_version, key_last4, primary_model, economy_model, status, monthly_cap_micro_usd, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (tenant_id) DO UPDATE SET provider = EXCLUDED.provider, endpoint = EXCLUDED.endpoint,
           key_vault_secret = EXCLUDED.key_vault_secret, key_vault_version = EXCLUDED.key_vault_version,
           key_last4 = EXCLUDED.key_last4, primary_model = EXCLUDED.primary_model, economy_model = EXCLUDED.economy_model,
           status = EXCLUDED.status, monthly_cap_micro_usd = EXCLUDED.monthly_cap_micro_usd, updated_at = now()`,
        [rec.tenantId, rec.provider, rec.endpoint, rec.secret?.name ?? null, rec.secret?.version ?? null, rec.keyLast4, rec.primaryModel, rec.economyModel, rec.status, rec.monthlyCapMicroUsd],
      );
      const n = await c.query('SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND object_type = $2 AND object_id = $3', [rec.tenantId, OBJECT_TYPE, rec.tenantId]);
      for (const h of rec.history.slice(n.rows[0].n)) {
        await c.query(
          "INSERT INTO audit_log (tenant_id, actor, action, object_type, object_id, version_ref, result, detail) VALUES ($1, 'setup', $2, $3, $6, $4, 'ok', $5)",
          [rec.tenantId, h.event, OBJECT_TYPE, rec.secret?.version ?? null, JSON.stringify(sanitize(h.detail)), rec.tenantId],
        );
      }
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}

/** Selectable models = provider list ∩ models the platform capability-tested (model_capabilities.status = verified). */
export class PgAllowlist implements Allowlist {
  constructor(private pool: pg.Pool) {}
  async verified(provider: LlmProviderId): Promise<Map<string, ModelInfo['verified']>> {
    const r = await this.pool.query("SELECT model_id, capabilities FROM model_capabilities WHERE provider = $1 AND status = 'verified'", [provider]);
    return new Map(r.rows.map((x) => [x.model_id as string, x.capabilities as ModelInfo['verified']]));
  }
}
