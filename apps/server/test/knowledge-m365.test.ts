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
    g.on(/token=t1/, {
      value: [
        { id: 'i2', deleted: { state: 'deleted' } },
        { id: 'i1', name: 'approval.md', file: {}, cTag: 'c1', webUrl: 'https://sp.example/Policies/approval.md', parentReference: parent('/Policies') },
      ],
      '@odata.deltaLink': `${GRAPH}/drives/drv1/root/delta?token=t2`,
    });
    g.on(/\/items\/i1\/permissions$/, { value: [{ roles: ['read'], grantedToV2: { user: { id: 'user-oid-1' } } }] });
    const r = await syncConnection(store, plugin, 'sp');
    expect(r.skippedDuplicates).toBe(1); // same content hash
    expect(store.currentItem('sp', 'i2')!.status).toBe('deleted');
    expect(store.currentItem('sp', 'i1')!.acl!.map((e) => e.principal)).toEqual(['user-oid-1']);
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
