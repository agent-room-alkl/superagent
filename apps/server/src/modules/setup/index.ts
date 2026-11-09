import type { FastifyPluginAsync } from 'fastify';
import type { LlmProviderId } from '@superagent/shared';
import { activateKey, InMemoryConfigRepo, MAX_MONTHLY_CAP_MICRO_USD, publicView, revokeKey, selectableModels, setMonthlyCap, StaticAllowlist, testKey, type SetupDeps } from './service.js';
import { InMemorySecretStore } from './secrets.js';

/**
 * Setup routes (PRD §3.1). Admin/owner only — enforced by the auth hook (requireRole) once auth is mounted.
 * Request bodies are never logged (app-level disableRequestLogging).
 */
export interface SetupModuleOptions {
  deps?: SetupDeps;
  tenantOf?: (req: unknown) => string;
}

const PROVIDERS: LlmProviderId[] = ['anthropic', 'openai', 'azure-openai'];

export const setupModule: FastifyPluginAsync<SetupModuleOptions> = async (app, opts) => {
  if (!opts.deps && process.env.NODE_ENV === 'production') throw new Error('Setup has no persistent dependencies in production');
  const deps: SetupDeps = opts.deps ?? {
    repo: new InMemoryConfigRepo(),
    secrets: new InMemorySecretStore(),
    allowlist: new StaticAllowlist({}),
  };
  const tenantOf = opts.tenantOf ?? (() => 'default');

  app.get('/llm', async (req) => publicView(await deps.repo.get(tenantOf(req))));

  app.post<{ Body: { provider: LlmProviderId; apiKey: string; endpoint?: string; probeModel: string; deployments?: string[] } }>(
    '/llm/test',
    async (req, reply) => {
      const b = req.body;
      if (!PROVIDERS.includes(b?.provider) || typeof b.apiKey !== 'string' || !b.probeModel) return reply.code(400).send({ error: 'invalid_request' });
      const r = await testKey(b, deps);
      const { selectable, unverified } = selectableModels(r.models);
      return { auth: r.auth, listing: r.listing, tools: r.tools, message: r.message, selectable: selectable.map((m) => m.id), unverified: unverified.map((m) => m.id) };
    },
  );

  app.put<{ Body: { provider: LlmProviderId; apiKey: string; endpoint?: string; probeModel: string; primaryModel: string; economyModel?: string } }>(
    '/llm',
    async (req, reply) => {
      const b = req.body;
      if (!PROVIDERS.includes(b?.provider) || typeof b.apiKey !== 'string' || !b.primaryModel) return reply.code(400).send({ error: 'invalid_request' });
      const test = await testKey(b, deps);
      if (test.auth !== 'ok') return reply.code(422).send({ error: 'key_test_failed', auth: test.auth });
      try {
        const rec = await activateKey(tenantOf(req), b, { primary: b.primaryModel, economy: b.economyModel }, test, deps);
        return publicView(rec);
      } catch (e) {
        return reply.code(422).send({ error: 'activation_failed', message: (e as Error).message });
      }
    },
  );

  app.delete('/llm', async (req) => publicView(await revokeKey(tenantOf(req), deps)));

  /** Monthly hard cap, entered in USD (up to 2 decimals). */
  app.put<{ Body: { monthlyCapUsd: number } }>('/llm/budget', async (req, reply) => {
    const usd = req.body?.monthlyCapUsd;
    const micro = typeof usd === 'number' && Number.isFinite(usd) ? Math.round(usd * 1_000_000) : NaN;
    if (!(micro > 0) || micro > MAX_MONTHLY_CAP_MICRO_USD || Math.abs(usd * 100 - Math.round(usd * 100)) > 1e-6) {
      return reply.code(400).send({ error: 'invalid_cap', message: 'enter a positive amount in USD with at most 2 decimals, up to 1,000,000' });
    }
    const actor = (req as { user?: { userId?: string } }).user?.userId ?? 'unknown';
    return publicView(await setMonthlyCap(tenantOf(req), micro, actor, deps));
  });
};
