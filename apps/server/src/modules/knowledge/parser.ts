/**
 * Parser seam for binary sources (PDF, Office, images). The production implementation is the Document Intelligence
 * adapter (PR #8: endpoint-pinned operation URLs, no redirects, 401/403 mapped to SourceError auth/scope), driven by
 * durable knowledge.parse jobs (T-40/T-41). It must throw SourceError so the sync engine applies §3.2 semantics.
 */
import type { SourceContent } from '@superagent/shared';

export interface DocParser {
  parse(bytes: Uint8Array, fileName: string): Promise<SourceContent>;
}
