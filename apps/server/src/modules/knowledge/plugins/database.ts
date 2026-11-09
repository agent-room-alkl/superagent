/**
 * Read-only database knowledge source (PRD §3.2.1). Two uses:
 *  1) understanding: allow-listed table/column structure (+ masked samples) as knowledge items, anchored "table.column";
 *  2) live facts: only owner-approved, parameterised query templates through the gateway; results carry query time and
 *     scope and are never written into knowledge.
 * Read-only is enforced in three layers: a SELECT-only database account (customer DBA), this gateway (approved
 * templates, column allowlist, function allowlist, READ ONLY transaction, timeout, row cap), and platform scope checks.
 */
import type { AclResult, ConnectionConfig, KnowledgeSourcePlugin, SourceItemRef } from '@superagent/shared';

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

const ALLOWED_FUNCTIONS = new Set(['count', 'sum', 'min', 'max', 'avg', 'coalesce', 'lower', 'upper', 'date_trunc']);
const KEYWORDS = new Set(['select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null', 'as', 'join', 'inner', 'left', 'on', 'group', 'by', 'order', 'asc', 'desc', 'having', 'between', 'like', 'ilike', 'distinct', 'case', 'when', 'then', 'else', 'end', 'true', 'false']);

export class QueryGatewayError extends Error {}

/**
 * Validates a template at approval time and again before every run. Every identifier in the statement must be a
 * keyword from a small list, an allow-listed function, an allow-listed table (or its alias / AS alias) or an
 * allow-listed column of the referenced tables, so non-listed columns cannot be read, filtered on or joined on.
 * Row scope is enforced by pointing the allowlist at row-filtered views owned by the customer DBA.
 */
export function validateTemplate(t: QueryTemplate, scope: DbScope): void {
  const sql = t.sql.trim();
  if (!/^select\b/i.test(sql)) throw new QueryGatewayError('only SELECT templates are allowed');
  if (sql.includes(';')) throw new QueryGatewayError('multiple statements are not allowed');
  if (/--|\/\*/.test(sql)) throw new QueryGatewayError('comments are not allowed in templates');
  if (/["`]/.test(sql)) throw new QueryGatewayError('quoted identifiers are not allowed');
  const body = sql.replace(/'(?:[^']|'')*'/g, "''"); // string literals are values, not identifiers
  const tables = [...body.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?/gi)];
  if (!tables.length) throw new QueryGatewayError('no table referenced');
  const names = new Set<string>();
  for (const m of tables) {
    const tbl = m[1]!.toLowerCase();
    if (!scope.tables[tbl]) throw new QueryGatewayError(`table ${tbl} is not allow-listed`);
    names.add(tbl);
    const alias = m[2]?.toLowerCase();
    if (alias && !KEYWORDS.has(alias)) names.add(alias);
  }
  for (const m of body.matchAll(/\bas\s+([a-z_][a-z0-9_]*)/gi)) names.add(m[1]!.toLowerCase());
  const cols = new Set(tables.flatMap((m) => scope.tables[m[1]!.toLowerCase()]!.columns.map((c) => c.toLowerCase())));
  for (const m of body.matchAll(/(?<![a-z0-9_$])\$?[a-z_][a-z0-9_]*(\s*\()?/gi)) {
    const word = m[0].replace(/\s*\($/, '').toLowerCase();
    if (word.startsWith('$')) continue;
    if (m[1]) {
      if (!ALLOWED_FUNCTIONS.has(word)) throw new QueryGatewayError(`function ${word} is not allow-listed`);
      continue;
    }
    if (KEYWORDS.has(word) || names.has(word) || cols.has(word)) continue;
    throw new QueryGatewayError(`identifier ${word} is not allow-listed`);
  }
  if (/\*/.test(body.replace(/count\s*\(\s*\*\s*\)/gi, ''))) throw new QueryGatewayError('SELECT * is not allowed; list allow-listed columns');
  if ((body.match(/\$\d+/g) ?? []).some((p) => Number(p.slice(1)) > t.params.length)) throw new QueryGatewayError('undeclared parameter');
}

export async function runTemplate(db: DbClient, t: QueryTemplate, args: unknown[], scope: DbScope, schemaVersion: string, timeoutMs = 5000): Promise<LiveFact> {
  validateTemplate(t, scope);
  if (args.length !== t.params.length) throw new QueryGatewayError('parameter count mismatch');
  const limited = `SELECT * FROM (${t.sql}) AS q LIMIT ${Math.max(1, Math.min(scope.maxRows, 1000))}`;
  await db.query('BEGIN READ ONLY');
  try {
    await db.query(`SET LOCAL statement_timeout = ${Math.trunc(timeoutMs)}`);
    const r = await db.query(limited, args);
    await db.query('COMMIT');
    const sensitive = new Set(Object.values(scope.tables).flatMap((x) => x.sensitive ?? []).map((s) => s.toLowerCase()));
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
