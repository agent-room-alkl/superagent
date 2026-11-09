/**
 * Sync engine implementing the PRD §3.2 sync-semantics table. Plugins only report; this engine decides.
 *   upsert          → new version parsed; old version superseded; citers flagged "evidence changed"
 *   deleted         → item removed from use; history kept
 *   access_revoked  → removed from retrieval immediately; citers flagged "evidence unavailable"
 *   ACL unknown     → listed but unusable and its content is never read or stored; only a later known ACL
 *                     restores it (no manual override)
 *   transient/throttled → cursor not advanced; retry; items already parsed at that version are not re-read and
 *                     a new version label with identical content (same hash) is not a new version
 *   cursor_invalid  → full re-list and reconcile by externalId + content hash; then new cursor
 *   auth/scope      → connection needs re-auth; every item suspended from retrieval and citation
 */
import { createHash } from 'node:crypto';
import { SourceError, type AclResult, type ConnectionConfig, type KnowledgeSourcePlugin, type SourceContent, type SourceItemRef } from '@superagent/shared';
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
  // ACL first: the content of an item whose readers are unknown is never read or stored (PRD §3.2).
  const aclRes: AclResult = plugin.getAcl ? await plugin.getAcl(cfg, ref) : { status: 'unknown', reason: 'plugin does not report ACL' };
  const acl = aclRes.status === 'known' ? aclRes.entries : null;
  const sameVersion = !!existing && existing.version === ref.version;

  if (!acl) {
    if (existing && sameVersion) {
      const changed = existing.status !== 'acl_unknown';
      existing.acl = null;
      existing.status = 'acl_unknown';
      existing.contentHash = '';
      store.dropChunks(existing.id);
      if (changed) store.flagCiters(existing.id, 'evidence unavailable: readers unknown');
      return changed ? 'applied' : 'dup';
    }
    if (existing) supersede(store, existing);
    store.items.set(itemId(cfg, ref), newItem(cfg, ref, '', null, 'acl_unknown'));
    return 'applied';
  }

  if (existing && sameVersion && existing.contentHash) {
    // Already parsed at this version (retry after a failure, or a sharing change): refresh readers, no re-read.
    existing.acl = acl;
    if (existing.status !== 'parsed') existing.status = 'parsed';
    return 'dup';
  }

  const content = await plugin.readItem(cfg, ref);
  const contentHash = hash(content.text);
  if (existing && (sameVersion || existing.contentHash === contentHash)) {
    // Same version whose readers just became known, or a new version label with identical content.
    const fresh = !existing.contentHash;
    existing.version = ref.version;
    existing.acl = acl;
    existing.status = 'parsed';
    if (fresh) {
      existing.contentHash = contentHash;
      writeChunks(store, existing.id, content, ref);
      return 'applied';
    }
    return 'dup';
  }
  if (existing) supersede(store, existing);
  const id = itemId(cfg, ref);
  store.items.set(id, newItem(cfg, ref, contentHash, acl, 'parsed'));
  writeChunks(store, id, content, ref);
  return 'applied';
}

const itemId = (cfg: ConnectionConfig, ref: SourceItemRef) => `${cfg.connectionId}:${ref.externalId}:${ref.version}`;

function newItem(cfg: ConnectionConfig, ref: SourceItemRef, contentHash: string, acl: Item['acl'], status: Item['status']): Item {
  return { id: itemId(cfg, ref), connectionId: cfg.connectionId, externalId: ref.externalId, version: ref.version, title: ref.title, locator: ref.locator, contentHash, acl, status, current: true, confirmedVersion: null };
}

function supersede(store: KnowledgeStore, existing: Item) {
  existing.current = false;
  existing.status = 'superseded';
  store.dropChunks(existing.id);
  store.flagCiters(existing.id, 'evidence changed: new version');
}

function writeChunks(store: KnowledgeStore, id: string, content: SourceContent, ref: SourceItemRef) {
  store.dropChunks(id);
  const chunks: Chunk[] = content.anchors.length
    ? content.anchors.map((a) => ({ itemId: id, text: content.text.slice(a.start, a.end), locator: a.locator, start: a.start, end: a.end }))
    : [{ itemId: id, text: content.text, locator: ref.locator, start: 0, end: content.text.length }];
  store.chunks.push(...chunks);
}
