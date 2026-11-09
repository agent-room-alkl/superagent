/**
 * Read-only database knowledge source (PRD §3.2.1). Two uses:
 *  1) understanding: allow-listed table/column structure (+ masked samples) as knowledge items, anchored "table.column";
 *  2) live facts: only owner-approved, parameterised query templates through the gateway; results carry query time and
 *     scope and are never written into knowledge.
 * Read-only is enforced in three layers: a SELECT-only database account (customer DBA), this gateway (approved
 * templates, column allowlist, function allowlist, READ ONLY transaction, timeout, row cap), and platform scope checks.
 */
import type { AclResult, ConnectionConfig, KnowledgeSourcePlugin, SourceItemRef } from '@superagent/shared';
import { validateSelectAst } from './select-ast.js';

export interface DbScope {
  /** Allow-listed tables or row-filtered views → readable columns; sensitive columns are masked in results. */
  tables: Record<string, { columns: string[]; sensitive?: string[] }>;
  audience: string[];
  maxRows: number;
}

export interface QueryTemplate {
  id: string;
  sql: string; // single SELECT with $1.. parameters
  params: string[];
  approvedBy: string;
}

export interface LiveFact {
  templateId: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  queriedAt: string;
  scope: string;
  schemaVersion: string;
  kind: 'current_fact'; // never a rule; never stored as knowledge
}

/** Minimal client surface so tests can use a fake and production uses pg. */
export interface DbClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}


export class QueryGatewayError extends Error {}

const MAX_ROWS = 1000;
const MAX_TIMEOUT_MS = 60_000;

/**
 * Validates a template at approval time and again before every run. Every identifier in the statement must be a
 * keyword from a small list, an allow-listed function, an allow-listed table (or its alias / AS alias) or an
 * allow-listed column of the referenced tables, so non-listed columns cannot be read, filtered on or joined on.
 * Row scope is enforced by pointing the allowlist at row-filtered views owned by the customer DBA.
 */
export function validateTemplate(t: QueryTemplate, scope: DbScope): { maskedOutputs: Set<string> } {
  if (!Number.isSafeInteger(scope.maxRows) || scope.maxRows < 1 || scope.maxRows > MAX_ROWS) throw new QueryGatewayError(`maxRows must be an integer between 1 and ${MAX_ROWS}`);
  try { return validateSelectAst(t.sql, scope, t.params.length); }
  catch (error) { throw new QueryGatewayError(error instanceof Error ? error.message : 'SELECT template rejected'); }
}
export async function runTemplate(db: DbClient, t: QueryTemplate, args: unknown[], scope: DbScope, schemaVersion: string, timeoutMs = 5000): Promise<LiveFact> {
  const { maskedOutputs } = validateTemplate(t, scope);
  if (args.length !== t.params.length) throw new QueryGatewayError('parameter count mismatch');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new QueryGatewayError(`timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`);
  const limited = `SELECT * FROM (${t.sql}) AS q LIMIT ${scope.maxRows}`; // integer-validated above
  await db.query('BEGIN READ ONLY');
  try {
    await db.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const r = await db.query(limited, args);
    await db.query('COMMIT');
    // Mask by lineage (aliases of sensitive columns) and, defensively, by sensitive column name.
    const sensitive = new Set([...maskedOutputs, ...Object.values(scope.tables).flatMap((x) => x.sensitive ?? []).map((s) => s.toLowerCase())]);
    const rows = r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sensitive.has(k.toLowerCase()) ? mask(v) : v])));
    return { templateId: t.id, rows, rowCount: rows.length, queriedAt: new Date().toISOString(), scope: Object.keys(scope.tables).join(','), schemaVersion, kind: 'current_fact' };
  } catch (e) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

export function mask(v: unknown): string {
  const s = String(v ?? '');
  if (s.includes('@')) return s[0] + '***@' + s.split('@')[1];
  return s.length <= 2 ? '**' : s[0] + '*'.repeat(Math.min(6, s.length - 2)) + s[s.length - 1];
}

/** Knowledge-source side: describes allow-listed structure (not data) so analysis can cite "table.column". */
export function createDatabasePlugin(introspect: (scope: DbScope) => Promise<{ version: string; tables: Record<string, { column: string; type: string }[]> }>): KnowledgeSourcePlugin {
  const scopeOf = (cfg: ConnectionConfig) => cfg.scope as unknown as DbScope;
  return {
    manifest: { id: 'readonly-db', version: '1.0.0', name: '只读数据库', capabilities: { incremental: false, attachments: false, liveQuery: true, acl: true }, permissions: ['SELECT on allow-listed views'] },
    async testConnection(cfg) {
      await introspect(scopeOf(cfg));
      return { ok: true };
    },
    async listItems(cfg) {
      const s = await introspect(scopeOf(cfg));
      const items: SourceItemRef[] = Object.keys(s.tables).map((t) => ({ externalId: t, version: s.version, title: `表 ${t}`, locator: `db://${t}`, change: 'upsert' }));
      return { items, nextCursor: s.version };
    },
    async readItem(cfg, ref) {
      const s = await introspect(scopeOf(cfg));
      const cols = s.tables[ref.externalId] ?? [];
      let text = '';
      const anchors = cols.map((c) => {
        const line = `${ref.externalId}.${c.column} (${c.type})`;
        const start = text.length;
        text += line + '\n';
        return { start, end: start + line.length, locator: `${ref.externalId}.${c.column}@schema ${s.version}` };
      });
      return { text, anchors };
    },
    async getAcl(cfg): Promise<AclResult> {
      const a = scopeOf(cfg).audience;
      return a?.length ? { status: 'known', entries: a.map((p) => ({ principal: p, access: 'read' as const })) } : { status: 'unknown', reason: 'no audience configured' };
    },
  };
}
