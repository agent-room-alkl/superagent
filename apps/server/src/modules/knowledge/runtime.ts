import type { Runtime } from '../../bootstrap.js';
import type { KnowledgeDeps } from './service.js';
import { MemoryKnowledgeRepository, PgKnowledgeRepository } from './repository.js';
import { AzureBinaryStore } from './binary.js';
import { DocumentIntelligenceAdapter } from '../../plugins/document-intelligence.js';
/** All identity/endpoints/pools originate from the fail-closed platform bootstrap. */
export function createKnowledgeDeps(runtime: Runtime): KnowledgeDeps {
  if (runtime.config.mode === 'dev') return { repo: new MemoryKnowledgeRepository() };
  if (!runtime.pool || !runtime.config.blobUrl || !runtime.config.docIntelEndpoint) throw Error('Knowledge requires persistent runtime dependencies');
  return {
    repo: new PgKnowledgeRepository(runtime.pool),
    binary: { blobs: new AzureBinaryStore(runtime.config.blobUrl), parser: new DocumentIntelligenceAdapter({ endpoint: runtime.config.docIntelEndpoint }) },
    // The same PG document contains the durable analysis job; enqueue is an optional wake-up notification.
    enqueue: async () => undefined,
  };
}
