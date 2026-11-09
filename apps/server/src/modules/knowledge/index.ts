import type { FastifyPluginAsync } from 'fastify';

/** Owner: T-40-Codex. Placeholder mount point from the T-39 scaffold — replace freely. */
export const knowledgeModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({ module: 'knowledge', implemented: false }));
};
