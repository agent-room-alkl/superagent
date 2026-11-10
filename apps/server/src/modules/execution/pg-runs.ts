import type { Execution } from './executor.js';

export interface Queryable {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

const UPSERT = `
INSERT INTO execution_runs (id, runs, seq) VALUES (true, $1::jsonb, $2)
ON CONFLICT (id) DO UPDATE SET runs = EXCLUDED.runs, seq = EXCLUDED.seq
`.trim();

const LOAD = `SELECT runs, seq FROM execution_runs WHERE id = true`;

export async function saveRuns(db: Queryable, snapshot: { runs: Execution[]; seq: number }): Promise<void> {
  await db.query(UPSERT, [JSON.stringify(snapshot.runs), snapshot.seq]);
}

export async function loadRuns(db: Queryable): Promise<{ runs: Execution[]; seq: number } | null> {
  const result = await db.query<{ runs: Execution[]; seq: number }>(LOAD, []);
  const row = result.rows[0];
  if (!row) return null;
  return { runs: row.runs, seq: Number(row.seq) };
}
