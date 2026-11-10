import type pg from 'pg';
import type { Queryable } from '../sop/pg-sop.js';

export interface SopStartLink { requestId?: string; status: 'waiting_publication' | 'paused' | 'waiting_runtime' | 'blocked_claim' | 'blocked_source' | 'cancelled'; versionId?: string; instanceId?: string; reason: string }

export interface LongItem {
  id: string; sourceId: string; sopId: string; projectId: string; objectId: string; person: string;
  threadId: string; assignee: string; phase: 'initial' | 'reminder' | 'final' | 'replied' | 'closed';
  dueAt: string; reminderMs: number; events: string[];
  dateRuleId: string; dateRuleVersion: number;
  original: { body: string; receivedAt: string };
  waitRequestId?: string; registrationEvidence?: string; threadAliases?: string[];
  sopStart?: SopStartLink;
  replies: Array<{ eventId: string; body: string; receivedAt: string }>;
}
export interface Exception { id: string; kind: 'exception_ruling'; renderer: 'issue_list'; assignee: string;
  eventId: string; candidates: string[]; projectId: string; resolvedTo: string | null; sourceId?: string; sopId?: string; resolutionKind?: 'existing' | 'new' }
export interface Action {
  id: string; batchId: string; rowId: string; projectId: string; payload: Record<string, unknown>; hash: string;
  status: 'pending' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'unknown';
  approval: { by: string; hash: string } | null; evidence?: string;
  leaseUntil?: number;
}
export interface Collection {
  id: string; projectId: string; deadline: string; status: 'open' | 'summarized';
  recipients: string[]; replies: Record<string, string>; missing: string[];
}
export interface State {
  items: LongItem[]; exceptions: Exception[]; receipts: string[]; actions: Action[]; collections: Collection[];
  sources: Record<string, { cursor?: string; subscriptionId?: string; expiresAt?: string; lastScan?: number; leaseOwner?: string; leaseUntil?: number }>;
  rules: Array<{ id: string; version: number; field: string; offsetDays: number; businessDays: boolean;
    timeZone: string; hour: number; minute: number; holidays: string[]; weekend: number[] }>;
}
export const emptyState = (): State => ({ items: [], exceptions: [], receipts: [], actions: [], collections: [], sources: {}, rules: [] });
export interface Store { change<T>(tenant: string, fn: (state: State) => T, options?: { prepareSop?: boolean }): Promise<T> }
export type PrepareSop = (db: Queryable, tenant: string, state: State) => Promise<void>;

/** Serializes only state mutations; no external network calls are made under a transaction. */
export class PgLongWorkStore implements Store {
  constructor(private pool: pg.Pool, private prepareSop?: PrepareSop) {}
  async change<T>(tenant: string, fn: (state: State) => T, options?: { prepareSop?: boolean }): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO longwork_state(tenant_id, state) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenant, emptyState()]);
      const { rows } = await client.query<{ state: State }>('SELECT state FROM longwork_state WHERE tenant_id=$1 FOR UPDATE', [tenant]);
      const state = rows[0]!.state;
      const result = fn(state);
      if (options?.prepareSop && this.prepareSop) await this.prepareSop({ query: async <R>(sql: string, params: readonly unknown[]) =>
        ({ rows: (await client.query(sql, params as unknown[])).rows as R[] }) }, tenant, state);
      await client.query('UPDATE longwork_state SET state=$2, updated_at=now() WHERE tenant_id=$1', [tenant, state]);
      await client.query('COMMIT');
      return structuredClone(result);
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }
}

/** Local development/tests only. Rollback and detached results match the PostgreSQL contract. */
export class MemoryLongWorkStore implements Store {
  private rows = new Map<string, State>();
  async change<T>(tenant: string, fn: (state: State) => T): Promise<T> {
    const state = structuredClone(this.rows.get(tenant) ?? emptyState());
    const result = fn(state);
    this.rows.set(tenant, state);
    return structuredClone(result);
  }
}
