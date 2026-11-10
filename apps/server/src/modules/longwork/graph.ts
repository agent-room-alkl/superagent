import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { LongWork, MailSource } from './service.js';
import type { SecretVersion } from '../setup/secrets.js';

const ROOT = 'https://graph.microsoft.com/v1.0';
export interface GraphSource extends MailSource { clientStateRef: SecretVersion; startAt: string }
export interface GraphPorts {
  token(): Promise<string>; secret(ref: SecretVersion): Promise<string>;
  fetch?: typeof fetch; now?: () => number;
}
interface Page { value: Array<{ id: string; conversationId: string; from?: { emailAddress?: { address?: string } }; receivedDateTime: string;
  body?: { content?: string }; '@removed'?: unknown }>; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }

/** Separate from the knowledge plugin: the only writes here are subscription registration/renewal, never email. */
export class MailTrigger {
  constructor(private work: LongWork, readonly sources: GraphSource[], private callbackUrl: string, private ports: GraphPorts) {
    const u = new URL(callbackUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw Error('invalid_notification_url');
  }
  private now() { return this.ports.now?.() ?? Date.now(); }
  private resource(s: GraphSource) { return `users/${encodeURIComponent(s.mailbox)}/mailFolders/${encodeURIComponent(s.folder)}/messages`; }
  private async request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const u = new URL(url);
    if (u.origin !== 'https://graph.microsoft.com' || u.username || u.password || !u.pathname.startsWith('/v1.0/')) throw Error('invalid_graph_url');
    const r = await (this.ports.fetch ?? fetch)(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${await this.ports.token()}`, 'content-type': 'application/json', prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (r.status === 410) throw Error('graph_cursor_expired');
    if (!r.ok) throw Error(`graph_http_${r.status}`); // Response bodies may contain private data. Never propagate them to logs.
    return await r.json() as T;
  }
  async notified(notifications: Array<{ subscriptionId?: string; clientState?: string; lifecycleEvent?: string }>) {
    if (!Array.isArray(notifications) || notifications.length > 100) throw Error('invalid_notifications');
    let accepted = 0;
    for (const source of this.sources) {
      const state = await this.work.snapshot(source.tenant);
      const sub = state.sources[source.id]?.subscriptionId;
      if (!sub) continue;
      const relevant = notifications.filter(n => n.subscriptionId === sub);
      if (!relevant.length) continue;
      const secret = await this.ports.secret(source.clientStateRef);
      const expected = createHash('sha256').update(secret).digest();
      const verified = relevant.filter(n => typeof n.clientState === 'string' && timingSafeEqual(expected, createHash('sha256').update(n.clientState).digest()));
      if (!verified.length) continue;
      await this.work.store.change(source.tenant, s => {
        const saved = s.sources[source.id]; if (saved) { saved.lastScan = 0;
          if (verified.some(n => n.lifecycleEvent === 'subscriptionRemoved' || n.lifecycleEvent === 'reauthorizationRequired')) saved.expiresAt = new Date(0).toISOString(); }
      }); accepted++;
    }
    return accepted;
  }
  async tick(source: GraphSource) {
    const owner = randomUUID();
    const saved = await this.work.store.change(source.tenant, state => {
      const s = state.sources[source.id] ??= {};
      if ((s.leaseUntil ?? 0) > this.now() || (s.lastScan ?? 0) > this.now() - 60000) return null;
      s.leaseOwner = owner; s.leaseUntil = this.now() + 120000; return s;
    });
    if (!saved) return;
    try {
      if (!saved.expiresAt || Date.parse(saved.expiresAt) < this.now() + 3600000) {
        const expirationDateTime = new Date(this.now() + 2 * 86400000).toISOString();
        const renewing = saved.subscriptionId && Date.parse(saved.expiresAt ?? '') > this.now();
        const secret = await this.ports.secret(source.clientStateRef);
        if (secret.length < 24 || secret.length > 128) throw Error('invalid_client_state_secret');
        const sub = await this.request<{ id: string; expirationDateTime: string }>(renewing ? `${ROOT}/subscriptions/${encodeURIComponent(saved.subscriptionId!)}` : `${ROOT}/subscriptions`, renewing ? 'PATCH' : 'POST', renewing ? { expirationDateTime } : {
          changeType: 'created', notificationUrl: this.callbackUrl, lifecycleNotificationUrl: this.callbackUrl,
          resource: this.resource(source), expirationDateTime, clientState: secret,
        });
        if (!sub.id || !Number.isFinite(Date.parse(sub.expirationDateTime))) throw Error('invalid_subscription_response');
        await this.work.store.change(source.tenant, s => { const row = s.sources[source.id]!; if (row.leaseOwner === owner) { row.subscriptionId = sub.id; row.expiresAt = sub.expirationDateTime; } });
      }
      const base = `${ROOT}/${this.resource(source)}/delta`;
      let url = saved.cursor ?? `${base}?$select=id,conversationId,from,receivedDateTime,body`;
      for (let pages = 0; pages < 3; pages++) {
        // A stored/returned delta URL cannot expand mailbox/folder scope or route credentials elsewhere.
        const parsed = new URL(url);
        if (parsed.origin !== 'https://graph.microsoft.com' || parsed.pathname !== new URL(base).pathname) throw Error('invalid_delta_scope');
        let page: Page;
        try { page = await this.request<Page>(url); }
        catch (e) {
          if (e instanceof Error && e.message === 'graph_cursor_expired') await this.work.store.change(source.tenant, s => { if (s.sources[source.id]?.leaseOwner === owner) delete s.sources[source.id]!.cursor; });
          throw e;
        }
        if (!Array.isArray(page.value)) throw Error('invalid_delta_page');
        for (const m of page.value) if (!m['@removed'] && Date.parse(m.receivedDateTime) >= Date.parse(source.startAt)) await this.work.ingest(source, { id: m.id, threadId: m.conversationId,
          from: m.from?.emailAddress?.address ?? '', receivedAt: m.receivedDateTime, body: m.body?.content ?? '' });
        const next = page['@odata.nextLink'] ?? page['@odata.deltaLink'];
        if (!next) throw Error('missing_delta_cursor');
        const n = new URL(next); if (n.origin !== 'https://graph.microsoft.com' || n.pathname !== new URL(base).pathname || n.username || n.password) throw Error('invalid_delta_scope');
        await this.work.store.change(source.tenant, s => {
          const row = s.sources[source.id]!; if (row.leaseOwner !== owner) throw Error('scan_lease_lost'); row.cursor = next;
        });
        url = next; if (page['@odata.deltaLink']) break;
      }
      await this.work.store.change(source.tenant, s => { if (s.sources[source.id]?.leaseOwner === owner) s.sources[source.id]!.lastScan = this.now(); });
    } finally {
      await this.work.store.change(source.tenant, s => { if (s.sources[source.id]?.leaseOwner === owner) { delete s.sources[source.id]!.leaseOwner; delete s.sources[source.id]!.leaseUntil; } });
    }
  }
}
