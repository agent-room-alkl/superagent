/** Synthetic connectors exercise the real registry, service, repository, sync engine and worker. */
import type { AclResult, KnowledgeSourcePlugin, SourceItemRef, UserContext } from '@superagent/shared';
import { describe, expect, it, vi } from 'vitest';
import { hash } from '../src/modules/knowledge/domain.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { parseSourceResources, type SourceResource } from '../src/modules/knowledge/sources.js';
import { tickKnowledge } from '../src/modules/knowledge/worker.js';

const owner: UserContext = { tenantId: 'source-lifecycle', userId: 'alice', roles: ['owner'], projectScopes: ['finance'] };
const known = (...principals: string[]): AclResult => ({ status: 'known', entries: principals.map(principal => ({ principal, access: 'read' })) });
const ref = (externalId: string, title: string, version = 'v1'): SourceItemRef => ({ externalId, title, version, locator: `synthetic://${externalId}/${version}`, change: 'upsert' });

function fixture(pluginId: 'email' | 'sharepoint' = 'email') {
  const resources: SourceResource[] = [{ id: 'approved-resource', name: 'Approved source', pluginId,
    scope: pluginId === 'email' ? { mailbox: 'finance@synthetic.example', folder: 'Approved', receivedSince: '2026-01-01T00:00:00.000Z' } : { driveId: 'approved-drive', folderPath: 'Approved/Finance' },
    audience: ['alice', 'bob'], projectIds: ['finance'],
  }];
  const refs = [ref('allowed-a', 'Allowed invoice procedure'), ref('forbidden-b', 'FORBIDDEN TITLE PAYROLL'), ref('unknown-c', 'UNKNOWN ACL SECRET TITLE'), ref('allowed-d', 'Another approved procedure')];
  const acls = new Map<string, AclResult>([['allowed-a', known('alice', 'bob')], ['forbidden-b', known('bob')], ['unknown-c', { status: 'unknown', reason: 'permission lookup unavailable' }], ['allowed-d', known('alice')]]);
  const bodies = new Map([['allowed-a', 'Approved invoice review procedure.'], ['allowed-d', 'Approved alternate reconciliation procedure.']]);
  const bodyReads: string[] = [], aclReads: string[] = [];
  let afterAcl: ((externalId: string) => void) | undefined;
  let cursor = 0;
  const plugin: KnowledgeSourcePlugin = {
    manifest: { id: pluginId, name: 'Synthetic scoped source', version: '1', capabilities: { incremental: true, attachments: false, liveQuery: false, acl: true }, permissions: ['read'] },
    testConnection: vi.fn(async () => ({ ok: true })),
    listItems: vi.fn(async () => ({ items: structuredClone(refs), nextCursor: `cursor-${++cursor}` })),
    getAcl: vi.fn(async (_cfg, item) => {
      aclReads.push(item.externalId);
      const result = structuredClone(acls.get(item.externalId) ?? { status: 'unknown', reason: 'missing fixture ACL' });
      afterAcl?.(item.externalId);
      return result;
    }),
    readItem: vi.fn(async (_cfg, item) => {
      bodyReads.push(item.externalId);
      const text = bodies.get(item.externalId) ?? 'FORBIDDEN BODY';
      return { text, anchors: [{ start: 0, end: text.length, locator: item.locator }] };
    }),
  };
  const repo = new MemoryKnowledgeRepository();
  const model = { check: vi.fn(async () => undefined), recommend: vi.fn(async () => []) };
  const enqueue = vi.fn(async (_ctx: UserContext, _runId: string) => undefined);
  const deps = { repo, sourceResources: resources, plugins: { [pluginId]: plugin }, model, enqueue };
  const service = new KnowledgeService(deps);
  const connectionInput = (scope: Record<string, unknown> = {}) => ({ name: 'Approved knowledge', pluginId, readOnlyAcknowledged: true, scope: { resourceId: resources[0]!.id, ...scope } });
  async function connect() {
    await service.installPlugin(owner, pluginId);
    const connection = await service.createConnection(owner, connectionInput());
    await service.confirmConnection(owner, connection.id);
    return connection;
  }
  async function importA(confirm = false) {
    const connection = await connect();
    const preview = await service.previewConnection(owner, connection.id);
    await service.importSelection(owner, connection.id, { ids: [preview.items.find(item => item.title === refs[0]!.title)!.id] });
    const item = (await repo.read(owner)).source.items.find(item => item.externalId === 'allowed-a')!;
    if (confirm) await service.confirm(owner, item.id, item.version);
    return { connection, item };
  }
  return { resources, refs, acls, bodies, bodyReads, aclReads, plugin, repo, model, enqueue, deps, service, connectionInput, connect, importA,
    afterAcl: (callback: (externalId: string) => void) => { afterAcl = callback; },
  };
}

