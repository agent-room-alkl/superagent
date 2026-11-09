import { APP_ROLES, type AppRole } from '@superagent/shared';
import { buildApp } from './app.js';
import { runWorker } from './worker.js';
import { createKnowledgeDeps } from './modules/knowledge/runtime.js';
import { tickKnowledge } from './modules/knowledge/worker.js';

const role = (process.env.APP_ROLE ?? 'web') as AppRole;
if (!APP_ROLES.includes(role)) {
  console.error(`Unknown APP_ROLE "${role}". Expected one of: ${APP_ROLES.join(', ')}`);
  process.exit(1);
}

if (role === 'web') {
  const { createRuntime } = await import('./bootstrap.js');
  const runtime = await createRuntime(process.env); // throws BootstrapError naming missing settings → container exits
  const app = await buildApp({ ...runtime.app, knowledgeDeps: createKnowledgeDeps(runtime), serveWeb: true, logger: true });
  app.addHook('onClose', () => runtime.close());
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host: '0.0.0.0', port });
} else if (role === 'worker') {
  const { createRuntime } = await import('./bootstrap.js');
  const runtime = await createRuntime(process.env);
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  const knowledge = createKnowledgeDeps(runtime);
  let lastHeartbeat = 0;
  await runWorker({ runtime, signal: controller.signal, heartbeatMs: 1000,
    ticks: [async () => { await tickKnowledge(knowledge, runtime.config.platformTenantId); }],
    log: entry => { if (entry.msg !== 'worker heartbeat' || Date.now() - lastHeartbeat >= 15_000) { console.log(JSON.stringify(entry)); lastHeartbeat = Date.now(); } },
  });
} else {
  // APP_ROLE=browser: one sandbox run per Job execution (browser image variant, Dockerfile.browser).
  const { runFromEnv } = await import('./browser/runner.js');
  await runFromEnv();
}
