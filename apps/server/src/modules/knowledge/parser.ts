/**
 * Parser seam for binary sources (PDF, Office, images). Production: DocIntelParser (docintel-parser.ts) over the
 * Document Intelligence adapter. Implementations must throw SourceError so the sync engine applies §3.2 semantics.
 */
import type { SourceContent } from '@superagent/shared';

export interface DocParser {
  parse(bytes: Uint8Array, fileName: string): Promise<SourceContent>;
}
