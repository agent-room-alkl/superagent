/** Synthetic service/driver fixtures; the explicitly skipped DATABASE_URL case is the only native PostgreSQL evidence. */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { UserContext } from '@superagent/shared';
import { DatabaseGateway, postgresResource, type DatabaseResource } from '../src/modules/knowledge/database.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { KnowledgeService } from '../src/modules/knowledge/service.js';

const owner: UserContext = { tenantId: 'database-synthetic-tenant', userId: 'alice', roles: ['owner'], projectScopes: ['finance'] };
const sql = 'SELECT id, contact_email AS public_alias FROM approved_invoices WHERE status = $1';

function fixture() {
  const calls: { sql: string; params: unknown[] | undefined }[] = [];
  let schemaVersion = 'schema-1';
  let readOnly = true;
  let queryFailure = false;
  const release = vi.fn();
  const open = vi.fn(async () => ({
    client: { query: async (query: string, params?: unknown[]) => {
      calls.push({ sql: query, params });
      if (query.startsWith('SELECT * FROM (')) {
        if (queryFailure) throw new Error('synthetic query timeout');
        return { rows: [{ id: 7, public_alias: 'pat@synthetic.example', current_fact_marker: 'live-only-synthetic-value' }] };
      }
      return { rows: [] };
    } }, release,
  }));
  const resource: DatabaseResource = {
    id: 'approved-resource', name: 'DBA-approved synthetic invoices', projectIds: ['finance'],
    scope: { audience: ['alice', 'bob'], maxRows: 25, tables: { approved_invoices: { columns: ['id', 'status', 'contact_email'], sensitive: ['contact_email'] } } },
    inspect: vi.fn(async () => ({ version: schemaVersion, tables: {
      approved_invoices: [{ column: 'id', type: 'integer' }, { column: 'status', type: 'text' }, { column: 'contact_email', type: 'text' }, { column: 'unapproved_iban', type: 'text' }],
      unapproved_payroll: [{ column: 'salary', type: 'numeric' }],
    } })),
    verifyReadOnly: vi.fn(async () => readOnly), open,
  };
  const database = new DatabaseGateway([resource]);
  const repo = new MemoryKnowledgeRepository();
  const service = new KnowledgeService({ repo, database });
  async function connect() {
    const connection = await service.createConnection(owner, { name: 'Finance', pluginId: 'database', scope: { resourceId: resource.id } });
    await service.confirmConnection(owner, connection.id);
    return connection;
  }
  return { resource, database, repo, service, connect, calls, release, open,
    setSchema: (version: string) => { schemaVersion = version; },
    setReadOnly: (value: boolean) => { readOnly = value; },
    failQuery: () => { queryFailure = true; },
  };
}

