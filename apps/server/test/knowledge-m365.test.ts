/**
 * Contract tests for the Microsoft Graph knowledge plugins against a stubbed Graph (no tenant needed).
 * Each test drives the real sync engine, so the PRD §3.2 semantics are checked end to end.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { KnowledgeStore } from '../src/modules/knowledge/store.js';
import { syncConnection } from '../src/modules/knowledge/sync.js';
import { createMailPlugin } from '../src/modules/knowledge/plugins/mail.js';
import { createSharePointPlugin, inFolder, permissionsToAcl } from '../src/modules/knowledge/plugins/sharepoint.js';
import { GRAPH } from '../src/modules/knowledge/plugins/graph.js';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import type { UserContext } from '@superagent/shared';

type Handler = (url: URL, headers: Headers) => Response;

class FakeGraph {
  routes: [RegExp, Handler][] = [];
  calls: { method: string; url: string; prefer: string | null; auth: string | null }[] = [];
  on(re: RegExp, h: Handler | object, status = 200) {
    this.routes.unshift([re, typeof h === 'function' ? (h as Handler) : () => Response.json(h, { status })]);
    return this;
  }
  fail(re: RegExp, status: number, code = '', headers: Record<string, string> = {}) {
    return this.on(re, () => Response.json({ error: { code, message: 'stub' } }, { status, headers }));
  }
  fetchFn = (async (input: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    this.calls.push({ method: init?.method ?? 'GET', url: input, prefer: h.get('prefer'), auth: h.get('authorization') });
    const u = new URL(input);
    const r = this.routes.find(([re]) => re.test(u.pathname + u.search));
    if (!r) return Response.json({ error: { code: 'itemNotFound' } }, { status: 404 });
    return r[1](u, h);
  }) as typeof fetch;
}

const deps = (g: FakeGraph) => ({ getToken: async () => 'app-token', fetchFn: g.fetchFn });
let store: KnowledgeStore;
const addConn = (id: string, pluginId: string, scope: Record<string, unknown>) =>
  store.connections.set(id, { id, pluginId, scope, credentialRef: 'kv-graph-cert', status: 'confirmed', cursor: null, confirmedBy: 'owner' });
const usable = () => [...store.items.values()].filter((i) => store.usable(i)).map((i) => i.externalId).sort();
const b64 = (s: string) => Buffer.from(s).toString('base64');

beforeEach(() => {
  store = new KnowledgeStore();
});

describe('mail plugin (Graph messages/delta)', () => {
  const scope = { mailbox: 'ap@contoso.example', folder: 'inbox', receivedSince: '2026-01-01', audience: ['grp-ap'] };
  const MSG_DELTA = /\/users\/ap%40contoso\.example\/mailFolders\/inbox\/messages\/delta/;

  function graphWithTwoMessages() {
    return new FakeGraph()
      .on(MSG_DELTA, {
        value: [
          { id: 'm1', subject: 'Invoice 480', receivedDateTime: '2026-03-01T00:00:00Z', changeKey: 'ck1', hasAttachments: true, webLink: 'https://outlook.example/m1' },
          { id: 'm2', subject: 'Re: terms', receivedDateTime: '2026-03-02T00:00:00Z', changeKey: 'ck1', hasAttachments: false, webLink: 'https://outlook.example/m2' },
        ],
        '@odata.deltaLink': `${GRAPH}/users/ap%40contoso.example/mailFolders/inbox/messages/delta?$deltatoken=d1`,
      })
      .on(/\/messages\/m1\/attachments\?/, {
        value: [
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'terms.txt', size: 10, lastModifiedDateTime: '2026-03-01T00:00:00Z' },
          { '@odata.type': '#microsoft.graph.itemAttachment', id: 'a2', name: 'forwarded message' },
        ],
      })
      .on(/\/messages\/m1\/attachments\/a1$/, { id: 'a1', name: 'terms.txt', contentBytes: b64('Net 30 days\nLate fee 2%') })
      .on(/\/messages\/m1\?/, { subject: 'Invoice 480', from: { emailAddress: { address: 'vendor@example.com' } }, receivedDateTime: '2026-03-01', body: { content: 'Please pay 480.00' } })
      .on(/\/messages\/m2\?/, { subject: 'Re: terms', body: { content: 'Agreed' } });
  }

  it('reads messages and file attachments as child items, read-only, within the date range', async () => {
    const g = graphWithTwoMessages();
    const plugin = createMailPlugin(deps(g));
    addConn('mail', 'm365-mail', scope);
    const r = await syncConnection(store, plugin, 'mail');
    expect(r).toMatchObject({ applied: 3, cursorAdvanced: true });
    expect(usable()).toEqual(['m1', 'm1/att/a1', 'm2']);
    expect(g.calls.every((c) => c.method === 'GET' && c.auth === 'Bearer app-token')).toBe(true);
    expect(g.calls[0]!.url).toContain('$filter=receivedDateTime+ge+2026-01-01T00:00:00.000Z');
    expect(store.chunks.find((c) => c.text === 'Late fee 2%')!.locator).toBe('terms.txt#L2');
    expect(store.chunks.find((c) => c.text === 'Please pay 480.00')!.locator).toMatch(/^https:\/\/outlook\.example\/m1 #L5$/);
    expect(plugin.manifest.permissions.join(' ')).not.toMatch(/Mail\.Send|ReadWrite/);
    expect(store.connections.get('mail')!.cursor).toContain('$deltatoken=d1');
  });

  it('a removed message takes its attachments with it; citers are flagged', async () => {
    const g = graphWithTwoMessages();
    const plugin = createMailPlugin(deps(g));
    addConn('mail', 'm365-mail', scope);
    await syncConnection(store, plugin, 'mail');
    store.cite(store.currentItem('mail', 'm1/att/a1')!.id, 'sop:payment-terms');
    g.on(/\$deltatoken=d1/, { value: [{ id: 'm1', '@removed': { reason: 'deleted' } }], '@odata.deltaLink': `${GRAPH}/users/x/messages/delta?$deltatoken=d2` });
    await syncConnection(store, plugin, 'mail');
    expect(usable()).toEqual(['m2']);
    expect(store.currentItem('mail', 'm1/att/a1')!.status).toBe('deleted');
    expect(store.flagged.get('sop:payment-terms')).toMatch(/deleted/);
  });

  it('no confirmed audience → ACL unknown → nothing usable', async () => {
    addConn('mail', 'm365-mail', { ...scope, audience: [] });
    await syncConnection(store, createMailPlugin(deps(graphWithTwoMessages())), 'mail');
    expect(store.items.size).toBe(3);
    expect(usable()).toEqual([]);
  });

  it('410 on the delta token → full re-list from the start URL and reconcile', async () => {
    const g = graphWithTwoMessages();
    const plugin = createMailPlugin(deps(g));
    addConn('mail', 'm365-mail', scope);
    await syncConnection(store, plugin, 'mail');
    g.on(MSG_DELTA, { value: [{ id: 'm2', subject: 'Re: terms', changeKey: 'ck1', hasAttachments: false }], '@odata.deltaLink': `${GRAPH}/users/x/messages/delta?$deltatoken=fresh` });
    g.fail(/\$deltatoken=d1/, 410, 'SyncStateNotFound'); // registered last → matched first
    const r = await syncConnection(store, plugin, 'mail');
    expect(r.fullRelist).toBe(true);
    expect(usable()).toEqual(['m2']);
    expect(store.connections.get('mail')!.cursor).toContain('fresh');
  });

  it('429 → throttled: cursor stays; 401 → auth and 403 → scope: re-auth needed and every item suspended', async () => {
    for (const [status, code, expected] of [[429, 'TooManyRequests', 'confirmed'], [401, 'InvalidAuthenticationToken', 'needs_reauth'], [403, 'ErrorAccessDenied', 'needs_reauth']] as const) {
      store = new KnowledgeStore();
      const g = graphWithTwoMessages();
      const plugin = createMailPlugin(deps(g));
      addConn('mail', 'm365-mail', scope);
      await syncConnection(store, plugin, 'mail');
      const before = store.connections.get('mail')!.cursor;
      g.fail(/\$deltatoken=d1/, status, code, { 'retry-after': '3' });
      const r = await syncConnection(store, plugin, 'mail');
      expect(r.cursorAdvanced).toBe(false);
      expect(store.connections.get('mail')!.cursor).toBe(before);
      expect(store.connections.get('mail')!.status).toBe(expected);
      expect(usable()).toEqual(expected === 'confirmed' ? ['m1', 'm1/att/a1', 'm2'] : []);
    }
  });
});

describe('SharePoint plugin (Graph drive delta)', () => {
  const scope = { driveId: 'drv1', folderPath: '/Policies' };
  const DRIVE_DELTA = /\/drives\/drv1\/root\/delta/;
  const parent = (p: string) => ({ path: `/drives/drv1/root:${p}`, siteId: 'site1' });
  const perms = {
    value: [
      { roles: ['read'], grantedToV2: { user: { id: 'user-oid-1' } } },
      { roles: ['write'], grantedToV2: { group: { id: 'grp-finance' } } },
      { roles: ['read'], grantedToV2: { siteGroup: { id: '5' } } },
      { roles: ['read'], link: { scope: 'organization' } },
    ],
  };

  function graph() {
    return new FakeGraph()
      .on(DRIVE_DELTA, {
        value: [
          { id: 'f-root', name: 'Policies', folder: {}, parentReference: parent('') },
          { id: 'i1', name: 'approval.md', file: {}, cTag: 'c1', webUrl: 'https://sp.example/Policies/approval.md', parentReference: parent('/Policies') },
          { id: 'i2', name: 'travel.txt', file: {}, cTag: 'c1', webUrl: 'https://sp.example/Policies/HR/travel.txt', parentReference: parent('/Policies/HR') },
          { id: 'i3', name: 'other.txt', file: {}, cTag: 'c1', webUrl: 'https://sp.example/Other/other.txt', parentReference: parent('/Other') },
        ],
        '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t1`,
      })
      .on(/\/items\/i1\/content$/, () => new Response('Approve under 500\nEscalate above 500'))
      .on(/\/items\/i2\/content$/, () => new Response('Economy class only'))
      .on(/\/items\/i[12]\/permissions$/, perms);
  }

  it('reads files under the folder with original links and item ACLs (users, groups, site groups, org links)', async () => {
    const g = graph();
    addConn('sp', 'm365-sharepoint', scope);
    await syncConnection(store, createSharePointPlugin(deps(g)), 'sp');
    expect(usable()).toEqual(['i1', 'i2']);
    const i1 = store.currentItem('sp', 'i1')!;
    expect(i1.locator).toBe('https://sp.example/Policies/approval.md');
    expect(i1.acl!.map((e) => e.principal)).toEqual(['user-oid-1', 'grp-finance', 'sp-group:site1:5', 'org:all']);
    expect(store.chunks.find((c) => c.text === 'Escalate above 500')!.locator).toBe('https://sp.example/Policies/approval.md#L2');
    expect(g.calls.find((c) => DRIVE_DELTA.test(c.url))!.prefer).toMatch(/deltashowremovedasdeleted.*deltashowsharingchanges/);
    expect(g.calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('deleted facet → deleted; sharing change → ACL refreshed without a content change', async () => {
    const g = graph();
    const plugin = createSharePointPlugin(deps(g));
    addConn('sp', 'm365-sharepoint', scope);
    await syncConnection(store, plugin, 'sp');
    g.on(DRIVE_DELTA, {
      value: [{ id: 'i1', name: 'approval.md', file: {}, cTag: 'c1', webUrl: 'https://sp.example/Policies/approval.md', parentReference: parent('/Policies') }],
      '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t2`,
    });
    g.on(/token=t1/, {
      value: [
        { id: 'i2', deleted: { state: 'deleted' } },
        { id: 'i1', name: 'approval.md', file: {}, cTag: 'c1', webUrl: 'https://sp.example/Policies/approval.md', parentReference: parent('/Policies') },
      ],
      '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t2`,
    });
    g.on(/\/items\/i1\/permissions$/, { value: [{ roles: ['read'], grantedToV2: { user: { id: 'user-oid-1' } } }] });
    const r = await syncConnection(store, plugin, 'sp');
    expect(r.fullRelist).toBe(true); // The deletion has no item kind, so reconcile possible folder descendants too.
    expect(r.skippedDuplicates).toBe(1); // same content hash
    expect(store.currentItem('sp', 'i2')!.status).toBe('deleted');
    expect(store.currentItem('sp', 'i1')!.acl!.map((e) => e.principal)).toEqual(['user-oid-1']);
  });

  it('withdraws moved-out selected files without exposing outside titles and requires confirmation after a same-version move back', async () => {
    const g = graph(), plugin = createSharePointPlugin(deps(g));
    const ctx: UserContext = { tenantId: 'sp-move-fixture', userId: 'user-oid-1', roles: ['owner'], projectScopes: [] };
    const repo = new MemoryKnowledgeRepository();
    const service = new KnowledgeService({ repo, plugins: { sharepoint: plugin }, sourceResources: [{ id: 'policies', name: 'Approved policies', pluginId: 'sharepoint', scope, audience: [ctx.userId], projectIds: [] }] });
    g.on(/\/drives\/drv1\?\$select=/, { id: 'drv1', name: 'Approved library' });
    await service.installPlugin(ctx, 'sharepoint');
    const connection = await service.createConnection(ctx, { name: 'Policies', pluginId: 'sharepoint', readOnlyAcknowledged: true, scope: { resourceId: 'policies' } });
    await service.confirmConnection(ctx, connection.id);
    const initialPreview = await service.previewConnection(ctx, connection.id);
    expect(initialPreview.items.map(item => item.title)).toEqual(['approval.md', 'travel.txt']);
    expect(JSON.stringify(initialPreview)).not.toContain('other.txt');
    const selected = initialPreview.items.find(item => item.title === 'approval.md')!;
    await service.importSelection(ctx, connection.id, { ids: [selected.id] });
    const original = (await repo.read(ctx)).source.items.find(item => item.externalId === 'i1')!;
    await service.confirm(ctx, original.id, original.version);
    expect((await service.search(ctx, 'Approve')).hits).toHaveLength(1);
    await repo.transact(ctx, state => { state.source.citations.push([original.id, ['answer:moved-policy']]); });
    const contentCalls = () => g.calls.filter(call => /\/items\/i1\/content$/.test(call.url)).length;
    expect(contentCalls()).toBe(1);

    const outside = { id: 'i1', name: 'OUTSIDE SECRET TITLE.md', file: {}, cTag: 'c1', webUrl: 'https://sp.example/Outside/SECRET', parentReference: parent('/Outside') };
    g.on(DRIVE_DELTA, { value: [outside], '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t2` });
    const withdrawal = await service.sync(ctx, connection.id);
    expect(withdrawal).toMatchObject({ applied: 1, cursorAdvanced: true });
    let state = await repo.read(ctx);
    expect(state.source.items.find(item => item.id === original.id)).toMatchObject({ status: 'access_revoked' });
    expect(state.source.chunks.filter(chunk => chunk.itemId === original.id)).toEqual([]);
    expect(state.confirmations[original.id]).toBeUndefined();
    expect(state.source.flagged).toContainEqual(['answer:moved-policy', expect.stringMatching(/access revoked/)]);
    expect((await service.search(ctx, 'Approve')).hits).toEqual([]);
    const outsidePreview = await service.previewConnection(ctx, connection.id);
    expect(outsidePreview.items).toEqual([]);
    expect(outsidePreview.blocked).toBe(1);
    expect(JSON.stringify(outsidePreview)).not.toMatch(/OUTSIDE SECRET TITLE|https:\/\/sp\.example\/Outside\/SECRET/);
    expect(contentCalls()).toBe(1);

    g.on(DRIVE_DELTA, { value: [{ id: 'i1', name: 'approval.md', file: {}, cTag: 'c1', webUrl: original.locator, parentReference: parent('/Policies') }], '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t3` });
    await service.sync(ctx, connection.id);
    state = await repo.read(ctx);
    const restored = state.source.items.find(item => item.current && item.externalId === 'i1')!;
    expect(restored).toMatchObject({ status: 'parsed', version: 'c1' });
    expect(contentCalls()).toBe(2);
    expect(state.source.chunks.some(chunk => chunk.itemId === restored.id && chunk.text === 'Approve under 500')).toBe(true);
    expect((await service.search(ctx, 'Approve')).hits).toEqual([]);
    expect((await service.overview(ctx)).items[0]).toMatchObject({ confirmed: false });
    await service.confirm(ctx, restored.id, restored.version);
    expect((await service.search(ctx, 'Approve')).hits).toHaveLength(1);
  });

  it('reconciles a folder-only move delta once and withdraws omitted selected descendants from references and storage', async () => {
    const g = graph(), plugin = createSharePointPlugin(deps(g));
    const ctx: UserContext = { tenantId: 'sp-folder-move-fixture', userId: 'user-oid-1', roles: ['owner'], projectScopes: [] };
    const repo = new MemoryKnowledgeRepository();
    const service = new KnowledgeService({ repo, plugins: { sharepoint: plugin }, sourceResources: [{ id: 'policies', name: 'Approved policies', pluginId: 'sharepoint', scope, audience: [ctx.userId], projectIds: [] }] });
    g.on(/\/drives\/drv1\?\$select=/, { id: 'drv1', name: 'Approved library' });
    await service.installPlugin(ctx, 'sharepoint');
    const connection = await service.createConnection(ctx, { name: 'Policies', pluginId: 'sharepoint', readOnlyAcknowledged: true, scope: { resourceId: 'policies' } });
    await service.confirmConnection(ctx, connection.id);
    const preview = await service.previewConnection(ctx, connection.id);
    await service.importSelection(ctx, connection.id, { ids: [preview.items.find(item => item.title === 'approval.md')!.id] });
    const item = (await repo.read(ctx)).source.items.find(item => item.externalId === 'i1')!;
    await service.confirm(ctx, item.id, item.version);
    await repo.transact(ctx, state => { state.source.citations.push([item.id, ['answer:folder-child']]); });
    expect((await service.search(ctx, 'Approve')).hits).toHaveLength(1);

    // The subsequent full snapshot still contains a folder: only a supplied incremental cursor triggers relisting.
    g.on(DRIVE_DELTA, { value: [{ id: 'f-root', name: 'Policies', folder: {}, parentReference: parent('') }], '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t3` });
    g.on(/token=t1/, { value: [{ id: 'moved-folder', name: 'OUTSIDE FOLDER TITLE', folder: {}, parentReference: parent('/Outside') }], '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t2` });
    const beforeCalls = g.calls.length;
    const result = await service.sync(ctx, connection.id);
    expect(result).toMatchObject({ fullRelist: true, cursorAdvanced: true });
    const deltaCalls = g.calls.slice(beforeCalls).filter(call => DRIVE_DELTA.test(call.url));
    expect(deltaCalls).toHaveLength(2);
    expect(deltaCalls[0]!.url).toContain('token=t1');
    expect(deltaCalls[1]!.url).not.toContain('token=');
    const state = await repo.read(ctx);
    expect(state.source.items.find(source => source.id === item.id)).toMatchObject({ status: 'deleted', contentHash: '', confirmedVersion: null });
    expect(state.source.chunks.filter(chunk => chunk.itemId === item.id)).toEqual([]);
    expect(state.confirmations[item.id]).toBeUndefined();
    expect(state.source.flagged).toContainEqual(['answer:folder-child', expect.stringMatching(/deleted/)]);
    expect((await service.search(ctx, 'Approve')).hits).toEqual([]);
    expect((await service.overview(ctx)).items).toEqual([]);
    expect(state.source.connections[0]!.cursor).toContain('token=t3');
  });

  it('anonymous link → ACL unknown → unusable', () => {
    expect(permissionsToAcl([{ link: { scope: 'anonymous' } }, { grantedToV2: { user: { id: 'u' } } }], 's').status).toBe('unknown');
    expect(permissionsToAcl([], 's').status).toBe('unknown');
  });

  it('403 on one file revokes only that file; the connection stays confirmed', async () => {
    const g = graph();
    const plugin = createSharePointPlugin(deps(g));
    addConn('sp', 'm365-sharepoint', scope);
    await syncConnection(store, plugin, 'sp');
    store.cite(store.currentItem('sp', 'i2')!.id, 'answer:7');
    g.on(/token=t1/, {
      value: [{ id: 'i2', name: 'travel.txt', file: {}, cTag: 'c2', webUrl: 'https://sp.example/Policies/HR/travel.txt', parentReference: parent('/Policies/HR') }],
      '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t2`,
    });
    g.fail(/\/items\/i2\/content$/, 403, 'accessDenied');
    const r = await syncConnection(store, plugin, 'sp');
    expect(r.cursorAdvanced).toBe(true);
    expect(store.connections.get('sp')!.status).toBe('confirmed');
    expect(store.currentItem('sp', 'i2')!.status).toBe('access_revoked');
    expect(store.flagged.get('answer:7')).toMatch(/access revoked/);
    expect(usable()).toEqual(['i1']);
  });

  it('a stored cursor that is not a Graph URL is treated as invalid and triggers a full re-list', async () => {
    const g = graph();
    addConn('sp', 'm365-sharepoint', scope);
    store.connections.get('sp')!.cursor = 'https://evil.example/steal';
    const r = await syncConnection(store, createSharePointPlugin(deps(g)), 'sp');
    expect(r.fullRelist).toBe(true);
    expect(g.calls.some((c) => c.url.startsWith('https://evil.example'))).toBe(false);
    expect(usable()).toEqual(['i1', 'i2']);
  });

  it('folder scoping by parentReference.path', () => {
    const it = (p: string) => ({ id: 'x', parentReference: { path: `/drives/d/root:${p}` } });
    expect(inFolder(it('/Policies'), '/Policies')).toBe(true);
    expect(inFolder(it('/Policies/HR'), 'Policies/')).toBe(true);
    expect(inFolder(it('/PoliciesOld'), '/Policies')).toBe(false);
    expect(inFolder(it('/Other'), undefined)).toBe(true);
  });
});