describe('approved remote source lifecycle', () => {
  it.each(['email', 'sharepoint'] as const)('installs %s metadata without creating connections, items, employee tools or connector calls', async pluginId => {
    const f = fixture(pluginId);
    expect((await f.service.overview(owner)).plugins.find(plugin => plugin.id === pluginId)).toMatchObject({ installed: false, configured: true });
    await f.service.installPlugin(owner, pluginId);
    await f.service.installPlugin(owner, pluginId);
    const state = await f.repo.read(owner);
    expect(state.installedPlugins.filter(id => id === pluginId)).toHaveLength(1);
    expect(state.source).toMatchObject({ connections: [], items: [], chunks: [] });
    expect(state.recommendations).toEqual([]);
    expect(f.plugin.listItems).not.toHaveBeenCalled();
    expect(f.plugin.testConnection).not.toHaveBeenCalled();
    expect(f.plugin.readItem).not.toHaveBeenCalled();
  });

  it('requires explicit installation and literal read-only acknowledgement without accepting credentials or write effect', async () => {
    const f = fixture();
    await expect(f.service.createConnection(owner, f.connectionInput())).rejects.toMatchObject({ code: 'plugin_not_installed' });
    await f.service.installPlugin(owner, 'email');
    for (const readOnlyAcknowledged of [undefined, false, 'true', 1]) await expect(f.service.createConnection(owner, { ...f.connectionInput(), readOnlyAcknowledged })).rejects.toMatchObject({ code: 'read_only_acknowledgement_required' });
    for (const input of [{ credentialRef: 'postgres://raw-password@host/db' }, { effect: 'write' }, { scope: { resourceId: 'approved-resource', selectedExternalIds: ['forbidden-b'] } }, { scope: { resourceId: 'approved-resource', password: 'secret' } }]) {
      await expect(f.service.createConnection(owner, { ...f.connectionInput(), ...input })).rejects.toMatchObject({ statusCode: expect.any(Number) });
    }
    expect((await f.repo.read(owner)).source.connections).toEqual([]);
  });

  it.each(['email', 'sharepoint'] as const)('uses the %s registry scope and cannot expand audience, projects or source identifiers', async pluginId => {
    const f = fixture(pluginId);
    await f.service.installPlugin(owner, pluginId);
    const expanded = pluginId === 'email' ? [{ mailbox: 'other@synthetic.example' }, { folder: 'All mail' }, { receivedSince: '2025-01-01' }] : [{ driveId: 'other-drive' }, { folderPath: '/' }];
    for (const scope of [...expanded, { projectIds: ['payroll'] }, { resourceId: 'unknown-resource' }]) await expect(f.service.createConnection(owner, f.connectionInput(scope))).rejects.toMatchObject({ code: expect.stringMatching(/scope_denied|source_denied/) });
    await expect(f.service.createConnection(owner, { ...f.connectionInput(), audience: ['alice', 'mallory'] })).rejects.toMatchObject({ code: 'scope_denied' });
    await expect(f.service.createConnection({ ...owner, projectScopes: [] }, f.connectionInput())).rejects.toMatchObject({ code: 'source_denied' });
    await expect(f.service.createConnection({ ...owner, userId: 'mallory' }, f.connectionInput())).rejects.toMatchObject({ code: 'source_denied' });
    const narrowed = await f.service.createConnection(owner, f.connectionInput(pluginId === 'email' ? { receivedSince: '2026-02-01', projectIds: [] } : { projectIds: [] }));
    expect(narrowed.scope).toMatchObject({ ...f.resources[0]!.scope, ...(pluginId === 'email' ? { receivedSince: '2026-02-01T00:00:00.000Z' } : {}), projectIds: ['finance'], audience: ['alice'], selectedExternalIds: [] });
    if (pluginId === 'email') expect(narrowed.scope.receivedSince).toBe('2026-02-01T00:00:00.000Z');
    expect(narrowed.credentialRef).toBeNull();
  });

  it('checks each preview ACL without reading bodies or leaking denied/unknown titles and opaque identifiers', async () => {
    const f = fixture(), connection = await f.connect();
    const preview = await f.service.previewConnection(owner, connection.id);
    expect(preview.items.map(item => item.title)).toEqual(['Allowed invoice procedure', 'Another approved procedure']);
    expect(preview.blocked).toBe(2);
    expect(preview.scope).toMatchObject({ ...f.resources[0]!.scope, projectIds: ['finance'] });
    expect(preview.items.every(item => /^[a-f0-9]{64}$/.test(item.id) && item.selected === false)).toBe(true);
    expect(JSON.stringify(preview)).not.toMatch(/FORBIDDEN TITLE|UNKNOWN ACL SECRET|forbidden-b|unknown-c|FORBIDDEN BODY|externalId/);
    expect(f.aclReads).toEqual(f.refs.map(item => item.externalId));
    expect(f.bodyReads).toEqual([]);
  });

  it('rejects forged, cross-connection and stale preview IDs without reading or persisting any selection', async () => {
    const f = fixture(), connection = await f.connect(), other = await f.connect();
    const preview = await f.service.previewConnection(owner, connection.id);
    const otherPreview = await f.service.previewConnection(owner, other.id);
    const staleId = preview.items[0]!.id;
    f.refs[0]!.version = 'v2';
    for (const id of [hash(JSON.stringify([connection.id, 'forbidden-b', 'v1'])), otherPreview.items[0]!.id, staleId, 'invented']) await expect(f.service.importSelection(owner, connection.id, { ids: [id] })).rejects.toMatchObject({ code: 'source_denied' });
    const state = await f.repo.read(owner);
    expect(state.source.connections.find(c => c.id === connection.id)!.scope.selectedExternalIds).toEqual([]);
    expect(state.source.items).toEqual([]);
    expect(f.bodyReads).toEqual([]);
  });

  it('keeps connection confirmation and each imported version confirmation independent', async () => {
    const f = fixture();
    await f.service.installPlugin(owner, 'email');
    const connection = await f.service.createConnection(owner, f.connectionInput());
    const preview = await f.service.previewConnection(owner, connection.id);
    await expect(f.service.importSelection(owner, connection.id, { ids: [preview.items[0]!.id] })).rejects.toMatchObject({ code: 'connection_unconfirmed' });
    await f.service.confirmConnection(owner, connection.id);
    await f.service.importSelection(owner, connection.id, { ids: [preview.items[0]!.id] });
    expect((await f.service.search(owner, 'invoice')).hits).toEqual([]);
    await expect(f.service.startAnalysis(owner)).rejects.toMatchObject({ code: 'no_evidence' });
    const item = (await f.repo.read(owner)).source.items[0]!;
    await f.service.confirm(owner, item.id, item.version);
    expect((await f.service.search(owner, 'invoice')).hits[0]).toMatchObject({ version: 'v1', locator: 'synthetic://allowed-a/v1' });
  });

  it('imports and syncs only explicit selections, while changed selected versions await fresh confirmation', async () => {
    const f = fixture(), { connection } = await f.importA(true);
    expect(f.bodyReads).toEqual(['allowed-a']);
    f.refs[0]!.version = 'v2'; f.bodies.set('allowed-a', 'Updated invoice review procedure.');
    f.refs.push(ref('new-e', 'New unselected procedure')); f.acls.set('new-e', known('alice'));
    await f.service.sync(owner, connection.id);
    expect(f.bodyReads).toEqual(['allowed-a', 'allowed-a']);
    const state = await f.repo.read(owner);
    expect(state.source.items.filter(item => item.current).map(item => [item.externalId, item.version])).toEqual([['allowed-a', 'v2']]);
    expect((await f.service.search(owner, 'invoice')).hits).toEqual([]);
    expect((await f.service.overview(owner)).items[0]).toMatchObject({ version: 'v2', confirmed: false });
  });

  it('rechecks the actor ACL at the import body boundary and never reads an item revoked after preview validation', async () => {
    const f = fixture(), connection = await f.connect();
    const preview = await f.service.previewConnection(owner, connection.id);
    // The next sourcePreview sees the former grant, then the connector reports revocation at sync's ACL lookup.
    f.afterAcl(externalId => { if (externalId === 'allowed-a') f.acls.set(externalId, known('bob')); });
    await f.service.importSelection(owner, connection.id, { ids: [preview.items[0]!.id] });
    expect(f.bodyReads).toEqual([]);
    expect((await f.repo.read(owner)).source.chunks).toEqual([]);
    expect((await f.service.overview(owner)).items).toEqual([]);
  });

  it('denies live revoked/unknown ACL at per-version confirmation and original-body preview', async () => {
    const f = fixture(), { item } = await f.importA();
    for (const acl of [known('bob'), { status: 'unknown', reason: 'permission unavailable' } as AclResult]) {
      f.acls.set('allowed-a', acl);
      await expect(f.service.confirm(owner, item.id, item.version)).rejects.toMatchObject({ code: 'source_denied' });
      await expect(f.service.preview(owner, item.id, item.version)).rejects.toMatchObject({ code: 'source_denied' });
      expect((await f.repo.read(owner)).confirmations[item.id]).toBeUndefined();
    }
  });

  it('intersects native item ACL with connection audience for overview, search projection and body access', async () => {
    const f = fixture('sharepoint'), { connection, item } = await f.importA(true);
    const bob = { ...owner, userId: 'bob' };
    expect(f.acls.get('allowed-a')).toEqual(known('alice', 'bob'));
    expect((await f.repo.read(owner)).connectionMeta[connection.id]!.audience).toEqual(['alice']);
    expect((await f.repo.search(bob, 'invoice', 10))).toEqual([]);
    expect((await f.service.overview(bob)).items).toEqual([]);
    expect((await f.service.search(bob, 'invoice')).hits).toEqual([]);
    await expect(f.service.preview(bob, item.id, item.version)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('pausing a plugin blocks source references, preview, confirmation, sync and queued model calls', async () => {
    const f = fixture(), { connection, item } = await f.importA(true);
    await f.service.startAnalysis(owner);
    await f.service.togglePlugin(owner, 'email', false);
    expect((await f.service.search(owner, 'invoice')).hits).toEqual([]);
    expect((await f.service.overview(owner)).items).toEqual([]);
    await expect(f.service.previewConnection(owner, connection.id)).rejects.toMatchObject({ code: 'plugin_disabled' });
    await expect(f.service.confirm(owner, item.id, item.version)).rejects.toMatchObject({ code: 'source_denied' });
    await expect(f.service.sync(owner, connection.id)).rejects.toMatchObject({ code: 'plugin_disabled' });
    await tickKnowledge(f.deps, owner.tenantId);
    expect(f.model.recommend).not.toHaveBeenCalled();
  });

  it('keeps a human-created role evidence-free and editable without unlocking source analysis', async () => {
    const f = fixture();
    const manual = await f.service.createManualRole(owner, { name: '人工财务协调员', description: '人工明确的职责' });
    expect(manual).toMatchObject({ origin: 'manual', kind: 'employee', evidence: [], humanLocked: true });
    await f.service.editRecommendation(owner, manual.id, { name: '人工修订名称', description: '人工修订职责' });
    expect((await f.service.overview(owner)).recommendations[0]).toMatchObject({ name: '人工修订名称', origin: 'manual', evidence: [] });
    await expect(f.service.startAnalysis(owner)).rejects.toMatchObject({ code: 'no_evidence' });
    expect(f.enqueue).not.toHaveBeenCalled(); expect(f.model.recommend).not.toHaveBeenCalled();
  });

  it.each(['remove-resource', 'remove-audience', 'remove-project', 'change-folder'] as const)('operator policy %s withdraws references and blocks queued work before model input', async change => {
    const f = fixture(), { connection, item } = await f.importA(true);
    await f.service.startAnalysis(owner);
    if (change === 'remove-resource') f.resources.splice(0);
    if (change === 'remove-audience') f.resources[0]!.audience = ['bob'];
    if (change === 'remove-project') f.resources[0]!.projectIds.push('payroll');
    if (change === 'change-folder') f.resources[0]!.scope.folder = 'Different approved folder';
    expect((await f.service.search(owner, 'invoice')).hits).toEqual([]);
    expect((await f.service.overview(owner)).items).toEqual([]);
    await expect(f.service.previewConnection(owner, connection.id)).rejects.toMatchObject({ code: 'source_denied' });
    await expect(f.service.confirm(owner, item.id, item.version)).rejects.toMatchObject({ code: 'source_denied' });
    expect(await tickKnowledge(f.deps, owner.tenantId)).toBe(true);
    expect(f.model.recommend).not.toHaveBeenCalled();
    expect((await f.repo.read(owner)).analyses[0]).toMatchObject({ status: 'stale', error: 'source_scope_changed' });
  });
});

describe('approved source registry configuration validation', () => {
  it('accepts only supported scope keys and validated optional SharePoint folder paths', () => {
    const resource: SourceResource = { id: 'sp', name: 'Library', pluginId: 'sharepoint', scope: { driveId: 'drive' }, audience: ['alice'], projectIds: [] };
    expect(parseSourceResources(JSON.stringify([resource]))).toEqual([resource]);
    for (const folderPath of [{ token: 'secret' }, 42, null, 'x'.repeat(1001)]) expect(() => parseSourceResources(JSON.stringify([{ ...resource, scope: { driveId: 'drive', folderPath } }]))).toThrow(/Invalid KNOWLEDGE_SOURCES_JSON/);
    expect(() => parseSourceResources(JSON.stringify([{ ...resource, scope: { driveId: 'drive', credentialRef: 'raw-secret' } }]))).toThrow(/Invalid KNOWLEDGE_SOURCES_JSON/);
  });
});