describe('database KnowledgeService integration (synthetic source, real service/repository/gateway)', () => {
  it('requires connection and version confirmation, indexes approved structure only, and never stores live rows', async () => {
    const f = fixture();
    const connection = await f.service.createConnection(owner, { name: 'Finance', pluginId: 'database', scope: { resourceId: f.resource.id } });
    await expect(f.service.sync(owner, connection.id)).rejects.toMatchObject({ code: 'connection_unconfirmed' });
    await f.service.confirmConnection(owner, connection.id);
    expect(await f.service.sync(owner, connection.id)).toMatchObject({ applied: 1, cursorAdvanced: true });
    let state = await f.repo.read(owner);
    expect(state.source.items).toHaveLength(1);
    const item = state.source.items[0]!;
    expect(state.source.chunks.map(chunk => chunk.locator)).toEqual([
      'approved_invoices.id@schema schema-1', 'approved_invoices.status@schema schema-1', 'approved_invoices.contact_email@schema schema-1',
    ]);
    expect(JSON.stringify(state.source.chunks)).not.toMatch(/unapproved_iban|unapproved_payroll|live-only/);
    expect((await f.service.search(owner, 'approved_invoices')).hits).toEqual([]);
    await f.service.confirm(owner, item.id, item.version);
    expect((await f.service.search(owner, 'approved_invoices')).hits).toHaveLength(3);
    const before = await f.repo.read(owner);
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    const result = await f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] });
    expect(result).toMatchObject({ kind: 'current_fact', rowCount: 1, schemaVersion: 'schema-1', scope: 'approved_invoices' });
    expect(Number.isFinite(Date.parse(result.queriedAt))).toBe(true);
    state = await f.repo.read(owner);
    expect(state.source).toEqual(before.source);
    expect((await f.service.search(owner, 'live-only-synthetic-value')).hits).toEqual([]);
  });

  it('executes the stored approved template with bound values, read-only transaction, timeout, row cap and alias masking', async () => {
    const f = fixture(), connection = await f.connect();
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    const hostileValue = "open'; DROP TABLE approved_invoices; --";
    const result = await f.service.query(owner, connection.id, { templateId: template.id, args: [hostileValue], sql: 'DELETE FROM approved_invoices', params: ['ignored'] });
    expect(result.rows[0]!.public_alias).toBe('p***@synthetic.example');
    expect(JSON.stringify(result)).not.toContain('pat@synthetic.example');
    expect(f.calls.map(call => call.sql)).toEqual([
      'BEGIN READ ONLY', 'SET LOCAL search_path = pg_catalog, public, pg_temp', 'SET LOCAL statement_timeout = 5000', `SELECT * FROM (${sql}) AS q LIMIT 25`, 'COMMIT',
    ]);
    expect(f.calls.find(call => call.sql.startsWith('SELECT *'))!.params).toEqual([hostileValue]);
    expect(f.calls.some(call => call.sql.includes(hostileValue))).toBe(false);
    expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('refuses raw SQL, nonexistent template IDs, templates from another connection, and unconfirmed connections', async () => {
    const f = fixture(), connection = await f.connect();
    await expect(f.service.query(owner, connection.id, { sql, args: ['open'] })).rejects.toMatchObject({ code: 'template_not_approved' });
    await expect(f.service.query(owner, connection.id, { templateId: 'invented', sql, args: ['open'] })).rejects.toMatchObject({ code: 'template_not_approved' });
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    const other = await f.connect();
    await expect(f.service.query(owner, other.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'template_not_approved' });
    const draft = await f.service.createConnection(owner, { name: 'Draft', pluginId: 'database', scope: { resourceId: f.resource.id } });
    await expect(f.service.approveTemplate(owner, draft.id, { sql, params: ['status'] })).rejects.toMatchObject({ code: 'source_denied' });
    expect(f.open).not.toHaveBeenCalled();
  });

  it.each([
    'DELETE FROM approved_invoices', 'SELECT id FROM unapproved_payroll',
    'SELECT unapproved_iban FROM approved_invoices', 'SELECT lower(contact_email) FROM approved_invoices',
    'SELECT id FROM approved_invoices WHERE contact_email = $1',
    'SELECT id FROM approved_invoices; DROP TABLE approved_invoices',
  ])('rejects unauthorized SQL at approval: %s', async statement => {
    const f = fixture(), connection = await f.connect();
    await expect(f.service.approveTemplate(owner, connection.id, { sql: statement, params: ['status'] })).rejects.toMatchObject({ code: 'invalid_template' });
    expect((await f.service.templates(owner, connection.id)).templates).toEqual([]);
    expect(f.open).not.toHaveBeenCalled();
  });

  it('rejects a changed schema before opening a data connection and permits explicit reapproval', async () => {
    const f = fixture(), connection = await f.connect();
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    f.setSchema('schema-2');
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'template_stale' });
    expect(f.open).not.toHaveBeenCalled();
    const replacement = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    expect(await f.service.query(owner, connection.id, { templateId: replacement.id, args: ['open'] })).toMatchObject({ schemaVersion: 'schema-2' });
  });

  it('invalidates changed DBA scope, and reapproving identical SQL updates the durable template revision', async () => {
    const f = fixture(), connection = await f.connect();
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    f.resource.scope.maxRows = 5;
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'template_stale' });
    const replacement = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    const stored = (await f.service.templates(owner, connection.id)).templates.find(candidate => candidate.id === replacement.id)!;
    expect(stored.scopeSignature).toBe(replacement.scopeSignature);
    await expect(f.service.query(owner, connection.id, { templateId: replacement.id, args: ['open'] })).resolves.toMatchObject({ kind: 'current_fact' });
    expect(f.calls.find(call => call.sql.startsWith('SELECT *'))!.sql).toMatch(/LIMIT 5$/);
  });

  it('prevents caller JSON from expanding DBA tables, audience, row cap and project scope', async () => {
    const f = fixture();
    const connection = await f.service.createConnection(owner, { name: 'Finance', pluginId: 'database', scope: { resourceId: f.resource.id, maxRows: 9999, tables: { payroll: { columns: ['salary'] } }, projectIds: [] } });
    expect(connection.scope).toMatchObject({ maxRows: 25, projectIds: ['finance'], tables: f.resource.scope.tables });
    expect(connection.scope.tables).not.toHaveProperty('payroll');
    await expect(f.service.createConnection(owner, { name: 'Audience expansion', pluginId: 'database', scope: { resourceId: f.resource.id }, audience: ['alice', 'mallory'] })).rejects.toMatchObject({ code: 'scope_denied' });
    for (const denied of [{ ...owner, userId: 'mallory' }, { ...owner, projectScopes: [] }]) {
      expect(f.database.list(denied)).toEqual([]);
      await expect(f.service.createConnection(denied, { name: 'Bypass', pluginId: 'database', scope: { resourceId: f.resource.id } })).rejects.toMatchObject({ code: 'source_denied' });
    }
  });

  it('owner role cannot bypass connection audience, project, tenant or plugin suspension', async () => {
    const f = fixture(), connection = await f.connect();
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    for (const denied of [{ ...owner, userId: 'bob' }, { ...owner, projectScopes: [] }, { ...owner, tenantId: 'different-tenant' }]) {
      expect((await f.service.overview(denied)).connections).toEqual([]);
      await expect(f.service.templates(denied, connection.id)).rejects.toMatchObject({ code: 'source_denied' });
      await expect(f.service.query(denied, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'source_denied' });
    }
    await f.service.togglePlugin(owner, 'database', false);
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'source_denied' });
    expect(f.open).not.toHaveBeenCalled();
  });

  it('rechecks current DBA audience/project authorizations before querying a previously approved template', async () => {
    const f = fixture(), connection = await f.connect();
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    f.resource.scope.audience = ['bob'];
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'source_denied' });
    f.resource.scope.audience = ['alice']; f.resource.projectIds = ['not-granted'];
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'source_denied' });
    expect(f.open).not.toHaveBeenCalled();
  });

  it('withdraws persisted source retrieval, preview, version confirmation and query after DBA audience revocation', async () => {
    const f = fixture(), connection = await f.connect();
    await f.service.sync(owner, connection.id);
    const item = (await f.repo.read(owner)).source.items[0]!;
    await f.service.confirm(owner, item.id, item.version);
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    expect((await f.service.search(owner, 'approved_invoices')).hits.length).toBeGreaterThan(0);
    expect((await f.service.preview(owner, item.id, item.version)).chunks.length).toBeGreaterThan(0);
    f.resource.scope.audience = ['bob'];
    expect((await f.service.search(owner, 'approved_invoices')).hits).toEqual([]);
    expect((await f.service.overview(owner)).items).toEqual([]);
    await expect(f.service.preview(owner, item.id, item.version)).rejects.toMatchObject({ statusCode: expect.any(Number) });
    await expect(f.service.confirm(owner, item.id, item.version)).rejects.toMatchObject({ code: 'source_denied' });
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'source_denied' });
    expect(f.open).not.toHaveBeenCalled();
  });

  it('requires management approval, but allows an authorized employee to execute the approved template', async () => {
    const f = fixture(), connection = await f.connect();
    const employee = { ...owner, roles: ['employee'] as UserContext['roles'] };
    await expect(f.service.approveTemplate(employee, connection.id, { sql, params: ['status'] })).rejects.toMatchObject({ code: 'forbidden' });
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    await expect(f.service.query(employee, connection.id, { templateId: template.id, args: ['open'] })).resolves.toMatchObject({ kind: 'current_fact' });
  });

  it('refuses failed read-only identity verification on confirmation and again before every query', async () => {
    const f = fixture();
    const connection = await f.service.createConnection(owner, { name: 'Finance', pluginId: 'database', scope: { resourceId: f.resource.id } });
    f.setReadOnly(false);
    await expect(f.service.confirmConnection(owner, connection.id)).rejects.toMatchObject({ code: 'readonly_account_required' });
    expect((await f.repo.read(owner)).source.connections[0]!.status).toBe('draft');
    f.setReadOnly(true); await f.service.confirmConnection(owner, connection.id);
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    f.setReadOnly(false);
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'readonly_account_required' });
    expect(f.open).not.toHaveBeenCalled();
  });

  it('rolls back and releases a failed native query without modifying the knowledge source snapshot', async () => {
    const f = fixture(), connection = await f.connect();
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    const before = await f.repo.read(owner); f.failQuery();
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toThrow('synthetic query timeout');
    expect(f.calls.at(-1)!.sql).toBe('ROLLBACK'); expect(f.release).toHaveBeenCalledTimes(1);
    expect(await f.repo.read(owner)).toEqual(before);
  });

  it.each([undefined, 'open', [{}], [Number.NaN], ['x'.repeat(4001)]])('rejects invalid arguments before opening a database client: %j', async args => {
    const f = fixture(), connection = await f.connect();
    const template = await f.service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
    await expect(f.service.query(owner, connection.id, { templateId: template.id, args })).rejects.toMatchObject({ code: 'invalid_parameters' });
    expect(f.open).not.toHaveBeenCalled();
  });
});

