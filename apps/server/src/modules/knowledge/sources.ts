import { DefaultAzureCredential } from '@azure/identity';
import type { KnowledgeSourcePlugin, UserContext } from '@superagent/shared';
import { KnowledgeError } from './domain.js';
import { createMailPlugin } from './plugins/mail.js';
import { createSharePointPlugin } from './plugins/sharepoint.js';

/** Deployment-owned metadata grants. No request can provision or widen these permissions. */
export interface SourceResource {
  id: string; name: string; pluginId: 'email' | 'sharepoint';
  scope: Record<string, unknown>; audience: string[]; projectIds: string[];
}
const scopeKeys = (pluginId: string) => pluginId === 'email' ? ['mailbox', 'folder', 'receivedSince'] : ['driveId', 'folderPath'];

export function sourceScope(resources: SourceResource[], ctx: UserContext, pluginId: string, requested: Record<string, unknown>, audience: string[]): Record<string, unknown> {
  const resource = resources.find(r => r.id === requested.resourceId && r.pluginId === pluginId);
  if (!resource || !resource.audience.includes(ctx.userId) || !resource.projectIds.every(p => ctx.projectScopes.includes(p))) {
    throw new KnowledgeError('source_denied', '当前账号不在此资料源的授权范围内。', 403);
  }
  const keys = [...scopeKeys(pluginId), 'resourceId', 'audience', 'projectIds', 'selectedExternalIds'];
  if (Object.keys(requested).some(k => !keys.includes(k))) throw new KnowledgeError('invalid_scope', '来源范围包含不支持的字段。');
  if (!audience.length || audience.some(p => !resource.audience.includes(p))) throw new KnowledgeError('scope_denied', '资料读者不能超过来源授权范围。', 403);
  for (const key of pluginId === 'email' ? ['mailbox', 'folder'] : ['driveId', 'folderPath']) {
    if (requested[key] !== undefined && requested[key] !== resource.scope[key]) throw new KnowledgeError('scope_denied', '不能扩大邮箱、目录或资料库范围。', 403);
  }
  if (requested.projectIds !== undefined && (!Array.isArray(requested.projectIds) || requested.projectIds.some(p => !resource.projectIds.includes(String(p))))) {
    throw new KnowledgeError('scope_denied', '不能扩大来源的项目范围。', 403);
  }
  const scope: Record<string, unknown> = { ...structuredClone(resource.scope), resourceId: resource.id, audience: [...audience], projectIds: [...resource.projectIds] };
  if (pluginId === 'email' && requested.receivedSince !== undefined) {
    const from = Date.parse(String(requested.receivedSince)), min = Date.parse(String(resource.scope.receivedSince));
    if (!Number.isFinite(from) || !Number.isFinite(min) || from < min) throw new KnowledgeError('scope_denied', '查询起始日期不能早于来源授权日期。', 403);
    scope.receivedSince = new Date(from).toISOString();
  }
  return scope;
}

/** Bounded, fail-closed operator configuration. Errors never echo submitted values. */
export function parseSourceResources(raw: string | undefined): SourceResource[] {
  if (!raw) return [];
  try {
    if (raw.length > 50_000) throw Error();
    const rows = JSON.parse(raw) as SourceResource[];
    if (!Array.isArray(rows) || rows.length > 20) throw Error();
    const ids = new Set<string>();
    const principals = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100 && value.every(x => typeof x === 'string' && x.length > 0 && x.length <= 200);
    for (const r of rows) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['id', 'name', 'pluginId', 'scope', 'audience', 'projectIds'].includes(k)) ||
          typeof r.id !== 'string' || !/^[-a-zA-Z0-9_]{1,80}$/.test(r.id) || ids.has(r.id) ||
          typeof r.name !== 'string' || !r.name.trim() || r.name.length > 160 || !['email', 'sharepoint'].includes(r.pluginId) ||
          !r.scope || typeof r.scope !== 'object' || Array.isArray(r.scope) || !principals(r.audience) || !r.audience.length || !principals(r.projectIds)) throw Error();
      ids.add(r.id);
      const keys = scopeKeys(r.pluginId);
      if (Object.keys(r.scope).some(k => !keys.includes(k))) throw Error();
      for (const key of keys) {
        const value = r.scope[key];
        if (key === 'folderPath' && value === undefined) continue;
        if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\x00-\x1f]/.test(value)) throw Error();
      }
      if (r.pluginId === 'email' && !Number.isFinite(Date.parse(String(r.scope.receivedSince)))) throw Error();
    }
    return rows;
  } catch {
    throw Error('Invalid KNOWLEDGE_SOURCES_JSON: expected approved mailbox/library scopes and audience; credential values are forbidden');
  }
}

export function managedSourcePlugins(resources: SourceResource[]): Record<string, KnowledgeSourcePlugin> {
  if (!resources.length) return {};
  const credential = new DefaultAzureCredential();
  const deps = { getToken: async () => {
    const token = await credential.getToken('https://graph.microsoft.com/.default');
    if (!token) throw Error('Graph managed identity is unavailable');
    return token.token;
  } };
  return {
    ...(resources.some(r => r.pluginId === 'email') ? { email: createMailPlugin(deps) } : {}),
    ...(resources.some(r => r.pluginId === 'sharepoint') ? { sharepoint: createSharePointPlugin(deps) } : {}),
  };
}
