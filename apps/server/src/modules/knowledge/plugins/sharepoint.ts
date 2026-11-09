/**
 * SharePoint / OneDrive knowledge source (PRD §3.2): Microsoft Graph, read-only (Sites.Selected application permission
 * with a per-site "read" grant). Scope: one drive (document library) + optional folder path.
 * Delta on the drive root (Graph supports delta only at the root for business drives); folder scope is applied by
 * parentReference.path. Prefer headers make removals and sharing changes visible in the delta.
 * ACL is the item's own permissions: Entra users/groups → principals; SharePoint site groups → "sp-group:<site>:<id>"
 * (expanded by retrieval, so an unexpanded group matches nobody: fail closed); organisation-wide links → "org:all";
 * anonymous links or an unreadable permission list → ACL unknown (unusable).
 */
import type { AclEntry, AclResult, ConnectionConfig, KnowledgeSourcePlugin, SourceContent, SourceItemRef } from '@superagent/shared';
import { SourceError } from '@superagent/shared';
import type { DocParser } from '../parser.js';
import { textWithLineAnchors } from './local-file.js';
import { GRAPH, graphBytes, graphGet, isTextName, readDelta, type GraphDeps } from './graph.js';

export interface SharePointScope {
  driveId: string;
  folderPath?: string; // e.g. "/Policies"; omitted = whole library
}

interface DriveItem {
  id: string;
  name?: string;
  webUrl?: string;
  cTag?: string;
  eTag?: string;
  file?: unknown;
  folder?: unknown;
  deleted?: { state?: string };
  parentReference?: { path?: string; siteId?: string };
}

interface Identity {
  id?: string;
}
interface Permission {
  roles?: string[];
  grantedToV2?: { user?: Identity; group?: Identity; siteGroup?: Identity; siteUser?: Identity };
  grantedToIdentitiesV2?: { user?: Identity; group?: Identity; siteGroup?: Identity; siteUser?: Identity }[];
  link?: { scope?: 'anonymous' | 'organization' | 'users' | 'existingAccess' };
}

const enc = encodeURIComponent;
const scopeOf = (cfg: ConnectionConfig) => cfg.scope as unknown as SharePointScope;
const DELTA_HEADERS = { prefer: 'deltashowremovedasdeleted, deltatraversepermissiongaps, deltashowsharingchanges, hierarchicalsharing' };

/** True if the item lies inside the configured folder ("/drives/<id>/root:/Policies/Sub" is under "/Policies"). */
export function inFolder(item: DriveItem, folderPath?: string): boolean {
  if (!folderPath) return true;
  const p = decodeURIComponent(item.parentReference?.path?.split('root:')[1] ?? '');
  const want = '/' + folderPath.replace(/^\/+|\/+$/g, '');
  return p === want || p.startsWith(`${want}/`);
}

export function permissionsToAcl(perms: Permission[], siteId: string): AclResult {
  const entries: AclEntry[] = [];
  const add = (principal: string) => entries.some((e) => e.principal === principal) || entries.push({ principal, access: 'read' });
  for (const p of perms) {
    if (p.link?.scope === 'anonymous') return { status: 'unknown', reason: 'anonymous sharing link: readers cannot be enumerated' };
    if (p.link?.scope === 'organization') add('org:all');
    for (const g of [p.grantedToV2, ...(p.grantedToIdentitiesV2 ?? [])]) {
      if (!g) continue;
      if (g.user?.id) add(g.user.id);
      else if (g.group?.id) add(g.group.id);
      else if (g.siteGroup?.id) add(`sp-group:${siteId}:${g.siteGroup.id}`);
      else if (g.siteUser?.id) add(`sp-user:${siteId}:${g.siteUser.id}`);
    }
  }
  return entries.length ? { status: 'known', entries } : { status: 'unknown', reason: 'no readable permissions returned' };
}