describe('postgresResource driver adapter (injected Pool fixtures)', () => {
  function nativeFixture() {
    const query = vi.fn(async (statement: string, _params?: unknown[]) => statement.includes('information_schema.columns') ? { rows: [
      { table_name: 'approved_invoices', column_name: 'id', data_type: 'integer' },
      { table_name: 'approved_invoices', column_name: 'status', data_type: 'text' },
      { table_name: 'approved_invoices', column_name: 'hidden', data_type: 'text' },
    ] } : { rows: [{ elevated: false }] });
    const clientQuery = vi.fn(async (_statement: string, _params?: unknown[]) => ({ rows: [{ id: 1 }] }));
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query: clientQuery, release }));
    const pool = { query, connect } as unknown as Pool;
    const config = { id: 'pg-source', name: 'PG source', projectIds: [], scope: { audience: ['alice'], maxRows: 10, tables: { approved_invoices: { columns: ['id', 'status'] } } } };
    return { query, clientQuery, release, connect, pool, config, resource: postgresResource(pool, config) };
  }

  it('binds approved view names in metadata queries, filters undeclared columns and changes schema version on type drift', async () => {
    const f = nativeFixture();
    const first = await f.resource.inspect();
    expect(first.tables).toEqual({ approved_invoices: [{ column: 'id', type: 'integer' }, { column: 'status', type: 'text' }] });
    expect(f.query.mock.calls[0]![1]).toEqual([['approved_invoices']]);
    f.query.mockResolvedValueOnce({ rows: [{ table_name: 'approved_invoices', column_name: 'id', data_type: 'bigint' }, { table_name: 'approved_invoices', column_name: 'status', data_type: 'text' }] });
    expect((await f.resource.inspect()).version).not.toBe(first.version);
    f.query.mockResolvedValueOnce({ rows: [{ table_name: 'approved_invoices', column_name: 'id', data_type: 'integer' }] });
    await expect(f.resource.inspect()).rejects.toMatchObject({ code: 'schema_changed' });
  });

  it('fails closed on elevated or unavailable native role metadata and propagates inspection failure', async () => {
    const f = nativeFixture();
    expect(await f.resource.verifyReadOnly()).toBe(true);
    f.query.mockResolvedValueOnce({ rows: [{ elevated: true }] });
    expect(await f.resource.verifyReadOnly()).toBe(false);
    f.query.mockResolvedValueOnce({ rows: [] });
    expect(await f.resource.verifyReadOnly()).toBe(false);
    f.query.mockRejectedValueOnce(new Error('synthetic metadata unavailable'));
    await expect(f.resource.verifyReadOnly()).rejects.toThrow('synthetic metadata unavailable');
  });

  it('uses a dedicated checked-out native client, passes bind parameters unchanged and releases it', async () => {
    const f = nativeFixture(), opened = await f.resource.open();
    expect(await opened.client.query('SELECT id FROM approved_invoices WHERE status = $1', ['open'])).toEqual({ rows: [{ id: 1 }] });
    expect(f.clientQuery).toHaveBeenCalledWith('SELECT id FROM approved_invoices WHERE status = $1', ['open']);
    expect(f.query).not.toHaveBeenCalled();
    opened.release(); expect(f.release).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe configured relation/column identifiers before issuing native SQL', () => {
    const f = nativeFixture();
    expect(() => postgresResource(f.pool, { ...f.config, scope: { ...f.config.scope, tables: { 'public.view;drop': { columns: ['id'] } } } })).toThrow();
    expect(() => postgresResource(f.pool, { ...f.config, scope: { ...f.config.scope, tables: { safe_view: { columns: ['bad-column'] } } } })).toThrow();
    expect(f.query).not.toHaveBeenCalled();
  });

  it('pins native relation/function resolution to trusted public/pg_catalog schemas before executing approved SQL', async () => {
    const f = nativeFixture(), repo = new MemoryKnowledgeRepository(), gateway = new DatabaseGateway([f.resource]);
    const service = new KnowledgeService({ repo, database: gateway });
    const connection = await service.createConnection(owner, { name: 'Native', pluginId: 'database', scope: { resourceId: f.resource.id } });
    await service.confirmConnection(owner, connection.id);
    const template = await service.approveTemplate(owner, connection.id, { sql: 'SELECT id FROM approved_invoices', params: [] });
    await service.query(owner, connection.id, { templateId: template.id, args: [] });
    const statements = f.clientQuery.mock.calls.map(call => call[0]);
    const selectIndex = statements.findIndex(statement => statement.startsWith('SELECT * FROM ('));
    expect(statements.slice(0, selectIndex).some(statement => /^SET LOCAL search_path\s*(?:TO|=)\s*pg_catalog\s*,\s*public\b/i.test(statement))).toBe(true);
  });
});

