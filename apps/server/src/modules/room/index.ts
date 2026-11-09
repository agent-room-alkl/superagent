import type { FastifyPluginAsync } from 'fastify';

/** Owner: T-41-Grok. Placeholder mount point from the T-39 scaffold — replace freely. */
export const roomModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({ module: 'room', implemented: false }));
};