export function createSharePointPlugin(deps: GraphDeps, parser?: DocParser): KnowledgeSourcePlugin {
  const siteOf = new Map<string, string>(); // externalId → siteId (from the delta's parentReference)
  return {
    manifest: {
      id: 'm365-sharepoint',
      version: '1.0.0',
      name: 'SharePoint / OneDrive',
      capabilities: { incremental: true, attachments: false, liveQuery: false, acl: true },
      permissions: ['Microsoft Graph Sites.Selected (application) with a read grant on each chosen site'],
    },

    async testConnection(cfg) {
      await graphGet(deps, cfg, `${GRAPH}/drives/${enc(scopeOf(cfg).driveId)}?$select=id,name`);
      return { ok: true };
    },

    async listItems(cfg, cursor) {
      const s = scopeOf(cfg);
      const start = cursor ?? `${GRAPH}/drives/${enc(s.driveId)}/root/delta?$select=id,name,webUrl,cTag,eTag,file,folder,deleted,parentReference`;
      const { values, cursor: next } = await readDelta<DriveItem>(deps, cfg, start, DELTA_HEADERS);
      if (cursor && values.some(it => it.folder || it.deleted && !it.file)) {
        // A folder move/rename/deletion may omit its descendants from delta. Reconcile the complete snapshot instead
        // of leaving old child documents inside the approved scope. Deleted facets do not reliably retain item kind.
        // Full snapshots have no supplied cursor, so the sync engine's one-time relist cannot recurse here.
        throw new SourceError('cursor_invalid', 'folder hierarchy changed; full source reconciliation required');
      }
      const items: SourceItemRef[] = [];
      for (const it of values) {
        if (it.deleted) {
          items.push({ externalId: it.id, version: 'deleted', title: it.name ?? it.id, locator: it.webUrl ?? it.id, change: 'deleted' });
          continue;
        }
        if (!it.file) continue;
        if (!inFolder(it, s.folderPath)) {
          // Drive delta includes files moved out of the approved subtree. Skipping them would preserve old citations.
          // Keep only the opaque item ID for withdrawal; outside-scope titles and URLs never enter preview metadata.
          siteOf.delete(it.id);
          items.push({ externalId: it.id, version: 'outside-scope', title: it.id, locator: it.id, change: 'access_revoked' });
          continue;
        }
        if (it.parentReference?.siteId) siteOf.set(it.id, it.parentReference.siteId);
        items.push({ externalId: it.id, version: it.cTag ?? it.eTag ?? '1', title: it.name ?? it.id, locator: it.webUrl ?? it.id, change: 'upsert' });
      }
      return { items, nextCursor: next };
    },

    async readItem(cfg, ref): Promise<SourceContent> {
      const bytes = await graphBytes(deps, cfg, `${GRAPH}/drives/${enc(scopeOf(cfg).driveId)}/items/${enc(ref.externalId)}/content`);
      if (isTextName(ref.title)) {
        const c = textWithLineAnchors(Buffer.from(bytes).toString('utf8'), ref.title);
        return { text: c.text, anchors: c.anchors.map((a) => ({ ...a, locator: `${ref.locator}${a.locator.slice(a.locator.lastIndexOf('#'))}` })) };
      }
      if (!parser) throw new SourceError('fatal', `${ref.title}: parsing requires Document Intelligence`);
      const c = await parser.parse(bytes, ref.title);
      return { ...c, anchors: c.anchors.map((a) => ({ ...a, locator: a.locator.replace(ref.title, ref.locator) })) };
    },

    async getAcl(cfg, ref): Promise<AclResult> {
      const item = `${GRAPH}/drives/${enc(scopeOf(cfg).driveId)}/items/${enc(ref.externalId)}`;
      let siteId = siteOf.get(ref.externalId);
      if (!siteId) {
        siteId = (await graphGet<DriveItem>(deps, cfg, `${item}?$select=parentReference`)).parentReference?.siteId;
        if (!siteId) return { status: 'unknown', reason: 'site of the item could not be determined' };
        siteOf.set(ref.externalId, siteId);
      }
      const r = await graphGet<{ value: Permission[] }>(deps, cfg, `${item}/permissions`);
      return permissionsToAcl(r.value, siteId);
    },
  };
}
