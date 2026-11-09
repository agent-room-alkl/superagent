/**
 * Sync engine implementing the PRD §3.2 sync-semantics table. Plugins only report; this engine decides.
 *   upsert          → new version parsed; old version superseded; citers flagged "evidence changed"
 *   deleted         → item removed from use; history kept
 *   access_revoked  → removed from retrieval immediately; citers flagged "evidence unavailable"
 *   ACL unknown     → listed but unusable; only a later known ACL restores it (no manual override)
 *   transient/throttled → cursor not advanced; retry; already-applied items de-duplicated by content hash
 *   cursor_invalid  → full re-list and reconcile by externalId + content hash; then new cursor
 *   auth/scope      → connection needs re-auth; every item suspended from retrieval and citation
 */
import { createHash } from 'node:crypto';
import { SourceError, type ConnectionConfig, type KnowledgeSourcePlugin, type SourceItemRef } from '@superagent/shared';
import type { Chunk, Item, KnowledgeStore } from './store.js';

export interface SyncResult {
  applied: number;
  skippedDuplicates: number;
  cursorAdvanced: boolean;
  fullRelist: boolean;
  error?: string;
}

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

export async function syncConnection(store: KnowledgeStore, plugin: KnowledgeSourcePlugin, connectionId: string): Promise<SyncResult> {
  const conn = store.connections.get(connectionId);
  if (!conn) throw new Error('unknown connection');
  const cfg: ConnectionConfig = { connectionId, credentialRef: conn.credentialRef, scope: conn.scope };
  const result: SyncResult = { applied: 0, skippedDuplicates: 0, cursorAdvanced: false, fullRelist: false };
  const prevStatus = conn.status;
  try {
    let cursor = conn.cursor ?? undefined;
    let listed: { items: SourceItemRef[]; nextCursor?: string };
    try {
      listed = await plugin.listItems(cfg, cursor);
    } catch (e) {
      if (e instanceof SourceError && e.kind === 'cursor_invalid') {
        result.fullRelist = true;
        cursor = undefined;
        listed = await relistAll(plugin, cfg);
        markMissingAsDeleted(store, connectionId, new Set(listed.items.map((i) => i.externalId)));
      } else throw e;
    }
    for (const ref of listed.items) {
      const r = await applyRef(store, plugin, cfg, ref);
      if (r === 'dup') result.skippedDuplicates++;
      else result.applied++;
    }
    conn.cursor = listed.nextCursor ?? conn.cursor;
    result.cursorAdvanced = true;
    if (prevStatus === 'needs_reauth') conn.status = 'confirmed';
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    if (e instanceof SourceError && (e.kind === 'auth' || e.kind === 'scope')) {
      conn.status = 'needs_reauth';
      for (const it of store.items.values()) {
        if (it.connectionId === connectionId && it.current && it.status === 'parsed') {
          it.status = 'suspended';
          store.flagCiters(it.id, 'source unavailable: re-authorisation required');
        }
      }
    }
    // transient / throttled / anything else: cursor stays where it was (result.cursorAdvanced = false)
    return result;
  }
}

/** Plugin contract: listItems without a cursor returns the full current snapshot plus a fresh cursor. */
async function relistAll(plugin: KnowledgeSourcePlugin, cfg: ConnectionConfig) {
  return plugin.listItems(cfg, undefined);
}

function markMissingAsDeleted(store: KnowledgeStore, connectionId: string, present: Set<string>) {
  for (const it of store.items.values()) {
    if (it.connectionId === connectionId && it.current && !present.has(it.externalId) && it.status !== 'deleted') {
      it.status = 'deleted';
      store.flagCiters(it.id, 'evidence deleted at source');
    }
  }
}

async function applyRef(store: KnowledgeStore, plugin: KnowledgeSourcePlugin, cfg: ConnectionConfig, ref: SourceItemRef): Promise<'applied' | 'dup'> {
  const existing = store.currentItem(cfg.connectionId, ref.externalId);
  if (ref.change === 'deleted') {
    if (existing && existing.status !== 'deleted') {
      existing.status = 'deleted';
      store.flagCiters(existing.id, 'evidence deleted at source');
      return 'applied';
    }
    return 'dup';
  }
  if (ref.change === 'access_revoked') {
    if (existing && existing.status !== 'access_revoked') {
      existing.status = 'access_revoked';
      store.flagCiters(existing.id, 'evidence unavailable: access revoked');
      return 'applied';
    }
    return 'dup';
  }
  const content = await plugin.readItem(cfg, ref);
  const contentHash = hash(content.text);
  const aclRes = plugin.getAcl ? await plugin.getAcl(cfg, ref) : { status: 'unknown' as const, reason: 'plugin does not report ACL' };
  const acl = aclRes.status === 'known' ? aclRes.entries : null;
  if (existing && existing.contentHash === contentHash && existing.version === ref.version) {
    // Same content (e.g. retry after a transient failure). ACL may have become known or changed.
    existing.acl = acl;
    if (existing.status === 'acl_unknown' && acl) existing.status = 'parsed';
    if (existing.status === 'parsed' && !acl) existing.status = 'acl_unknown';
    if (existing.status === 'suspended' || existing.status === 'access_revoked') existing.status = acl ? 'parsed' : 'acl_unknown';
    return 'dup';
  }
  const id = `${cfg.connectionId}:${ref.externalId}:${ref.version}`;
  if (existing) {
    existing.current = false;
    existing.status = 'superseded';
    store.flagCiters(existing.id, 'evidence changed: new version');
  }
  const item: Item = { id, connectionId: cfg.connectionId, externalId: ref.externalId, version: ref.version, title: ref.title, locator: ref.locator, contentHash, acl, status: acl ? 'parsed' : 'acl_unknown', current: true };
  store.items.set(id, item);
  store.chunks = store.chunks.filter((c) => c.itemId !== id);
  const chunks: Chunk[] = content.anchors.length
    ? content.anchors.map((a) => ({ itemId: id, text: content.text.slice(a.start, a.end), locator: a.locator }))
    : [{ itemId: id, text: content.text, locator: ref.locator }];
  store.chunks.push(...chunks);
  return 'applied';
}
