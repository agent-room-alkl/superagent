import type { FastifyPluginAsync } from 'fastify';
import { ToolGateway } from './gateway.js';

/** One gateway per process until action_requests is on the shared schema migration. */
export const gatewayState = { current: new ToolGateway() };

export const gatewayModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({ module: 'gateway', writesRetryOnUnknown: false }));
};
