import { APP_ROLES, type AppRole } from '@superagent/shared';
import { buildApp } from './app.js';
import { dispatchBound, runWorker } from './worker.js';
import { bindRuntimeDb, runtimeState } from './modules/runtime/index.js';
import { bindRoomStore, hydrateRoom } from './modules/room/index.js';
import { createKnowledgeDeps, knowledgeReady } from './modules/knowledge/runtime.js';
import { tickKnowledge } from './modules/knowledge/worker.js';

const role = (process.env.APP_ROLE ?? 'web') as AppRole;
if (!APP_ROLES.includes(role)) {
  console.error(`Unknown APP_ROLE "${role}". Expected one of: ${APP_ROLES.join(', ')}`);
  process.exit(1);
}

if (role === 'web') {
  const { createRuntime } = await import('./bootstrap.js');
  const runtime = await createRuntime(process.env); // throws BootstrapError naming missing settings → container exits
  const knowledge = createKnowledgeDeps(runtime);
  let roomHydrated = !runtime.pool;
  if (runtime.pool) {
    // T-41: command-room rows and the task queue live in the same PostgreSQL as everything else.
    const pool = runtime.pool;
    const db = { query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await pool.query(text, params as unknown[])).rows as T[] }) };
    bindRoomStore(db);
    bindRuntimeDb(db);
    // Never crash the web role on an unreachable database: retry in the background and stay not-ready until done.
    const hydrate = () => hydrateRoom().then(() => { roomHydrated = true; }, (e: unknown) => {
      console.log(JSON.stringify({ msg: 'room hydration failed; retrying', error: e instanceof Error ? e.message : String(e) }));
      setTimeout(hydrate, 5000).unref();
    });
    void hydrate();
  }
  const app = await buildApp({ ...runtime.app, knowledgeDeps: knowledge,
    readiness: [...runtime.app.readiness, { name: 'knowledge', check: () => knowledgeReady(knowledge) }, { name: 'room', check: async () => roomHydrated }], serveWeb: true, logger: true });
  app.addHook('onClose', async () => { await knowledge.close?.(); await runtime.close(); });
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host: '0.0.0.0', port });
} else if (role === 'worker') {
  const { createRuntime } = await import('./bootstrap.js');
  const runtime = await createRuntime(process.env);
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const knowledge = createKnowledgeDeps(runtime);
  if (!await knowledgeReady(knowledge)) { await knowledge.close?.(); await runtime.close(); throw Error('Knowledge migrations are required before starting the worker'); }
  let lastHeartbeat = 0;
  try { await runWorker({ runtime, signal: controller.signal, heartbeatMs: 1000,
    ticks: [
      async () => { await tickKnowledge(knowledge, runtime.config.platformTenantId); },
      // T-41 queue: one claim per tick for kinds with a registered handler; nothing claimed without one.
      async () => {
        if (!runtime.pool) return;
        const pool = runtime.pool;
        await dispatchBound({ query: async <T>(text: string, params: readonly unknown[]) => ({ rows: (await pool.query(text, params as unknown[])).rows as T[] }) }, runtimeState.queue, process.env.WORKER_ID ?? 'worker');
      },
    ],
    log: entry => { if (entry.msg !== 'worker heartbeat' || Date.now() - lastHeartbeat >= 15_000) { console.log(JSON.stringify(entry)); lastHeartbeat = Date.now(); } },
  }); } finally { await knowledge.close?.(); }
} else {
  // APP_ROLE=browser: one sandbox run per Job execution (browser image variant, Dockerfile.browser).
  const { runFromEnv } = await import('./browser/runner.js');
  await runFromEnv();
}
