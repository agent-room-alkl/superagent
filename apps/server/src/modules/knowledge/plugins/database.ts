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
  const sql = t.sql.trim();
  if (!/^select\b/i.test(sql)) throw new QueryGatewayError('only SELECT templates are allowed');
  if (sql.includes(';')) throw new QueryGatewayError('multiple statements are not allowed');
  if (/--|\/\*/.test(sql)) throw new QueryGatewayError('comments are not allowed in templates');
  if (/["`]/.test(sql)) throw new QueryGatewayError('quoted identifiers are not allowed');
  const body = sql.replace(/'(?:[^']|'')*'/g, "''"); // string literals are values, not identifiers
  // An alias is never a keyword: "FROM a JOIN b" must register both a and b.
  const tables = [...body.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?(?!(?:join|inner|left|on|where|group|order|having)\b)([a-z_][a-z0-9_]*))?/gi)];
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
  checkQualifiedColumns(body, tables, scope, names, cols);
  if (/\*/.test(body.replace(/count\s*\(\s*\*\s*\)/gi, ''))) throw new QueryGatewayError('SELECT * is not allowed; list allow-listed columns');
  if ((body.match(/\$\d+/g) ?? []).some((p) => Number(p.slice(1)) > t.params.length)) throw new QueryGatewayError('undeclared parameter');
  return { maskedOutputs: sensitiveLineage(body, tables.map((m) => m[1]!.toLowerCase()), scope) };
}

/**
 * Column allowlists are per table. A qualified column ("i.iban") must be allow-listed for the table its qualifier
 * names, never borrowed from another referenced table's list. When more than one distinct table is referenced,
 * every column must be qualified, so an unqualified name cannot resolve to a table where it is not allow-listed.
 */
function checkQualifiedColumns(body: string, tables: RegExpMatchArray[], scope: DbScope, names: Set<string>, cols: Set<string>): void {
  const tableOf = new Map<string, string>();
  for (const m of tables) {
    const tbl = m[1]!.toLowerCase();
    tableOf.set(tbl, tbl);
    const alias = m[2]?.toLowerCase();
    if (alias && !KEYWORDS.has(alias)) tableOf.set(alias, tbl);
  }
  const qualified = /(?<![a-z0-9_$.])([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)/gi;
  for (const m of body.matchAll(qualified)) {
    const q = m[1]!.toLowerCase();
    const col = m[2]!.toLowerCase();
    const tbl = tableOf.get(q);
    if (!tbl) throw new QueryGatewayError(`unknown table or alias ${q}`);
    if (!scope.tables[tbl]!.columns.some((c) => c.toLowerCase() === col)) throw new QueryGatewayError(`column ${col} is not allow-listed for ${tbl}`);
  }
  if (new Set(tables.map((m) => m[1]!.toLowerCase())).size < 2) return;
  const rest = body.replace(qualified, ' ').replace(/\bas\s+[a-z_][a-z0-9_]*/gi, ' ');
  for (const m of rest.matchAll(/(?<![a-z0-9_$])[a-z_][a-z0-9_]*(?!\s*\()/gi)) {
    const w = m[0].toLowerCase();
    if (cols.has(w) && !names.has(w)) throw new QueryGatewayError(`qualify ${w} with its table or alias when more than one table is referenced`);
  }
}

/**
 * Output-column lineage for sensitive columns. A sensitive column may appear only as a plain select item
 * ("email", "i.email", optionally "AS alias"); its output name (the alias if any) is masked. Any other use —
 * inside an expression or function, or in WHERE / JOIN / GROUP BY / ORDER BY / HAVING — is refused, because
 * the value could leak unmasked through the expression or be probed through filtering.
 */
function sensitiveLineage(body: string, tables: string[], scope: DbScope): Set<string> {
  const sensitive = new Set(tables.flatMap((tb) => scope.tables[tb]!.sensitive ?? []).map((c) => c.toLowerCase()));
  const masked = new Set<string>();
  if (!sensitive.size) return masked;
  const { items, rest } = splitSelect(body);
  const idents = (s: string) => [...s.matchAll(/(?<![a-z0-9_$])[a-z_][a-z0-9_]*/gi)].map((m) => m[0].toLowerCase());
  for (const raw of items) {
    const item = raw.trim().replace(/^distinct\s+/i, '');
    if (!idents(item).some((w) => sensitive.has(w))) continue;
    const plain = item.match(/^(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?$/i);
    if (!plain || !sensitive.has(plain[1]!.toLowerCase())) throw new QueryGatewayError('a sensitive column may only be selected directly, not inside an expression');
    masked.add((plain[2] ?? plain[1]!).toLowerCase());
  }
  if (idents(rest).some((w) => sensitive.has(w))) throw new QueryGatewayError('sensitive columns cannot be filtered, joined, grouped or ordered on');
  return masked;
}

/** Splits "SELECT a, f(b, c) AS x FROM …" into its top-level select items and the remainder from FROM on. */
function splitSelect(body: string): { items: string[]; rest: string } {
  const s = body.replace(/^\s*select\s+/i, '');
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === ',') {
      items.push(s.slice(start, i));
      start = i + 1;
    } else if (depth === 0 && /^from\b/i.test(s.slice(i)) && /\W/.test(s[i - 1] ?? ' ')) {
      items.push(s.slice(start, i));
      return { items, rest: s.slice(i) };
    }
  }
  throw new QueryGatewayError('no top-level FROM clause');
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
