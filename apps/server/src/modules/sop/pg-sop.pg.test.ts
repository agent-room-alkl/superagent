import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { claimSopEvent, loadPublishedVersion, loadSopSnapshot, saveSopSnapshot } from './pg-sop.js';
import { SopRuntime, type SopDefinition } from './sop.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;
const schema = `t41sop_${randomUUID().replace(/-/g, '')}`;

const ready: SopDefinition = {
  requiredFields: ['title', 'amount'],
  threshold: { field: 'amount', max: 1000 },
  employeeStatus: 'active',
};

const DDL = `
CREATE SCHEMA "${schema}";
CREATE TABLE "${schema}".sop_versions (
  id text PRIMARY KEY,
  sop_id text NOT NULL,
  number integer NOT NULL,
  definition jsonb NOT NULL,
  status text NOT NULL,
  report jsonb,
  revision integer NOT NULL,
  validated_revision integer,
  effective_at text,
  UNIQUE (sop_id, number)
);
CREATE TABLE "${schema}".sop_instances (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  sop_id text NOT NULL,
  sop_version_id text NOT NULL,
  version_number integer NOT NULL,
  event_key text NOT NULL UNIQUE,
  status text NOT NULL
);
CREATE TABLE "${schema}".sop_events (
  tenant_id text NOT NULL,
  source text NOT NULL,
  event_id text NOT NULL,
  sop_id text NOT NULL,
  event_key text NOT NULL UNIQUE,
  disposition text NOT NULL,
  PRIMARY KEY (tenant_id, source, event_id, sop_id)
);
CREATE TABLE "${schema}".sop_runtime_seq (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  seq integer NOT NULL
);
`;

function bound(pool: pg.Pool) {
  return {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${schema}"`);
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as T[] };
      } finally {
        client.release();
      }
    },
  };
}

live('a second process reads the published SOP and cannot claim the same event', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const admin = await pool.connect();
  try {
    await admin.query(DDL);
    const writer = bound(pool);
    const runtime = new SopRuntime();
    const version = runtime.draft('inquiry', ready);
    runtime.validate(version.id);
    runtime.publish(version.id, '2026-11-10T00:00:00.000Z');
    runtime.manualStart('tenant-a', version.id, 'mail-1', true);
    await saveSopSnapshot(writer, runtime.snapshot());

    const reader = bound(pool);
    const published = await loadPublishedVersion(reader, 'inquiry');
    expect(published?.status).toBe('published');
    expect(published?.id).toBe(version.id);
    expect(published?.effectiveAt).toBe('2026-11-10T00:00:00.000Z');

    const restored = SopRuntime.restore(await loadSopSnapshot(reader));
    expect(restored.manualStart('tenant-a', version.id, 'mail-1', true)).toBeNull();
    expect(await claimSopEvent(reader, { tenantId: 'tenant-a', source: 'manual', eventId: 'mail-1', sopId: 'inquiry' })).toBe(false);
    expect(await claimSopEvent(reader, { tenantId: 'tenant-a', source: 'mail', eventId: 'mail-2', sopId: 'inquiry' })).toBe(true);
    expect(await claimSopEvent(reader, { tenantId: 'tenant-a', source: 'mail', eventId: 'mail-2', sopId: 'inquiry' })).toBe(false);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    admin.release();
    await pool.end();
  }
});
