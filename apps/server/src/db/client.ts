import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/**
 * Connection settings.
 * - Local/CI: DATABASE_URL.
 * - Azure: PG_HOST / PG_DATABASE / PG_USER with an Entra access token as the password, obtained through the
 *   container's managed identity and refreshed per connection. No stored database password (PRD §6.2).
 */
export function poolConfig(env = process.env): pg.PoolConfig {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, max: Number(env.DB_POOL_MAX ?? 10) };
  if (!env.PG_HOST || !env.PG_USER) throw new Error('Set DATABASE_URL, or PG_HOST and PG_USER for Entra authentication');
  return {
    host: env.PG_HOST,
    database: env.PG_DATABASE ?? 'superagent',
    user: env.PG_USER,
    port: 5432,
    ssl: { rejectUnauthorized: true },
    max: Number(env.DB_POOL_MAX ?? 10),
    password: entraTokenProvider(),
  };
}

/** Returns a function pg calls for each new connection; tokens are cached until shortly before expiry. */
export function entraTokenProvider(): () => Promise<string> {
  let cached: { token: string; expiresOn: number } | null = null;
  return async () => {
    if (cached && cached.expiresOn - Date.now() > 5 * 60_000) return cached.token;
    const { DefaultAzureCredential } = await import('@azure/identity');
    const t = await new DefaultAzureCredential().getToken('https://ossrdbms-aad.database.windows.net/.default');
    if (!t) throw new Error('could not obtain Entra token for PostgreSQL');
    cached = { token: t.token, expiresOn: t.expiresOnTimestamp };
    return t.token;
  };
}

export function createDb(env = process.env) {
  const pool = new pg.Pool(poolConfig(env));
  return { db: drizzle(pool, { schema }), pool };
}
export { schema };
