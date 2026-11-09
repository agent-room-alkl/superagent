import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modules } from './modules/index.js';
import { createAuthenticate, requireRole, type AuthConfig } from './auth.js';
import type { SetupDeps } from './modules/setup/service.js';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<boolean>;
}

export interface AppOptions {
  /** Serve the built web app (apps/web/dist) from the same process. */
  serveWeb?: boolean;
  logger?: boolean;
  auth?: AuthConfig;
  setupDeps?: SetupDeps;
  readiness?: ReadinessCheck[];
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    // Never log request bodies: Setup carries API keys (PRD §7.1).
    disableRequestLogging: true,
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    const results = await Promise.all(
      (opts.readiness ?? []).map(async (c) => ({ name: c.name, ok: await c.check().catch(() => false) })),
    );
    const ok = results.every((r) => r.ok);
    return reply.code(ok ? 200 : 503).send({ ok, role: process.env.APP_ROLE ?? 'web', checks: results });
  });

  // Fail closed: production must come through bootstrap.ts with explicit Entra auth and real stores.
  const production = process.env.NODE_ENV === 'production';
  if (production && (!opts.auth || opts.auth.mode === 'dev')) throw new Error('production requires explicit Entra auth (use createRuntime in bootstrap.ts)');
  if (production && !opts.setupDeps) throw new Error('production requires persistent Setup dependencies (use createRuntime in bootstrap.ts)');
  const auth = opts.auth ?? { mode: 'dev' as const, platformTenantId: 'default' };
  const authenticate = createAuthenticate(auth);

  await app.register(async (api) => {
    api.addHook('preHandler', authenticate);
    // Each module owns a prefix under /api/v1. Owners: see docs/OWNERSHIP.md.
    for (const m of modules) {
      await api.register(async (scoped) => {
        if (m.roles) scoped.addHook('preHandler', requireRole(...m.roles));
        await scoped.register(m.plugin, { ...(m.prefix === 'setup' && opts.setupDeps ? { deps: opts.setupDeps } : {}), tenantOf: (req: any) => req.user?.tenantId ?? 'default' });
      }, { prefix: `/api/v1/${m.prefix}` });
    }
  });

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
