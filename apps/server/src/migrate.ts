/**
 * Migration runner (run as the Container Apps "migrate" Job before traffic switches, and in CI).
 * Applies apps/server/migrations/*.sql in name order, once each, inside a transaction per file,
 * guarded by an advisory lock so two runners can never interleave.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { poolConfig } from './db/client.js';

const LOCK_ID = 727_401; // arbitrary constant for pg_advisory_lock

export function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/ (tsx) and dist/ (node) both sit next to ../migrations
  return path.resolve(here, '../migrations');
}

export async function migrate(pool: pg.Pool, dir = migrationsDir(), log: (m: string) => void = console.log): Promise<string[]> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8').replaceAll('--> statement-breakpoint', '');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await client.query('COMMIT');
        applied.push(f);
        log(`applied ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const pool = new pg.Pool(poolConfig());
  migrate(pool)
    .then((a) => console.log(JSON.stringify({ msg: 'migrations complete', applied: a })))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
