import type { Runtime } from '../../bootstrap.js';
import type { KnowledgeDeps } from './service.js';
import { MemoryKnowledgeRepository, PgKnowledgeRepository } from './repository.js';
import { AzureBinaryStore } from './binary.js';
import { DocumentIntelligenceAdapter } from '../../plugins/document-intelligence.js';
import { GatewayAnalysisModel, type AnalysisGateway } from '../analysis/gateway-model.js';
import { configuredDatabases } from './database-config.js';
import { PgKnowledgeAudit } from './audit.js';
/** All identity/endpoints/pools originate from the fail-closed platform bootstrap. */
export function createKnowledgeDeps(runtime: Runtime & { llm?: AnalysisGateway }): KnowledgeDeps {
  const model = runtime.llm ? new GatewayAnalysisModel(runtime.llm) : undefined;
  const database = configuredDatabases(runtime.config.sourceDatabases ?? [], runtime.app.setupDeps.secrets);
  if (runtime.config.mode === 'dev') return { repo: new MemoryKnowledgeRepository(), model, database: database.gateway, close: database.close, enqueue: async () => undefined };
  if (!runtime.pool || !runtime.config.blobUrl || !runtime.config.docIntelEndpoint) throw Error('Knowledge requires persistent runtime dependencies');
  return {
    repo: new PgKnowledgeRepository(runtime.pool),
    audit: new PgKnowledgeAudit(runtime.pool),
    model,
    database: database.gateway, close: database.close,
    binary: { blobs: new AzureBinaryStore(runtime.config.blobUrl), parser: new DocumentIntelligenceAdapter({ endpoint: runtime.config.docIntelEndpoint }) },
    // The same PG document contains the durable analysis job; enqueue is an optional wake-up notification.
    enqueue: async () => undefined,
  };
}
export async function knowledgeReady(deps: KnowledgeDeps): Promise<boolean> {
  if (!(deps.repo instanceof PgKnowledgeRepository)) return true;
  const result = await deps.repo.pool.query("SELECT to_regclass('public.knowledge_tenants') IS NOT NULL AND to_regclass('public.knowledge_chunks') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_extension WHERE extname='pg_trgm') AS ok");
  return result.rows[0]?.ok === true;
}
