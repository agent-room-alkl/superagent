import { APP_ROLES, type AppRole } from '@superagent/shared';
import { buildApp } from './app.js';
import { runWorker } from './worker.js';
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
  const app = await buildApp({ ...runtime.app, knowledgeDeps: knowledge,
    readiness: [...runtime.app.readiness, { name: 'knowledge', check: () => knowledgeReady(knowledge) }], serveWeb: true, logger: true });
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
    ticks: [async () => { await tickKnowledge(knowledge, runtime.config.platformTenantId); }],
    log: entry => { if (entry.msg !== 'worker heartbeat' || Date.now() - lastHeartbeat >= 15_000) { console.log(JSON.stringify(entry)); lastHeartbeat = Date.now(); } },
  }); } finally { await knowledge.close?.(); }
} else {
  // APP_ROLE=browser: one sandbox run per Job execution (browser image variant, Dockerfile.browser).
  const { runFromEnv } = await import('./browser/runner.js');
  await runFromEnv();
}
