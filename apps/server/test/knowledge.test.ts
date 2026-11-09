import { describe, it, expect, beforeEach } from 'vitest';
import { SourceError, type AclResult, type ConnectionConfig, type KnowledgeSourcePlugin, type SourceContent, type SourceItemRef } from '@superagent/shared';
import { KnowledgeStore } from '../src/modules/knowledge/store.js';
import { syncConnection } from '../src/modules/knowledge/sync.js';
import { createLocalFilePlugin, textWithLineAnchors } from '../src/modules/knowledge/plugins/local-file.js';
import { createDatabasePlugin, mask, QueryGatewayError, runTemplate, validateTemplate, type DbClient, type DbScope } from '../src/modules/knowledge/plugins/database.js';

/** Scriptable source: each listItems call consumes one scripted step. */
class FakeSource implements KnowledgeSourcePlugin {
  manifest = { id: 'fake', version: '1', name: 'fake', capabilities: { incremental: true, attachments: false, liveQuery: false, acl: true }, permissions: [] };
  docs = new Map<string, { version: string; text: string; acl: AclResult }>();
  steps: (((cursor?: string) => { items: SourceItemRef[]; nextCursor?: string }) | Error)[] = [];
  listCalls: (string | undefined)[] = [];
  reads = 0;
  failReadOnce = new Set<string>();
  async testConnection() {
    return { ok: true };
  }
  async listItems(_c: ConnectionConfig, cursor?: string) {
    this.listCalls.push(cursor);
    const s = this.steps.shift();
    if (!s) return { items: [], nextCursor: cursor };
    if (s instanceof Error) throw s;
    return s(cursor);
  }
  async readItem(_c: ConnectionConfig, ref: SourceItemRef): Promise<SourceContent> {
    if (this.failReadOnce.delete(ref.externalId)) throw new SourceError('transient', 'blip');
    this.reads++;
    const d = this.docs.get(ref.externalId)!;
    return textWithLineAnchors(d.text, ref.externalId);
  }
  async getAcl(_c: ConnectionConfig, ref: SourceItemRef) {
    return this.docs.get(ref.externalId)!.acl;
  }
  put(id: string, version: string, text: string, acl: AclResult = known) {
    this.docs.set(id, { version, text, acl });
  }
  ref(id: string, change: SourceItemRef['change'] = 'upsert'): SourceItemRef {
    return { externalId: id, version: this.docs.get(id)?.version ?? 'gone', title: id, locator: `fake://${id}`, change };
  }
}

const known: AclResult = { status: 'known', entries: [{ principal: 'grp-finance', access: 'read' }] };

let store: KnowledgeStore;
let src: FakeSource;
beforeEach(() => {
  store = new KnowledgeStore();
  src = new FakeSource();
  store.connections.set('c1', { id: 'c1', pluginId: 'fake', scope: {}, credentialRef: 'kv-secret-name', status: 'confirmed', cursor: null, confirmedBy: 'owner' });
});
const usableIds = () => [...store.items.values()].filter((i) => store.usable(i)).map((i) => i.externalId).sort();

