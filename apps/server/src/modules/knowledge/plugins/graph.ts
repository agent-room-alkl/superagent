/**
 * Minimal Microsoft Graph client for read-only knowledge plugins. Maps HTTP failures onto SourceError kinds so the
 * sync engine applies the PRD §3.2 semantics:
 *   401 → auth · 403 → scope · 404 → not_found · 410 / syncStateNotFound → cursor_invalid · 429 / 503 → throttled
 *   other 5xx / network → transient
 * Only GET is ever issued. Delta links are stored as cursors, so a cursor must point at Graph itself.
 */
import { SourceError, type ConnectionConfig } from '@superagent/shared';

export const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface GraphDeps {
  /** App-only token for the connection (client credentials from Key Vault via credentialRef). Never logged. */
  getToken: (cfg: ConnectionConfig) => Promise<string>;
  fetchFn?: typeof fetch;
  /** Max pages followed in one listItems call before handing back a nextLink as the cursor. */
  maxPages?: number;
}

export function assertGraphUrl(url: string): void {
  if (!url.startsWith(`${GRAPH}/`)) throw new SourceError('cursor_invalid', 'cursor is not a Microsoft Graph URL');
}

export async function graphGet<T>(deps: GraphDeps, cfg: ConnectionConfig, url: string, headers: Record<string, string> = {}): Promise<T> {
  assertGraphUrl(url);
  let res: Response;
  try {
    res = await (deps.fetchFn ?? fetch)(url, { method: 'GET', headers: { authorization: `Bearer ${await deps.getToken(cfg)}`, ...headers } });
  } catch (e) {
    throw new SourceError('transient', `network: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  const code = body.error?.code ?? '';
  const retryAfter = Number(res.headers.get('retry-after') ?? 0) * 1000 || undefined;
  if (res.status === 410 || /syncStateNotFound|resyncRequired|syncStateInvalid/i.test(code)) throw new SourceError('cursor_invalid', `delta token rejected (${res.status} ${code})`);
  if (res.status === 401) throw new SourceError('auth', `authentication failed (${code || 401})`);
  if (res.status === 403) throw new SourceError('scope', `access denied (${code || 403})`);
  if (res.status === 404) throw new SourceError('not_found', `not found (${code || 404})`);
  if (res.status === 429 || res.status === 503) throw new SourceError('throttled', `throttled (${res.status})`, retryAfter);
  if (res.status >= 500) throw new SourceError('transient', `server error ${res.status}`);
  throw new SourceError('fatal', `unexpected ${res.status} ${code}`);
}

export async function graphBytes(deps: GraphDeps, cfg: ConnectionConfig, url: string): Promise<Uint8Array> {
  assertGraphUrl(url);
  const res = await (deps.fetchFn ?? fetch)(url, { method: 'GET', headers: { authorization: `Bearer ${await deps.getToken(cfg)}` } }).catch((e) => {
    throw new SourceError('transient', `network: ${e instanceof Error ? e.message : String(e)}`);
  });
  if (res.status === 403) throw new SourceError('scope', 'access denied');
  if (res.status === 404) throw new SourceError('not_found', 'not found');
  if (res.status === 401) throw new SourceError('auth', 'authentication failed');
  if (res.status === 429 || res.status === 503) throw new SourceError('throttled', `throttled (${res.status})`);
  if (!res.ok) throw new SourceError(res.status >= 500 ? 'transient' : 'fatal', `download failed ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

interface DeltaPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

/** Follows nextLink pages; returns the deltaLink (or the next page link when the page budget runs out). */
export async function readDelta<T>(deps: GraphDeps, cfg: ConnectionConfig, startUrl: string, headers: Record<string, string> = {}): Promise<{ values: T[]; cursor: string }> {
  const values: T[] = [];
  let url = startUrl;
  for (let page = 0; page < (deps.maxPages ?? 20); page++) {
    const p = await graphGet<DeltaPage<T>>(deps, cfg, url, headers);
    values.push(...p.value);
    if (p['@odata.deltaLink']) return { values, cursor: p['@odata.deltaLink'] };
    if (!p['@odata.nextLink']) throw new SourceError('transient', 'delta page had neither nextLink nor deltaLink');
    url = p['@odata.nextLink'];
  }
  return { values, cursor: url };
}

export const isTextName = (name: string) => /\.(txt|md|markdown|csv|json|html?)$/i.test(name);
