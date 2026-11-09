import { describe, expect, it } from 'vitest';
import { validateSelectAst } from '../src/modules/knowledge/plugins/select-ast.js';
import type { DbScope } from '../src/modules/knowledge/plugins/database.js';

const scope: DbScope = {
  audience: ['synthetic-owner'], maxRows: 25,
  tables: {
    invoices: { columns: ['id', 'vendor', 'amount', 'status', 'contact_email', 'created_at'], sensitive: ['contact_email'] },
    vendors: { columns: ['id', 'name', 'iban'] },
  },
};
const validate = (sql: string, params = 0) => validateSelectAst(sql, scope, params);

describe('typed PostgreSQL SELECT policy', () => {
  it.each([
    'SELECT id, amount, status FROM invoices WHERE vendor = $1 AND amount > $2',
    "SELECT count(*) AS n, sum(i.amount) AS total FROM invoices i JOIN vendors v ON v.id = i.vendor WHERE i.status = 'open' GROUP BY v.name HAVING sum(i.amount) > $1 ORDER BY v.name DESC",
    'SELECT i.id, v.iban FROM public.invoices i LEFT JOIN public.vendors v ON i.vendor = v.id WHERE i.amount BETWEEN $1 AND $2 ORDER BY i.id ASC NULLS LAST',
  ])('allows source-resolved references, ordinary predicates and approved joins: %s', sql => {
    expect(validate(sql, 2).maskedOutputs).toEqual(new Set());
  });

  it.each([
    'SELECT id FROM invoices WHERE NOT (id = $1 OR amount < 0)',
    "SELECT id FROM invoices WHERE status IN ('open', 'paid') AND vendor NOT IN ($1, $2)",
    'SELECT id FROM invoices WHERE amount NOT BETWEEN 1 AND 4 AND status IS NOT NULL',
    "SELECT id FROM invoices WHERE status LIKE $1 OR status NOT ILIKE 'x%'",
    'SELECT id FROM invoices WHERE TRUE AND NOT FALSE',
    'SELECT id FROM invoices WHERE (amount + 2) / 3 >= -1',
    'SELECT id, NULL AS missing, TRUE AS enabled, 1.5 AS ratio FROM invoices',
    "SELECT coalesce(lower(status), 'unknown') AS status_label, upper(status) AS upper_status FROM invoices",
    "SELECT date_trunc('day', created_at) AS day FROM invoices",
    'SELECT min(amount) AS minimum, max(amount) AS maximum, avg(amount) AS average FROM invoices',
    'SELECT DISTINCT status FROM invoices',
    'SELECT ALL public.invoices.id FROM public.invoices',
    'SELECT pg_catalog.lower(status) AS lowered FROM invoices',
    'SELECT a.id AS first_id, b.id AS second_id FROM invoices a JOIN invoices b ON a.vendor = b.vendor',
  ])('supports the bounded expression grammar: %s', sql => {
    expect(() => validate(sql, 2)).not.toThrow();
  });

  it('masks sensitive direct output names, including qualified and case-folded aliases', () => {
    expect(validate('SELECT id, contact_email AS public_alias FROM invoices').maskedOutputs).toEqual(new Set(['public_alias']));
    expect(validate('SELECT i.id, i.contact_email FROM invoices i').maskedOutputs).toEqual(new Set(['contact_email']));
    expect(validate('SELECT I.CONTACT_EMAIL AS PUBLIC_ALIAS FROM INVOICES I').maskedOutputs).toEqual(new Set(['public_alias']));
  });

  it.each([
    'SELECT i.iban FROM invoices i JOIN vendors v ON i.vendor = v.id',
    'SELECT invoices.iban FROM invoices JOIN vendors ON invoices.vendor = vendors.id',
    'SELECT iban FROM invoices i JOIN vendors v ON i.vendor = v.id',
    'SELECT i FROM invoices i',
    'SELECT invoices FROM invoices',
    'SELECT iban FROM invoices AS iban',
    'SELECT id AS iban, iban FROM invoices',
    'SELECT x.iban FROM invoices i JOIN vendors v ON i.vendor = v.id',
  ])('prevents table/column/alias borrowing and whole-row composites: %s', sql => {
    expect(() => validate(sql)).toThrow();
  });

  it.each([
    'SELECT id FROM invoices i JOIN vendors v ON i.vendor = v.id',
    'SELECT v.id FROM invoices i JOIN vendors i ON i.id = i.id',
    'SELECT invoices.id FROM invoices i',
    'SELECT public.i.id FROM invoices i',
    'SELECT i.id FROM invoices i JOIN vendors v ON later.id = i.id JOIN vendors later ON later.id = i.vendor',
    'SELECT id FROM invoices, vendors',
    'SELECT i.id FROM invoices i CROSS JOIN vendors v',
    'SELECT i.id FROM invoices i RIGHT JOIN vendors v ON i.vendor = v.id',
    'SELECT i.id FROM invoices i LEFT JOIN vendors v USING(id)',
    'SELECT id FROM private.invoices',
    'SELECT private.invoices.id FROM public.invoices',
    'SELECT id FROM pg_catalog.pg_authid',
  ])('rejects ambiguous, hidden, future, unsafe-schema and unsupported join bindings: %s', sql => {
    expect(() => validate(sql)).toThrow();
  });

  it.each([
    "SELECT lower(contact_email) FROM invoices",
    "SELECT coalesce(contact_email, '') AS alias FROM invoices",
    'SELECT count(contact_email) AS n FROM invoices',
    'SELECT contact_email + 1 AS alias FROM invoices',
    'SELECT id FROM invoices WHERE contact_email = $1',
    'SELECT id FROM invoices WHERE id IN (contact_email)',
    'SELECT id FROM invoices WHERE amount BETWEEN 1 AND contact_email',
    'SELECT i.id FROM invoices i JOIN vendors v ON i.contact_email = v.name',
    'SELECT contact_email FROM invoices GROUP BY contact_email',
    'SELECT contact_email FROM invoices ORDER BY contact_email',
    'SELECT contact_email FROM invoices HAVING contact_email IS NOT NULL',
    'SELECT contact_email AS id FROM invoices ORDER BY id',
    'SELECT contact_email AS alias FROM invoices GROUP BY alias',
    'SELECT contact_email FROM invoices ORDER BY 1',
    'SELECT contact_email FROM invoices GROUP BY 1',
    'SELECT contact_email AS alias FROM invoices ORDER BY lower(alias)',
    'SELECT DISTINCT contact_email AS c FROM invoices',
    'SELECT DISTINCT id, contact_email FROM invoices',
  ])('blocks sensitive inference through every supported expression/clause context: %s', sql => {
    expect(() => validate(sql, 1)).toThrow();
  });

  it.each([
    'SELECT id AS duplicate, contact_email AS duplicate FROM invoices',
    'SELECT id, vendor AS id FROM invoices',
    'SELECT count(*), count(id) FROM invoices',
    'SELECT 1, 2 FROM invoices',
  ])('rejects duplicate effective output names that could corrupt masking: %s', sql => {
    expect(() => validate(sql)).toThrow();
  });

  it.each([
    'SELECT * FROM invoices', 'SELECT i.* FROM invoices i', 'SELECT count(i.*) FROM invoices i',
    'SELECT sum(*) FROM invoices', 'SELECT count(*) + contact_email FROM invoices',
    'SELECT count(*) FILTER(WHERE contact_email IS NOT NULL) FROM invoices',
    'SELECT count(*) OVER (ORDER BY contact_email) FROM invoices',
    'SELECT count(DISTINCT contact_email) FROM invoices',
    'SELECT count(id ORDER BY contact_email) FROM invoices',
    'SELECT count(*) WITHIN GROUP (ORDER BY contact_email) FROM invoices',
    'SELECT DISTINCT ON (contact_email) id FROM invoices',
  ])('limits wildcards to bare count(*) and rejects aggregate/DISTINCT modifiers: %s', sql => {
    expect(() => validate(sql)).toThrow();
  });

  it.each([
    'SELECT (SELECT id FROM invoices) AS nested FROM invoices',
    'SELECT id FROM invoices WHERE id IN (SELECT id FROM invoices)',
    'SELECT id FROM invoices WHERE EXISTS (SELECT id FROM invoices)',
    'SELECT coalesce((SELECT contact_email FROM invoices), status) FROM invoices',
    'SELECT id FROM (SELECT id FROM invoices) x',
    'WITH x AS (SELECT id FROM invoices) SELECT id FROM x',
    'SELECT id FROM invoices UNION SELECT id FROM invoices',
    'SELECT id FROM invoices INTERSECT SELECT id FROM invoices',
    'SELECT ARRAY(SELECT contact_email FROM invoices) FROM invoices',
    'SELECT id FROM invoices JOIN LATERAL (SELECT id FROM vendors) v ON TRUE',
    'SELECT id FROM generate_series(1, 10) id',
    'VALUES (1)', 'UPDATE invoices SET amount = 1', 'DELETE FROM invoices',
  ])('rejects nested statement and table-function AST smuggling: %s', sql => {
    expect(() => validate(sql)).toThrow();
  });

  it.each([
    'SELECT id::text FROM invoices', "SELECT CAST(id AS text) FROM invoices",
    "SELECT status ->> 'secret' FROM invoices", 'SELECT (invoices).contact_email FROM invoices',
    'SELECT status[1] FROM invoices', "SELECT status COLLATE public.unsafe FROM invoices",
    'SELECT current_user FROM invoices', 'SELECT CASE WHEN id = 1 THEN status ELSE status END FROM invoices',
    'SELECT pg_sleep(10) FROM invoices', 'SELECT public.lower(status) FROM invoices',
    'SELECT evil.lower(status) FROM invoices', 'SELECT pg_catalog.set_config(status,status,TRUE) FROM invoices',
    'SELECT id OPERATOR(public.+) 1 FROM invoices', "SELECT status || 'x' FROM invoices",
    'SELECT ARRAY[id] FROM invoices', 'SELECT (id, amount) FROM invoices',
    'SELECT id FROM invoices LIMIT 1', 'SELECT id FROM invoices OFFSET 1',
    'SELECT id FROM invoices FOR UPDATE', 'SELECT id FROM invoices FOR SHARE SKIP LOCKED',
    'SELECT id FROM invoices AS i(renamed)',
  ])('fails closed on unsupported PostgreSQL AST forms and modifiers: %s', sql => {
    expect(() => validate(sql)).toThrow();
  });

  it.each([
    'SELECT "id" FROM invoices', 'SELECT id FROM "invoices"', 'SELECT id FROM invoices -- comment',
    'SELECT id FROM invoices /* comment */', 'SELECT id FROM invoices;', 'SELECT id FROM invoices; DELETE FROM invoices',
  ])('preserves the lexical policy for quoting, comments and statement separators: %s', sql => {
    expect(() => validate(sql)).toThrow();
  });

  it('validates every parameter position and declaration bound', () => {
    expect(() => validate('SELECT id FROM invoices WHERE id = $1', 1)).not.toThrow();
    for (const parameter of ['$0', '$01', '$2', '$999999999999999999999']) expect(() => validate(`SELECT id FROM invoices WHERE id = ${parameter}`, 1)).toThrow();
    for (const count of [-1, 1.5, Number.NaN, 21]) expect(() => validate('SELECT id FROM invoices', count)).toThrow();
  });

  it('bounds SQL and expression complexity, and rejects inherited allowlist properties', () => {
    expect(() => validate('SELECT id FROM invoices WHERE ' + 'TRUE AND '.repeat(1000) + 'TRUE')).toThrow();
    expect(() => validate('SELECT id FROM invoices WHERE ' + 'NOT '.repeat(100) + 'TRUE')).toThrow();
    expect(() => validateSelectAst('SELECT id FROM constructor', { ...scope, tables: {} }, 0)).toThrow();
  });

  it('returns a safe parse failure without echoing SQL text or parser diagnostics', () => {
    let caught: unknown;
    try { validate('SELECT secret_synthetic_document_text FROM ('); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('SELECT template rejected: invalid PostgreSQL syntax');
    expect((caught as Error).message).not.toContain('secret_synthetic_document_text');
  });
});
