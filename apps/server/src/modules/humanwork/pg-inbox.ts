import type { WorkItem } from './work-items.js';

export interface Queryable {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
}

const UPSERT = `
INSERT INTO work_inbox (id, items, seq) VALUES (true, $1::jsonb, $2)
ON CONFLICT (id) DO UPDATE SET items = EXCLUDED.items, seq = EXCLUDED.seq
`.trim();

const LOAD = `SELECT items, seq FROM work_inbox WHERE id = true`;

export async function saveInbox(db: Queryable, snapshot: { items: WorkItem[]; seq: number }): Promise<void> {
  await db.query(UPSERT, [JSON.stringify(snapshot.items), snapshot.seq]);
}

export async function loadInbox(db: Queryable): Promise<{ items: WorkItem[]; seq: number } | null> {
  const result = await db.query<{ items: WorkItem[]; seq: number }>(LOAD, []);
  const row = result.rows[0];
  if (!row) return null;
  return { items: row.items, seq: Number(row.seq) };
}
