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

const INSERT_RUN = `
INSERT INTO execution_run (id, tenant_id, instance_id, payload)
VALUES ($1, $2, $3, $4::jsonb)
ON CONFLICT (tenant_id, instance_id) DO NOTHING
RETURNING id
`.trim();

const UPDATE_RUN = `
UPDATE execution_run SET payload = $4::jsonb
WHERE id = $1 AND tenant_id = $2 AND instance_id = $3
`.trim();

const LOAD_ONE = `SELECT payload FROM execution_run WHERE tenant_id = $1 AND instance_id = $2`;
const LOAD_BY_ID = `SELECT payload FROM execution_run WHERE id = $1`;
const LOAD_CLAIMED = `SELECT payload FROM execution_run`;

/** Insert one claimed run. False means another process already owns this instance. */
export async function insertRun(db: Queryable, run: Execution): Promise<boolean> {
  const result = await db.query<{ id: string }>(INSERT_RUN, [run.id, run.tenantId, run.instanceId, JSON.stringify(run)]);
  return result.rows.length > 0;
}

/** Replace the payload of a run this process already inserted. Does not create a row and does not touch other runs. */
export async function updateRun(db: Queryable, run: Execution): Promise<void> {
  await db.query(UPDATE_RUN, [run.id, run.tenantId, run.instanceId, JSON.stringify(run)]);
}

export async function loadRunByInstance(db: Queryable, tenantId: string, instanceId: string): Promise<Execution | null> {
  const result = await db.query<{ payload: Execution }>(LOAD_ONE, [tenantId, instanceId]);
  return result.rows[0]?.payload ?? null;
}

export async function loadRunById(db: Queryable, id: string): Promise<Execution | null> {
  const result = await db.query<{ payload: Execution }>(LOAD_BY_ID, [id]);
  return result.rows[0]?.payload ?? null;
}

export async function loadClaimedRuns(db: Queryable): Promise<Execution[]> {
  const result = await db.query<{ payload: Execution }>(LOAD_CLAIMED, []);
  return result.rows.map((row) => row.payload);
}