describe.skipIf(!process.env.DATABASE_URL)('native PostgreSQL source integration (requires DATABASE_URL with CREATE DATABASE/ROLE; explicitly skipped locally when absent)', () => {
  it('uses an isolated SELECT-only role and approved row-filtered public view with native binding and masking', async () => {
    const suffix = randomUUID().replaceAll('-', '');
    const databaseName = `knowledge_dbtest_${suffix}`, roleName = `knowledge_read_${suffix}`;
    const password = randomUUID();
    const admin = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    let isolated: Pool | undefined, readOnly: Pool | undefined, createdRole = false, createdDatabase = false;
    try {
      await admin.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`); createdRole = true;
      await admin.query(`CREATE DATABASE ${databaseName}`); createdDatabase = true;
      const isolatedUrl = new URL(process.env.DATABASE_URL!); isolatedUrl.pathname = `/${databaseName}`;
      isolated = new Pool({ connectionString: isolatedUrl.href, max: 1 });
      await isolated.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
      await isolated.query('CREATE TABLE public.source_rows(id integer,status text,contact_email text,visible boolean)');
      await isolated.query("INSERT INTO public.source_rows VALUES(1,'open','pat@synthetic.example',true),(2,'open','hidden@synthetic.example',false)");
      await isolated.query('CREATE VIEW public.approved_invoices AS SELECT id,status,contact_email FROM public.source_rows WHERE visible');
      await isolated.query(`GRANT CONNECT ON DATABASE ${databaseName} TO ${roleName}`);
      await isolated.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
      await isolated.query(`GRANT SELECT ON public.approved_invoices TO ${roleName}`);
      // An adversarial session path must not redirect approved unqualified SQL away from public metadata.
      await isolated.query('CREATE SCHEMA shadow');
      await isolated.query('CREATE TABLE shadow.approved_invoices(id integer,status text,contact_email text)');
      await isolated.query("INSERT INTO shadow.approved_invoices VALUES(999,'open','shadow-secret@synthetic.example')");
      await isolated.query(`GRANT USAGE ON SCHEMA shadow TO ${roleName}`);
      await isolated.query(`GRANT SELECT ON shadow.approved_invoices TO ${roleName}`);
      const readOnlyUrl = new URL(isolatedUrl); readOnlyUrl.username = roleName; readOnlyUrl.password = password;
      readOnlyUrl.searchParams.set('options', '-c search_path=shadow,public');
      readOnly = new Pool({ connectionString: readOnlyUrl.href, max: 1 });
      const resource = postgresResource(readOnly, { id: 'native-db', name: 'Isolated native source', projectIds: ['finance'], scope: { tables: { approved_invoices: { columns: ['id', 'status', 'contact_email'], sensitive: ['contact_email'] } }, audience: ['alice'], maxRows: 5 } });
      expect(await resource.verifyReadOnly()).toBe(true);
      const service = new KnowledgeService({ repo: new MemoryKnowledgeRepository(), database: new DatabaseGateway([resource]) });
      const connection = await service.createConnection(owner, { name: 'Native view', pluginId: 'database', scope: { resourceId: resource.id } });
      await service.confirmConnection(owner, connection.id);
      await service.sync(owner, connection.id);
      const template = await service.approveTemplate(owner, connection.id, { sql, params: ['status'] });
      const fact = await service.query(owner, connection.id, { templateId: template.id, args: ['open'] });
      expect(fact.rows).toEqual([{ id: 1, public_alias: 'p***@synthetic.example' }]);
      expect((await service.search(owner, 'hidden@synthetic.example')).hits).toEqual([]);
      expect((await service.query(owner, connection.id, { templateId: template.id, args: ["open' OR true --"] })).rows).toEqual([]);
      await isolated.query(`GRANT UPDATE ON public.approved_invoices TO ${roleName}`);
      await expect(service.query(owner, connection.id, { templateId: template.id, args: ['open'] })).rejects.toMatchObject({ code: 'readonly_account_required' });
    } finally {
      await readOnly?.end(); await isolated?.end();
      if (createdDatabase) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
      if (createdRole) await admin.query(`DROP ROLE ${roleName}`);
      await admin.end();
    }
  }, 60_000);
});