describe('sync semantics (PRD §3.2)', () => {
  it('upsert: new version replaces old, old superseded, citers flagged, chunks carry line anchors', async () => {
    src.put('policy.md', 'v1', 'Approve under 500\nEscalate above 500');
    src.steps.push(() => ({ items: [src.ref('policy.md')], nextCursor: 'k1' }));
    expect((await syncConnection(store, src, 'c1')).applied).toBe(1);
    const v1 = store.currentItem('c1', 'policy.md')!;
    store.cite(v1.id, 'sop:approval-node');
    expect(store.chunks.map((c) => c.locator)).toEqual(['policy.md#L1', 'policy.md#L2']);

    src.put('policy.md', 'v2', 'Approve under 800');
    src.steps.push(() => ({ items: [src.ref('policy.md')], nextCursor: 'k2' }));
    await syncConnection(store, src, 'c1');
    const v2 = store.currentItem('c1', 'policy.md')!;
    expect(v2.version).toBe('v2');
    expect(store.items.get(v1.id)!.status).toBe('superseded');
    expect(store.usable(store.items.get(v1.id)!)).toBe(false);
    expect(store.flagged.get('sop:approval-node')).toMatch(/evidence changed/);
    expect(store.connections.get('c1')!.cursor).toBe('k2');
  });

  it('deleted: item leaves retrieval, history kept, citers flagged', async () => {
    src.put('a.md', 'v1', 'x');
    src.steps.push(() => ({ items: [src.ref('a.md')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    const it1 = store.currentItem('c1', 'a.md')!;
    store.cite(it1.id, 'answer:42');
    src.steps.push(() => ({ items: [src.ref('a.md', 'deleted')], nextCursor: 'k2' }));
    await syncConnection(store, src, 'c1');
    expect(store.items.get(it1.id)!.status).toBe('deleted');
    expect(store.items.has(it1.id)).toBe(true);
    expect(usableIds()).toEqual([]);
    expect(store.flagged.get('answer:42')).toMatch(/deleted/);
  });

  it('access_revoked: unusable immediately, citers flagged evidence unavailable', async () => {
    src.put('hr.md', 'v1', 'salary bands');
    src.steps.push(() => ({ items: [src.ref('hr.md')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    store.cite(store.currentItem('c1', 'hr.md')!.id, 'rec:emp-hr');
    src.steps.push(() => ({ items: [src.ref('hr.md', 'access_revoked')], nextCursor: 'k2' }));
    await syncConnection(store, src, 'c1');
    expect(usableIds()).toEqual([]);
    expect(store.currentItem('c1', 'hr.md')!.status).toBe('access_revoked');
    expect(store.flagged.get('rec:emp-hr')).toMatch(/access revoked/);
  });

  it('ACL unknown: listed but unusable; only a later known ACL restores it (no override API exists)', async () => {
    src.put('x.md', 'v1', 'text', { status: 'unknown', reason: 'source did not return permissions' });
    src.steps.push(() => ({ items: [src.ref('x.md')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    const item = store.currentItem('c1', 'x.md')!;
    expect(item.status).toBe('acl_unknown');
    expect(store.usable(item)).toBe(false);
    expect(src.reads).toBe(0); // content never read
    expect(store.chunks).toEqual([]); // nothing stored
    expect(item.contentHash).toBe('');
    expect(Object.getOwnPropertyNames(KnowledgeStore.prototype).filter((n) => /override|force|allow/i.test(n))).toEqual([]);
    src.put('x.md', 'v1', 'text', known);
    src.steps.push(() => ({ items: [src.ref('x.md')], nextCursor: 'k2' }));
    await syncConnection(store, src, 'c1');
    expect(usableIds()).toEqual(['x.md']);
    expect(src.reads).toBe(1);
    expect(store.chunks.map((c) => [c.text, c.start, c.end])).toEqual([['text', 0, 4]]);
  });

  it('readers becoming unknown at the same version drops stored content and flags citers', async () => {
    src.put('p.md', 'v1', 'secret plan');
    src.steps.push(() => ({ items: [src.ref('p.md')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    store.cite(store.currentItem('c1', 'p.md')!.id, 'answer:9');
    src.put('p.md', 'v1', 'secret plan', { status: 'unknown', reason: 'permissions call failed' });
    src.steps.push(() => ({ items: [src.ref('p.md')], nextCursor: 'k2' }));
    await syncConnection(store, src, 'c1');
    expect(store.currentItem('c1', 'p.md')!.status).toBe('acl_unknown');
    expect(store.chunks).toEqual([]);
    expect(store.flagged.get('answer:9')).toMatch(/readers unknown/);
  });

  it('a new version label with identical content is not a new version; new versions start unconfirmed', async () => {
    src.put('s.md', 'e1', 'same');
    src.steps.push(() => ({ items: [src.ref('s.md')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    const first = store.currentItem('c1', 's.md')!;
    expect(first.confirmedVersion).toBeNull();
    first.confirmedVersion = 'e1';
    store.cite(first.id, 'sop:x');
    src.put('s.md', 'e2', 'same');
    src.steps.push(() => ({ items: [src.ref('s.md')], nextCursor: 'k2' }));
    const r = await syncConnection(store, src, 'c1');
    expect(r).toMatchObject({ applied: 0, skippedDuplicates: 1 });
    expect(store.items.size).toBe(1);
    expect(store.flagged.has('sop:x')).toBe(false);
    src.put('s.md', 'e3', 'different');
    src.steps.push(() => ({ items: [src.ref('s.md')], nextCursor: 'k3' }));
    await syncConnection(store, src, 'c1');
    expect(store.currentItem('c1', 's.md')!.confirmedVersion).toBeNull();
    expect(store.chunks.filter((c) => c.itemId === first.id)).toEqual([]);
  });

  it('transient/throttled: cursor not advanced; retry de-duplicates already-applied items by content hash', async () => {
    src.put('a.md', 'v1', 'one');
    src.put('b.md', 'v1', 'two');
    store.connections.get('c1')!.cursor = 'k0';
    src.failReadOnce.add('b.md');
    src.steps.push(() => ({ items: [src.ref('a.md'), src.ref('b.md')], nextCursor: 'k1' }));
    const r1 = await syncConnection(store, src, 'c1');
    expect(r1.cursorAdvanced).toBe(false);
    expect(store.connections.get('c1')!.cursor).toBe('k0');

    src.steps.push(new SourceError('throttled', '429', 1000));
    const r2 = await syncConnection(store, src, 'c1');
    expect(r2.cursorAdvanced).toBe(false);
    expect(store.connections.get('c1')!.cursor).toBe('k0');

    src.steps.push(() => ({ items: [src.ref('a.md'), src.ref('b.md')], nextCursor: 'k1' }));
    const r3 = await syncConnection(store, src, 'c1');
    expect(r3).toMatchObject({ applied: 1, skippedDuplicates: 1, cursorAdvanced: true });
    expect(src.listCalls).toEqual(['k0', 'k0', 'k0']);
    expect([...store.items.values()].filter((i) => i.externalId === 'a.md')).toHaveLength(1);
    expect(src.reads).toBe(2); // a.md once, b.md once: the retry did not re-read a.md
    expect(store.connections.get('c1')!.cursor).toBe('k1');
  });

  it('cursor_invalid: full re-list, reconcile (missing → deleted, unchanged → duplicate), fresh cursor', async () => {
    src.put('keep.md', 'v1', 'k');
    src.put('drop.md', 'v1', 'd');
    src.steps.push(() => ({ items: [src.ref('keep.md'), src.ref('drop.md')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    src.put('new.md', 'v1', 'n');
    src.steps.push(new SourceError('cursor_invalid', 'delta token expired'));
    src.steps.push((cursor) => {
      expect(cursor).toBeUndefined();
      return { items: [src.ref('keep.md'), src.ref('new.md')], nextCursor: 'fresh' };
    });
    const r = await syncConnection(store, src, 'c1');
    expect(r).toMatchObject({ fullRelist: true, applied: 1, skippedDuplicates: 1, cursorAdvanced: true });
    expect(store.currentItem('c1', 'drop.md')!.status).toBe('deleted');
    expect(usableIds()).toEqual(['keep.md', 'new.md']);
    expect(store.connections.get('c1')!.cursor).toBe('fresh');
  });

  it('auth/scope: connection needs re-auth and every item is suspended until a successful sync', async () => {
    for (const kind of ['auth', 'scope'] as const) {
      store = new KnowledgeStore();
      store.connections.set('c1', { id: 'c1', pluginId: 'fake', scope: {}, credentialRef: 'kv', status: 'confirmed', cursor: null, confirmedBy: 'owner' });
      src = new FakeSource();
      src.put('a.md', 'v1', 'a');
      src.put('b.md', 'v1', 'b');
      src.steps.push(() => ({ items: [src.ref('a.md'), src.ref('b.md')], nextCursor: 'k1' }));
      await syncConnection(store, src, 'c1');
      store.cite(store.currentItem('c1', 'a.md')!.id, 'sop:n1');
      src.steps.push(new SourceError(kind, 'token revoked'));
      const r = await syncConnection(store, src, 'c1');
      expect(r.cursorAdvanced).toBe(false);
      expect(store.connections.get('c1')!.status).toBe('needs_reauth');
      expect([...store.items.values()].map((i) => i.status)).toEqual(['suspended', 'suspended']);
      expect(usableIds()).toEqual([]);
      expect(store.flagged.get('sop:n1')).toMatch(/re-authorisation/);
    }
  });

  it('item-level 403 revokes only that item, 404 deletes it; the connection stays confirmed', async () => {
    src.put('a.md', 'v1', 'a');
    src.put('b.md', 'v1', 'b');
    src.put('c.md', 'v1', 'c');
    src.steps.push(() => ({ items: [src.ref('a.md'), src.ref('b.md'), src.ref('c.md')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    src.put('b.md', 'v2', 'b2');
    src.put('c.md', 'v2', 'c2');
    const read = src.readItem.bind(src);
    src.readItem = async (cfg, ref) => {
      if (ref.externalId === 'b.md') throw new SourceError('scope', '403 on this file');
      if (ref.externalId === 'c.md') throw new SourceError('not_found', '404 on this file');
      return read(cfg, ref);
    };
    src.steps.push(() => ({ items: [src.ref('b.md'), src.ref('c.md')], nextCursor: 'k2' }));
    const r = await syncConnection(store, src, 'c1');
    expect(r.cursorAdvanced).toBe(true);
    expect(store.connections.get('c1')!.status).toBe('confirmed');
    expect(store.currentItem('c1', 'b.md')!.status).toBe('access_revoked');
    expect(store.currentItem('c1', 'c.md')!.status).toBe('deleted');
    expect(usableIds()).toEqual(['a.md']);
    expect(new Set(store.chunks.map((c) => c.itemId)).size).toBe(1);
  });

  it('deleting or revoking a parent cascades to its child items and drops their content', async () => {
    src.put('m1', 'v1', 'mail body');
    src.put('m1/att/a1', 'v1', 'attachment text');
    src.put('m2', 'v1', 'other');
    src.steps.push(() => ({ items: [src.ref('m1'), src.ref('m1/att/a1'), src.ref('m2')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    store.cite(store.currentItem('c1', 'm1/att/a1')!.id, 'sop:terms');
    src.steps.push(() => ({ items: [src.ref('m1', 'deleted')], nextCursor: 'k2' }));
    await syncConnection(store, src, 'c1');
    expect(store.currentItem('c1', 'm1/att/a1')!.status).toBe('deleted');
    expect(store.flagged.get('sop:terms')).toMatch(/deleted/);
    expect(usableIds()).toEqual(['m2']);
    expect(store.chunks.map((c) => c.text)).toEqual(['other']);
  });

  it('an unconfirmed connection contributes nothing to retrieval', async () => {
    store.connections.get('c1')!.status = 'pending_confirmation';
    src.put('a.md', 'v1', 'a');
    src.steps.push(() => ({ items: [src.ref('a.md')], nextCursor: 'k1' }));
    await syncConnection(store, src, 'c1');
    expect(usableIds()).toEqual([]);
  });
});

describe('local file plugin', () => {
  const files = new Map([['up', [
    { name: 'rules.md', bytes: new TextEncoder().encode('line one\n\nline three'), version: 'h1', audience: ['grp-a'] },
    { name: 'scan.pdf', bytes: new Uint8Array([37, 80, 68, 70]), version: 'h2', audience: [] },
  ]]]);
  const cfg = { connectionId: 'up', credentialRef: null, scope: {} };

  it('parses text with line anchors and reports the chosen audience as ACL', async () => {
    const p = createLocalFilePlugin(files);
    const { items } = await p.listItems(cfg);
    const c = await p.readItem(cfg, items[0]!);
    expect(c.anchors.map((a) => [c.text.slice(a.start, a.end), a.locator])).toEqual([['line one', 'rules.md#L1'], ['line three', 'rules.md#L3']]);
    expect(await p.getAcl!(cfg, items[0]!)).toEqual({ status: 'known', entries: [{ principal: 'grp-a', access: 'read' }] });
    expect((await p.getAcl!(cfg, items[1]!)).status).toBe('unknown');
  });

  it('sends PDFs to Document Intelligence and refuses without it', async () => {
    const { items } = await createLocalFilePlugin(files).listItems(cfg);
    await expect(createLocalFilePlugin(files).readItem(cfg, items[1]!)).rejects.toThrow(/Document Intelligence/);
    const seen: string[] = [];
    const p = createLocalFilePlugin(files, { parse: async (_b, n) => (seen.push(n), { text: 'x', anchors: [] }) });
    await p.readItem(cfg, items[1]!);
    expect(seen).toEqual(['scan.pdf']);
  });
});

describe('read-only database gateway', () => {
  const scope: DbScope = { tables: { invoices: { columns: ['id', 'vendor', 'amount', 'status', 'contact_email', 'created_at'], sensitive: ['contact_email'] }, vendors: { columns: ['id', 'name'] } }, audience: ['grp-finance'], maxRows: 50 };
  const ok = (sql: string, params: string[] = []) => validateTemplate({ id: 't', sql, params, approvedBy: 'owner' }, scope);
  const bad = (sql: string, re: RegExp, params: string[] = []) => expect(() => ok(sql, params)).toThrow(re);

  it('accepts approved parameterised SELECTs over allow-listed tables and columns', () => {
    expect(() => ok('SELECT id, amount, status FROM invoices WHERE vendor = $1 AND amount > $2', ['vendor', 'min'])).not.toThrow();
    expect(() => ok("SELECT count(*) AS n, sum(i.amount) AS total FROM invoices i JOIN vendors v ON v.id = i.vendor WHERE i.status = 'open' GROUP BY v.name", [])).not.toThrow();
  });

  it('rejects writes, multiple statements, comments, SELECT *, unlisted tables/columns/functions and undeclared params', () => {
    bad('UPDATE invoices SET status = 1', /only SELECT/);
    bad('SELECT id FROM invoices; DROP TABLE invoices', /multiple statements/);
    bad('SELECT id FROM invoices -- x', /comments/);
    bad('SELECT * FROM invoices', /SELECT \*/);
    bad('SELECT id FROM payroll', /payroll is not allow-listed/);
    bad('SELECT id, iban FROM invoices', /iban is not allow-listed/);
    bad('SELECT id FROM invoices WHERE iban = $1', /iban is not allow-listed/, ['x']);
    bad('SELECT pg_sleep(10) FROM invoices', /pg_sleep is not allow-listed/);
    bad('SELECT id FROM invoices WHERE amount > (SELECT max(amount) FROM pg_shadow)', /pg_shadow is not allow-listed/);
    bad('SELECT "id" FROM invoices', /quoted identifiers/);
    bad('SELECT id FROM invoices WHERE vendor = $2', /undeclared parameter/, ['a']);
  });

  it('runs inside a READ ONLY transaction with timeout and row cap; masks sensitive columns; returns a dated current fact', async () => {
    const log: string[] = [];
    const db: DbClient = {
      async query(sql) {
        log.push(sql);
        return sql.startsWith('SELECT *') ? { rows: [{ id: 1, amount: 480, contact_email: 'pat@vendor.example' }] } : { rows: [] };
      },
    };
    const fact = await runTemplate(db, { id: 'open-by-vendor', sql: 'SELECT id, amount, contact_email FROM invoices WHERE vendor = $1', params: ['vendor'], approvedBy: 'owner' }, ['acme'], scope, 'schema-7', 3000);
    expect(log[0]).toBe('BEGIN READ ONLY');
    expect(log[1]).toBe('SET LOCAL statement_timeout = 3000');
    expect(log[2]).toMatch(/LIMIT 50$/);
    expect(log[3]).toBe('COMMIT');
    expect(fact).toMatchObject({ kind: 'current_fact', rowCount: 1, schemaVersion: 'schema-7', templateId: 'open-by-vendor' });
    expect(fact.rows[0]!.contact_email).toBe('p***@vendor.example');
    expect(Date.parse(fact.queriedAt)).not.toBeNaN();
  });

  it('rolls back on error and refuses a parameter count mismatch before touching the database', async () => {
    const log: string[] = [];
    const db: DbClient = { async query(sql) { log.push(sql); if (sql.startsWith('SELECT *')) throw new Error('timeout'); return { rows: [] }; } };
    const t = { id: 't', sql: 'SELECT id FROM invoices WHERE vendor = $1', params: ['v'], approvedBy: 'o' };
    await expect(runTemplate(db, t, [], scope, 's')).rejects.toBeInstanceOf(QueryGatewayError);
    expect(log).toEqual([]);
    await expect(runTemplate(db, t, ['x'], scope, 's')).rejects.toThrow('timeout');
    expect(log.at(-1)).toBe('ROLLBACK');
  });

  it('sensitive columns: aliases are masked by lineage; expressions and filters on them are refused', async () => {
    const run = (sql: string, params: string[] = []) => {
      const db: DbClient = { async query(q) { return q.startsWith('SELECT *') ? { rows: [{ id: 1, public_alias: 'pat@vendor.example', contact_email: 'pat@vendor.example' }] } : { rows: [] }; } };
      return runTemplate(db, { id: 't', sql, params, approvedBy: 'o' }, params.map(() => 'x'), scope, 's');
    };
    const aliased = await run('SELECT id, contact_email AS public_alias FROM invoices');
    expect(aliased.rows[0]!.public_alias).toBe('p***@vendor.example');
    const qualified = await run('SELECT i.id, i.contact_email AS public_alias FROM invoices i');
    expect(qualified.rows[0]!.public_alias).toBe('p***@vendor.example');
    bad('SELECT i.contact_email public_alias FROM invoices i', /public_alias is not allow-listed/); // column aliases need AS
    expect(validateTemplate({ id: 't', sql: 'SELECT DISTINCT contact_email AS c FROM invoices', params: [], approvedBy: 'o' }, scope).maskedOutputs).toEqual(new Set(['c']));
    bad("SELECT coalesce(contact_email, '') AS label FROM invoices", /inside an expression/);
    bad('SELECT lower(contact_email) FROM invoices', /inside an expression/);
    bad('SELECT count(contact_email) AS n FROM invoices', /inside an expression/);
    bad("SELECT CASE WHEN contact_email = 'a' THEN 1 ELSE 0 END AS hit FROM invoices", /inside an expression/);
    bad('SELECT id FROM invoices WHERE contact_email = $1', /cannot be filtered/, ['e']);
    bad('SELECT id FROM invoices ORDER BY contact_email', /cannot be filtered/);
    bad('SELECT id FROM invoices WHERE id = (SELECT max(id) FROM invoices WHERE contact_email = $1)', /cannot be filtered/, ['e']);
  });

  it('column allowlists are per table: no borrowing a column name from another joined table (T-52)', async () => {
    const s2: DbScope = { tables: { invoices: { columns: ['id'] }, vendor: { columns: ['id', 'iban'] } }, audience: ['g'], maxRows: 10 };
    const v = (sql: string) => () => validateTemplate({ id: 't', sql, params: [], approvedBy: 'o' }, s2);
    expect(v('SELECT i.iban FROM invoices i JOIN vendor v ON i.id = v.id')).toThrow(/iban is not allow-listed for invoices/);
    expect(v('SELECT invoices.iban FROM invoices JOIN vendor ON invoices.id = vendor.id')).toThrow(/iban is not allow-listed for invoices/);
    expect(v('SELECT iban FROM invoices i JOIN vendor v ON i.id = v.id')).toThrow(/qualify iban/); // unqualified could resolve to invoices.iban
    expect(v('SELECT x.iban FROM invoices i JOIN vendor v ON i.id = v.id')).toThrow(/(identifier|unknown table or alias) x /);
    expect(v('SELECT v.iban FROM invoices i JOIN vendor v ON i.id = v.id')).not.toThrow();
    expect(v('SELECT id FROM invoices WHERE id = $1')).toThrow(/undeclared parameter/); // single table: unqualified is fine
    const log: string[] = [];
    const db: DbClient = { async query(q) { log.push(q); return { rows: [] }; } };
    await expect(runTemplate(db, { id: 't', sql: 'SELECT i.iban FROM invoices i JOIN vendor v ON i.id = v.id', params: [], approvedBy: 'o' }, [], s2, 's')).rejects.toBeInstanceOf(QueryGatewayError);
    expect(log).toEqual([]); // nothing reached the database
  });

  it('refuses a disabled or unbounded timeout and a non-integer row cap instead of building SQL from them', async () => {
    const log: string[] = [];
    const db: DbClient = { async query(q) { log.push(q); return { rows: [] }; } };
    const t = { id: 't', sql: 'SELECT id FROM invoices', params: [], approvedBy: 'o' };
    for (const ms of [0, -1, 1.5, 600_000, Number.NaN]) await expect(runTemplate(db, t, [], scope, 's', ms)).rejects.toThrow(/timeoutMs/);
    for (const maxRows of [0, 1.5, 5000, Number.NaN]) await expect(runTemplate(db, t, [], { ...scope, maxRows }, 's')).rejects.toThrow(/maxRows/);
    expect(log).toEqual([]); // nothing reached the database
  });

  it('masks short and email values', () => {
    expect(mask('ab')).toBe('**');
    expect(mask('secret')).toBe('s****t');
  });

  it('exposes allow-listed structure (not data) as knowledge with table.column anchors', async () => {
    const p = createDatabasePlugin(async () => ({ version: 's7', tables: { invoices: [{ column: 'amount', type: 'numeric' }, { column: 'status', type: 'text' }] } }));
    const cfg = { connectionId: 'db', credentialRef: 'kv-db', scope: scope as unknown as Record<string, unknown> };
    const { items } = await p.listItems(cfg);
    const c = await p.readItem(cfg, items[0]!);
    expect(c.anchors.map((a) => a.locator)).toEqual(['invoices.amount@schema s7', 'invoices.status@schema s7']);
    expect(await p.getAcl!(cfg, items[0]!)).toMatchObject({ status: 'known' });
  });
});
