import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

/** In Azure, DATABASE_URL is built at startup from managed identity (Entra auth); never a stored password. */
export function createDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_MAX ?? 10) });
  return { db: drizzle(pool, { schema }), pool };
}
export { schema };
