/**
 * Historical mail knowledge source (PRD §3.2): Microsoft Graph, read-only (Mail.Read application permission limited
 * to the chosen mailboxes by an Exchange application access policy; never Mail.Send / Mail.ReadWrite).
 * Scope: one mailbox + one folder + a received-since date. Messages are items; attachments are child items
 * "<messageId>/att/<attachmentId>". Delta sync via messages/delta.
 * ACL: Graph has no per-message ACL, so the audience is the one the owner confirmed for this connection; an empty
 * audience means ACL unknown and nothing becomes usable.
 */
import type { AclResult, ConnectionConfig, KnowledgeSourcePlugin, SourceContent, SourceItemRef } from '@superagent/shared';
import { SourceError } from '@superagent/shared';
import type { DocParser } from '../parser.js';
import { textWithLineAnchors } from './local-file.js';
import { GRAPH, graphGet, isTextName, readDelta, type GraphDeps } from './graph.js';

export interface MailScope {
  mailbox: string; // UPN or user id
  folder: string; // well-known name (inbox) or folder id
  receivedSince: string; // ISO date
  audience: string[]; // principals allowed to read knowledge from this mailbox
}

interface GraphMessage {
  id: string;
  subject?: string;
  receivedDateTime?: string;
  changeKey?: string;
  hasAttachments?: boolean;
  webLink?: string;
  '@removed'?: { reason: string };
}

interface GraphAttachment {
  id: string;
  name: string;
  contentType?: string;
  size?: number;
  lastModifiedDateTime?: string;
  '@odata.type'?: string;
  contentBytes?: string;
}

const enc = encodeURIComponent;
const scopeOf = (cfg: ConnectionConfig) => cfg.scope as unknown as MailScope;
const base = (s: MailScope) => `${GRAPH}/users/${enc(s.mailbox)}`;

export function createMailPlugin(deps: GraphDeps, parser?: DocParser): KnowledgeSourcePlugin {
  return {
    manifest: {
      id: 'm365-mail',
      version: '1.0.0',
      name: '历史邮件',
      capabilities: { incremental: true, attachments: true, liveQuery: false, acl: true },
      permissions: ['Microsoft Graph Mail.Read (application), restricted to selected mailboxes by an application access policy'],
    },

    async testConnection(cfg) {
      const s = scopeOf(cfg);
      await graphGet(deps, cfg, `${base(s)}/mailFolders/${enc(s.folder)}?$select=id,displayName`);
      return { ok: true };
    },

    async listItems(cfg, cursor) {
      const s = scopeOf(cfg);
      const since = new Date(s.receivedSince);
      if (Number.isNaN(since.getTime())) throw new SourceError('fatal', 'receivedSince is not a date');
      const start =
        cursor ??
        `${base(s)}/mailFolders/${enc(s.folder)}/messages/delta?$select=subject,receivedDateTime,hasAttachments,webLink,changeKey&$filter=receivedDateTime+ge+${since.toISOString()}`;
      const { values, cursor: next } = await readDelta<GraphMessage>(deps, cfg, start, { prefer: 'odata.maxpagesize=50' });
      const items: SourceItemRef[] = [];
      for (const m of values) {
        if (m['@removed']) {
          items.push({ externalId: m.id, version: 'removed', title: m.id, locator: m.id, change: 'deleted' });
          continue;
        }
        items.push({ externalId: m.id, version: m.changeKey ?? m.receivedDateTime ?? '1', title: m.subject ?? '(no subject)', locator: m.webLink ?? m.id, change: 'upsert' });
        if (m.hasAttachments) {
          const atts = await graphGet<{ value: GraphAttachment[] }>(deps, cfg, `${base(s)}/messages/${enc(m.id)}/attachments?$select=id,name,contentType,size,lastModifiedDateTime`);
          for (const a of atts.value) {
            if (a['@odata.type'] && a['@odata.type'] !== '#microsoft.graph.fileAttachment') continue; // item/reference attachments are not files
            items.push({ externalId: `${m.id}/att/${a.id}`, version: a.lastModifiedDateTime ?? `${a.size ?? 0}`, title: a.name, locator: `${m.webLink ?? m.id} › ${a.name}`, change: 'upsert' });
          }
        }
      }
      return { items, nextCursor: next };
    },

    async readItem(cfg, ref): Promise<SourceContent> {
      const s = scopeOf(cfg);
      const att = ref.externalId.match(/^(.+)\/att\/(.+)$/);
      if (att) {
        const a = await graphGet<GraphAttachment>(deps, cfg, `${base(s)}/messages/${enc(att[1]!)}/attachments/${enc(att[2]!)}`);
        const bytes = Buffer.from(a.contentBytes ?? '', 'base64');
        if (isTextName(a.name)) return textWithLineAnchors(bytes.toString('utf8'), a.name);
        if (!parser) throw new SourceError('fatal', `${a.name}: attachment parsing requires Document Intelligence`);
        return parser.parse(new Uint8Array(bytes), a.name);
      }
      const m = await graphGet<{ subject?: string; from?: { emailAddress?: { address?: string } }; receivedDateTime?: string; body?: { content?: string } }>(
        deps,
        cfg,
        `${base(s)}/messages/${enc(ref.externalId)}?$select=subject,from,receivedDateTime,body`,
        { prefer: 'outlook.body-content-type="text"' },
      );
      const text = `Subject: ${m.subject ?? ''}\nFrom: ${m.from?.emailAddress?.address ?? ''}\nReceived: ${m.receivedDateTime ?? ''}\n\n${m.body?.content ?? ''}`;
      const c = textWithLineAnchors(text, ref.title);
      return { text: c.text, anchors: c.anchors.map((a) => ({ ...a, locator: `${ref.locator} ${a.locator.slice(a.locator.lastIndexOf('#'))}` })) };
    },

    async getAcl(cfg): Promise<AclResult> {
      const a = scopeOf(cfg).audience ?? [];
      return a.length ? { status: 'known', entries: a.map((p) => ({ principal: p, access: 'read' as const })) } : { status: 'unknown', reason: 'no audience confirmed for this mailbox' };
    },
  };
}
