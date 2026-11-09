import type { UserContext } from '@superagent/shared';
import { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { DatabaseGateway, postgresResource, type DatabaseResource } from '../src/modules/knowledge/database.js';

const ctx: UserContext = { tenantId: 'freshness-tenant', userId: 'alice', roles: ['owner'], projectScopes: ['finance'] };
const sql = 'SELECT id, status FROM approved_invoices';

function fixture() {
  let revision: string | null = 'source-revision-1';
  let schemaVersion = 'schema-1';
  let status = 'open';
  let readOnly = true;
  let duringSelect: (() => void) | undefined;
  let checkedOut = false;
  const release = vi.fn(() => { checkedOut = false; });
  const resource: DatabaseResource = {
    id: 'invoices', name: 'Approved invoices', projectIds: ['finance'],
    scope: { audience: ['alice'], maxRows: 10, tables: { approved_invoices: { columns: ['id', 'status'] } } },
    inspect: async () => ({ version: schemaVersion, tables: { approved_invoices: [{ column: 'id', type: 'integer' }, { column: 'status', type: 'text' }] } }),
    verifyReadOnly: async () => readOnly,
    factRevision: vi.fn(async () => {
      // A one-client production pool cannot serve the signal until the query client has been released.
      if (checkedOut) throw new Error('query client must be released before revision read');
      return revision;
    }),
    open: async () => {
      checkedOut = true;
      return { release, client: { query: async (statement: string) => {
        if (!statement.startsWith('SELECT * FROM (')) return { rows: [] };
        const rows = [{ id: 7, status }];
        duringSelect?.();
        return { rows };
      } } };
    },
  };
  const gateway = new DatabaseGateway([resource]);
  const scope = gateway.scope(ctx, { resourceId: resource.id });
  const approve = (connectionId = 'connection-1') => gateway.approve(ctx, connectionId, scope, { sql, params: [] });
  return { resource, gateway, scope, approve, release,
    setRevision: (value: string | null) => { revision = value; },
    updateRow: () => { status = 'paid'; revision = 'source-revision-2'; },
    changeSchema: () => { schemaVersion = 'schema-2'; },
    setReadOnly: (value: boolean) => { readOnly = value; },
    duringSelect: (callback: () => void) => { duringSelect = callback; },
  };
}

describe('database current-fact revisions (synthetic source with real gateway)', () => {
  it('returns an opaque stable revision and releases the query client before the second source capture', async () => {
    const f = fixture(), template = await f.approve();
    const result = await f.gateway.run(ctx, f.scope, template, []);
    expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.revision).not.toContain('source-revision');
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.resource.factRevision).toHaveBeenCalledTimes(2);
    expect(await f.gateway.freshness(ctx, f.scope, template, result.revision)).toEqual({ fresh: true });
  });

  it('expires facts after a row update and reads the new value on the next query without changing schema metadata', async () => {
    const f = fixture(), template = await f.approve();
    const beforeSchema = await f.resource.inspect();
    const old = await f.gateway.run(ctx, f.scope, template, []);
    f.updateRow();
    expect(await f.gateway.freshness(ctx, f.scope, template, old.revision)).toEqual({ fresh: false, reason: 'source_changed' });
    const current = await f.gateway.run(ctx, f.scope, template, []);
    expect(old.rows).toEqual([{ id: 7, status: 'open' }]);
    expect(current.rows).toEqual([{ id: 7, status: 'paid' }]);
    expect(current.revision).not.toEqual(old.revision);
    expect(await f.resource.inspect()).toEqual(beforeSchema);
    expect(await f.gateway.freshness(ctx, f.scope, template, current.revision)).toEqual({ fresh: true });
  });

  it('does not attest to a result when the source changes during query execution', async () => {
    const f = fixture(), template = await f.approve();
    f.duringSelect(f.updateRow);
    const result = await f.gateway.run(ctx, f.scope, template, []);
    expect(result.revision).toBeNull();
    expect(await f.gateway.freshness(ctx, f.scope, template, result.revision)).toEqual({ fresh: false, reason: 'revision_unavailable' });
  });

  it.each(['absent', 'null', 'unavailable'] as const)('fails closed when the source revision provider is %s', async mode => {
    const f = fixture(), template = await f.approve();
    if (mode === 'absent') delete f.resource.factRevision;
    if (mode === 'null') f.setRevision(null);
    if (mode === 'unavailable') f.resource.factRevision = async () => { throw new Error('source unavailable'); };
    const result = await f.gateway.run(ctx, f.scope, template, []);
    expect(result.revision).toBeNull();
    expect(await f.gateway.freshness(ctx, f.scope, template, 'forged-revision')).toEqual({ fresh: false, reason: 'revision_unavailable' });
  });

  it('binds the revision to the connection, approved template and tenant context', async () => {
    const f = fixture(), template = await f.approve();
    const result = await f.gateway.run(ctx, f.scope, template, []);
    const otherConnection = await f.approve('connection-2');
    const otherTemplate = await f.gateway.approve(ctx, template.connectionId, f.scope, { sql: 'SELECT id FROM approved_invoices', params: [] });
    expect((await f.gateway.freshness(ctx, f.scope, otherConnection, result.revision)).fresh).toBe(false);
    expect((await f.gateway.freshness(ctx, f.scope, otherTemplate, result.revision)).fresh).toBe(false);
    expect((await f.gateway.freshness({ ...ctx, tenantId: 'other-tenant' }, f.scope, template, result.revision)).fresh).toBe(false);
    expect((await f.gateway.freshness(ctx, f.scope, template, 'forged-revision')).fresh).toBe(false);
  });

  it('rechecks approval, SQL allowlists, source permission, schema and read-only identity before attesting freshness', async () => {
    const f = fixture(), template = await f.approve();
    const result = await f.gateway.run(ctx, f.scope, template, []);
    await expect(f.gateway.freshness(ctx, f.scope, { ...template, approvedBy: '' }, result.revision)).rejects.toMatchObject({ code: 'template_not_approved' });
    await expect(f.gateway.freshness(ctx, f.scope, { ...template, sql: 'DELETE FROM approved_invoices' }, result.revision)).rejects.toMatchObject({ code: 'invalid_template' });
    await expect(f.gateway.freshness({ ...ctx, projectScopes: [] }, f.scope, template, result.revision)).rejects.toMatchObject({ code: 'source_denied' });
    f.setReadOnly(false);
    await expect(f.gateway.freshness(ctx, f.scope, template, result.revision)).rejects.toMatchObject({ code: 'readonly_account_required' });
    f.setReadOnly(true); f.changeSchema();
    await expect(f.gateway.freshness(ctx, f.scope, template, result.revision)).rejects.toMatchObject({ code: 'template_stale' });
  });

  it('rechecks source scope after an asynchronous revision read', async () => {
    const f = fixture(), template = await f.approve();
    const result = await f.gateway.run(ctx, f.scope, template, []);
    f.resource.factRevision = async () => { f.resource.projectIds.push('restricted'); return 'source-revision-1'; };
    await expect(f.gateway.freshness(ctx, f.scope, template, result.revision)).rejects.toMatchObject({ code: 'source_denied' });
  });
});

describe('native PostgreSQL snapshot revision adapter (injected Pool)', () => {
  it('uses a catalog-qualified conservative snapshot signal and returns only an opaque hash', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ revision: '100:102:101' }] }).mockResolvedValueOnce({ rows: [{ revision: '100:102:101' }] }).mockResolvedValueOnce({ rows: [{ revision: '100:103:101' }] }).mockResolvedValueOnce({ rows: [] });
    const resource = postgresResource({ query } as unknown as Pool, { id: 'native', name: 'Native source', projectIds: [], scope: { audience: ['alice'], maxRows: 10, tables: { approved_invoices: { columns: ['id'] } } } });
    const first = await resource.factRevision!();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain('100:102');
    expect(await resource.factRevision!()).toEqual(first);
    expect(await resource.factRevision!()).not.toEqual(first);
    expect(await resource.factRevision!()).toBeNull();
    expect(query.mock.calls.every(([statement]) => statement === 'SELECT pg_catalog.pg_current_snapshot()::text AS revision')).toBe(true);
  });
});
