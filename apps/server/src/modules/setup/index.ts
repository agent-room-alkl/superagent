import type { FastifyPluginAsync } from 'fastify';

/**
 * Owner: T-39 Claude. Setup — provider, key (Key Vault only), model allowlist, budget (PRD §3.1).
 * Scaffold stage: reports configuration status only. Key handling lands in a follow-up PR.
 */
export const setupModule: FastifyPluginAsync = async (app) => {
  app.get('/llm', async () => ({ status: 'unconfigured', provider: null, keyLast4: null, primaryModel: null }));
};
