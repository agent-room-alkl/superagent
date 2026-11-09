import { APP_ROLES, type AppRole } from '@superagent/shared';
import { buildApp } from './app.js';
import { runWorker } from './worker.js';

const role = (process.env.APP_ROLE ?? 'web') as AppRole;
if (!APP_ROLES.includes(role)) {
  console.error(`Unknown APP_ROLE "${role}". Expected one of: ${APP_ROLES.join(', ')}`);
  process.exit(1);
}

if (role === 'web') {
  const app = await buildApp({ serveWeb: true, logger: true });
  const port = Number(process.env.PORT ?? 8080);
  await app.listen({ host: '0.0.0.0', port });
} else if (role === 'worker') {
  await runWorker();
} else {
  // APP_ROLE=browser: one sandbox run per Job execution (browser image variant, Dockerfile.browser).
  const { runFromEnv } = await import('./browser/runner.js');
  await runFromEnv();
}
