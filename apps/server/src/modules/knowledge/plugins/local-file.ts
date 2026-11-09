/**
 * Local file plugin: one-time import (no folder watching). txt/md parsed directly with line anchors; PDF/DOCX/images go
 * through Document Intelligence. ACL is the uploader-chosen audience (known by construction).
 */
import type { AclResult, ConnectionConfig, KnowledgeSourcePlugin, SourceContent, SourceItemRef } from '@superagent/shared';
import type { DocParser } from '../parser.js';

export interface UploadedFile {
  name: string;
  bytes: Uint8Array;
  version: string;
  audience: string[]; // principals allowed to read (users/groups); chosen at upload
}

export function textWithLineAnchors(text: string, fileName: string): SourceContent {
  const anchors: SourceContent['anchors'] = [];
  let pos = 0;
  text.split('\n').forEach((line, i) => {
    if (line.trim()) anchors.push({ start: pos, end: pos + line.length, locator: `${fileName}#L${i + 1}` });
    pos += line.length + 1;
  });
  return { text, anchors };
}

export function createLocalFilePlugin(files: Map<string, UploadedFile[]>, parser?: DocParser): KnowledgeSourcePlugin {
  const current = (connId: string) => files.get(connId) ?? [];
  return {
    manifest: { id: 'local-file', version: '1.0.0', name: '本地文件', capabilities: { incremental: false, attachments: false, liveQuery: false, acl: true }, permissions: [] },
    async testConnection() {
      return { ok: true };
    },
    async listItems(cfg: ConnectionConfig) {
      const items: SourceItemRef[] = current(cfg.connectionId).map((f) => ({ externalId: f.name, version: f.version, title: f.name, locator: `upload://${f.name}`, change: 'upsert' }));
      return { items, nextCursor: `n${items.length}` };
    },
    async readItem(cfg: ConnectionConfig, ref: SourceItemRef) {
      const f = current(cfg.connectionId).find((x) => x.name === ref.externalId && x.version === ref.version);
      if (!f) throw new Error('file not found');
      if (/\.(txt|md|markdown|csv)$/i.test(f.name)) return textWithLineAnchors(Buffer.from(f.bytes).toString('utf8'), f.name);
      if (!parser) throw new Error(`${f.name}: PDF/Office/image parsing requires Document Intelligence`);
      return parser.parse(f.bytes, f.name);
    },
    async getAcl(cfg: ConnectionConfig, ref: SourceItemRef): Promise<AclResult> {
      const f = current(cfg.connectionId).find((x) => x.name === ref.externalId);
      return f?.audience.length ? { status: 'known', entries: f.audience.map((p) => ({ principal: p, access: 'read' as const })) } : { status: 'unknown', reason: 'no audience chosen' };
    },
  };
}
