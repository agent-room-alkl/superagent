import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { OutcomeUnknownError, ToolGateway, payloadHash } from './gateway.js';
import { loadGatewaySnapshot, saveGatewaySnapshot } from './pg-gateway.js';

const databaseUrl = process.env.DATABASE_URL;
const live = databaseUrl ? it : it.skip;
const schema = `t41gw_${randomUUID().replace(/-/g, '')}`;

const DDL = `
CREATE SCHEMA "${schema}";
CREATE TABLE "${schema}".gateway_actions (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  instance_id text NOT NULL,
  step_id text NOT NULL,
  business_key text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  effect text NOT NULL,
  payload jsonb NOT NULL,
  payload_hash text NOT NULL,
  approval_hash text,
  identity jsonb,
  intended jsonb,
  status text NOT NULL,
  external_ref text,
  readback jsonb,
  calls integer NOT NULL,
  inconsistent boolean NOT NULL,
  reason text
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

live('a second process read-back confirms an unknown write and does not call again', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const admin = await pool.connect();
  try {
    await admin.query(DDL);
    const db = bound(pool);
    const gateway = new ToolGateway();
    const payload = { amount: 40 };
    const hash = payloadHash(payload);
    gateway.execute({
      tenantId: 't', instanceId: 'inst', stepId: 'write', businessKey: 'invoice-9',
      effect: 'write', payload, intended: payload, approvalHash: hash, authorize: () => true,
      call: () => { throw new OutcomeUnknownError(); },
    });
    await saveGatewaySnapshot(db, gateway.snapshot());

    const restored = new ToolGateway();
    restored.load(await loadGatewaySnapshot(db));
    let calls = 0;
    const again = restored.execute({
      tenantId: 't', instanceId: 'inst', stepId: 'write', businessKey: 'invoice-9',
      effect: 'write', payload, intended: payload, approvalHash: hash, authorize: () => true,
      call: () => { calls += 1; return { actual: payload }; },
    });
    expect(again.invoked).toBe(false);
    expect(again.action.status).toBe('outcome_unknown');
    const read = restored.readBack(again.action.idempotencyKey, payload);
    expect(read.invoked).toBe(false);
    expect(read.action.status).toBe('confirmed');
    expect(read.action.calls).toBe(1);
    expect(calls).toBe(0);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    admin.release();
    await pool.end();
  }
});

live('a write flushed before the call is not sent by the next process', async () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const armed = `t41arm_${randomUUID().replace(/-/g, '')}`;
  const admin = await pool.connect();
  const db = {
    async query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO "${armed}"`);
        const result = await client.query(sql, params as unknown[]);
        return { rows: result.rows as T[] };
      } finally {
        client.release();
      }
    },
  };
  try {
    await admin.query(DDL.replaceAll(`"${schema}"`, `"${armed}"`));
    const gateway = new ToolGateway();
    const payload = { amount: 40 };
    const hash = payloadHash(payload);
    const reserved = gateway.reserve({
      tenantId: 't', instanceId: 'inst', stepId: 'write', businessKey: 'invoice-armed',
      effect: 'write', payload, intended: payload, approvalHash: hash, authorize: () => true,
      call: () => { throw new Error('the first process has not called yet'); },
    });
    expect(reserved.pending).toBe(true);
    expect(reserved.action.calls).toBe(0);
    await saveGatewaySnapshot(db, gateway.snapshot());

    const restored = new ToolGateway();
    restored.load(await loadGatewaySnapshot(db));
    let calls = 0;
    const again = restored.execute({
      tenantId: 't', instanceId: 'inst', stepId: 'write', businessKey: 'invoice-armed',
      effect: 'write', payload, intended: payload, approvalHash: hash, authorize: () => true,
      call: () => { calls += 1; return { actual: payload }; },
    });
    expect(calls).toBe(0);
    expect(again.invoked).toBe(false);
    expect(again.action.status).toBe('outcome_unknown');
    expect(again.action.reason).toBe('interrupted');
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${armed}" CASCADE`);
    admin.release();
    await pool.end();
  }
});
