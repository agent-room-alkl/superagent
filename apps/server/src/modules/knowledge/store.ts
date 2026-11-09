/**
 * Knowledge store: connections, source items (versioned), chunks with anchors and ACL (PRD §3.2).
 * In-memory implementation used by tests and local dev; the PostgreSQL schema is in migrations/0002_knowledge.sql.
 */
import type { AclEntry } from '@superagent/shared';

export type ConnectionStatus = 'draft' | 'tested' | 'pending_confirmation' | 'confirmed' | 'syncing' | 'sync_failed' | 'needs_reauth' | 'withdrawn';
export type ItemStatus = 'new' | 'parsed' | 'parse_failed' | 'superseded' | 'deleted' | 'access_revoked' | 'acl_unknown' | 'suspended';

export interface Connection {
  id: string;
  pluginId: string;
  scope: Record<string, unknown>;
  credentialRef: string | null;
  status: ConnectionStatus;
  cursor: string | null;
  confirmedBy: string | null;
}

export interface Item {
  id: string; // connectionId:externalId:version
  connectionId: string;
  externalId: string;
  version: string;
  title: string;
  locator: string;
  contentHash: string;
  acl: AclEntry[] | null; // null = unknown
  status: ItemStatus;
  current: boolean; // latest version for this externalId
  /** Version the connection owner confirmed for use in analysis (T-40); a new version starts unconfirmed. */
  confirmedVersion: string | null;
}

export interface Chunk {
  itemId: string;
  text: string;
  locator: string; // e.g. "policy.md#L12" / "invoice.pdf p.2" / "invoices.amount"
  start: number; // offsets into the parsed item text (UTF-16 code units)
  end: number;
}

export class KnowledgeStore {
  connections = new Map<string, Connection>();
  items = new Map<string, Item>();
  chunks: Chunk[] = [];
  /** Things that cited an item (recommendations, SOP nodes, answers) → flagged when the evidence changes. */
  citations = new Map<string, Set<string>>();
  flagged = new Map<string, string>(); // citer → reason

  currentItem(connectionId: string, externalId: string): Item | undefined {
    return [...this.items.values()].find((i) => i.connectionId === connectionId && i.externalId === externalId && i.current);
  }

  dropChunks(itemId: string): void {
    this.chunks = this.chunks.filter((c) => c.itemId !== itemId);
  }

  /** Current child items, addressed as "<parentExternalId>/<...>" (attachments). */
  childrenOf(connectionId: string, parentExternalId: string): Item[] {
    return [...this.items.values()].filter((i) => i.connectionId === connectionId && i.current && i.externalId.startsWith(`${parentExternalId}/`));
  }

  cite(itemId: string, citer: string): void {
    const s = this.citations.get(itemId) ?? new Set<string>();
    s.add(citer);
    this.citations.set(itemId, s);
  }

  flagCiters(itemId: string, reason: string): void {
    for (const c of this.citations.get(itemId) ?? []) this.flagged.set(c, reason);
  }

  /** Usable for retrieval/analysis/citation: confirmed connection, current version, parsed, known ACL. */
  usable(item: Item): boolean {
    const conn = this.connections.get(item.connectionId);
    return !!conn && conn.status === 'confirmed' && item.current && item.status === 'parsed' && item.acl !== null;
  }
}
