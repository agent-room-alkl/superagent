import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modules } from './modules/index.js';

export interface AppOptions {
  /** Serve the built web app (apps/web/dist) from the same process. */
  serveWeb?: boolean;
  logger?: boolean;
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Never log request bodies: Setup carries API keys (PRD §7.1).
    disableRequestLogging: true,
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async () => ({ ok: true, role: process.env.APP_ROLE ?? 'web' }));

  // Each module owns a prefix under /api/v1. Owners: see docs/OWNERSHIP.md.
  for (const m of modules) {
    await app.register(m.plugin, { prefix: `/api/v1/${m.prefix}` });
  }

  if (opts.serveWeb) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const webDist = path.resolve(here, '../../web/dist');
    if (fs.existsSync(webDist)) {
      await app.register(fastifyStatic, { root: webDist, wildcard: false });
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' });
        return reply.sendFile('index.html');
      });
    }
  }
  return app;
}
