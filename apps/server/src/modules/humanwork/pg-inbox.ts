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

const INSERT_ITEM = `
INSERT INTO work_item (id, tenant_id, execution_id, payload)
VALUES ($1, $2, $3, $4::jsonb)
ON CONFLICT (id) DO NOTHING
`.trim();

const LOAD_ITEMS = `SELECT payload FROM work_item WHERE execution_id = $1`;
const LOAD_ALL_ITEMS = `SELECT payload FROM work_item`;

const UPDATE_ITEM = `UPDATE work_item SET payload = $2::jsonb WHERE id = $1`;

/** Store one work item without rewriting the shared inbox snapshot. A second insert leaves the stored row. */
export async function insertWorkItem(db: Queryable, item: WorkItem): Promise<void> {
  const executionId = typeof item.payload.executionId === 'string' ? item.payload.executionId : '';
  await db.query(INSERT_ITEM, [item.id, item.tenantId, executionId, JSON.stringify(item)]);
}

/** Write the current decision onto the existing row. Does not create a row and does not touch the snapshot. */
export async function updateWorkItem(db: Queryable, item: WorkItem): Promise<void> {
  await db.query(UPDATE_ITEM, [item.id, JSON.stringify(item)]);
}

export async function loadWorkItemsForRun(db: Queryable, executionId: string): Promise<WorkItem[]> {
  const result = await db.query<{ payload: WorkItem }>(LOAD_ITEMS, [executionId]);
  return result.rows.map((row) => row.payload);
}

export async function loadWorkItems(db: Queryable): Promise<WorkItem[]> {
  const result = await db.query<{ payload: WorkItem }>(LOAD_ALL_ITEMS, []);
  return result.rows.map((row) => row.payload);
}
