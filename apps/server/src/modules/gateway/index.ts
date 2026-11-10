import type { FastifyPluginAsync } from 'fastify';
import { ToolGateway } from './gateway.js';
import { loadGatewaySnapshot, saveGatewaySnapshot, type Queryable } from './pg-gateway.js';

/** One gateway per process. Postgres is the restart copy; this object stays the one the executor holds. */
export const gatewayState = { current: new ToolGateway() };

let gatewayStore: Queryable | null = null;

export function bindGatewayStore(db: Queryable | null): void {
  gatewayStore = db;
}

export async function flushGateway(): Promise<void> {
  if (gatewayStore) await saveGatewaySnapshot(gatewayStore, gatewayState.current.snapshot());
}

export async function hydrateGateway(): Promise<void> {
  if (!gatewayStore) return;
  const saved = await loadGatewaySnapshot(gatewayStore);
  if (saved.actions.length === 0) return;
  gatewayState.current.load(saved);
}

export const gatewayModule: FastifyPluginAsync = async (app) => {
  app.get('/status', async () => ({ module: 'gateway', writesRetryOnUnknown: false }));
};
