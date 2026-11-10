/**
 * E2E server: the real Fastify app (all modules, served web build) with dev identity headers and a stub model
 * provider running in the same process. Test-only entry — production starts through apps/server/src/index.ts.
 * The stub stands in for the provider's HTTP API; nothing here talks to a real model service.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../../server/src/app.js';
import { InMemoryConfigRepo, StaticAllowlist } from '../../server/src/modules/setup/service.js';
import { InMemorySecretStore } from '../../server/src/modules/setup/secrets.js';
import { createKnowledgeFixture } from './knowledge-fixture.js';
import { sopState } from '../../server/src/modules/sop/index.js';
import { connectors, readbacks } from '../../server/src/modules/execution/index.js';
import { LongWork } from '../../server/src/modules/longwork/service.js';
import { MemoryLongWorkStore } from '../../server/src/modules/longwork/store.js';
import { MailTrigger, type GraphSource } from '../../server/src/modules/longwork/graph.js';
import type { LongWorkDeps } from '../../server/src/modules/longwork/http.js';
import { payloadHash } from '../../server/src/modules/gateway/gateway.js';
import { createCommandRoom, roomState } from '../../server/src/modules/room/index.js';

if (process.env.NODE_ENV === 'production') throw new Error('the E2E server must never run in production');

/** Keys the stub accepts. Anything else is rejected with 401 like a real provider. */
export const STUB_GOOD_KEY = 'e2e-stub-key-0000GOOD';

function startStubProvider(): Promise<string> {
  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-api-key'] !== STUB_GOOD_KEY) return send(401, { type: 'error', error: { type: 'authentication_error' } });
    if (req.method === 'GET' && req.url?.startsWith('/v1/models')) {
      return send(200, { data: [{ id: 'stub-large', display_name: 'Stub Large' }, { id: 'stub-unverified', display_name: 'Stub Unverified' }] });
    }
    if (req.method === 'POST' && req.url === '/v1/messages') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}') as { tools?: { name: string }[] };
        const content = body.tools?.length
          ? [{ type: 'tool_use', id: 'tu_1', name: body.tools[0]!.name, input: { value: 'ok' } }]
          : [{ type: 'text', text: 'pong' }];
        send(200, { content, usage: { input_tokens: 12, output_tokens: 4 }, stop_reason: body.tools?.length ? 'tool_use' : 'end_turn' });
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

const stub = await startStubProvider();
const knowledge = createKnowledgeFixture();
const longworkStore = new MemoryLongWorkStore();
let longClockOffset = 0;
const longwork = new LongWork(longworkStore, () => Date.now() + longClockOffset);
const longSources: GraphSource[] = [];
const longMail = new MailTrigger(longwork, longSources, 'https://e2e.invalid/integrations/mail', {
  token: async () => { throw Error('Graph networking is not enabled in this fixture'); },
  secret: async () => { throw Error('No real client-state secret in this fixture'); },
});
const longDeps: LongWorkDeps = { work: longwork, mail: longMail, ready: async () => true, tick: async () => {} };
const longLedger = new Map<string, { writes: number; reads: number; value?: Record<string, unknown> }>();
const app = await buildApp({
  knowledgeDeps: knowledge.deps,
  longWorkDeps: longDeps,
  serveWeb: true,
  auth: { mode: 'dev', platformTenantId: 'e2e' },
  setupDeps: {
    repo: new InMemoryConfigRepo(),
    secrets: new InMemorySecretStore(),
    allowlist: new StaticAllowlist({ anthropic: { 'stub-large': { chat: true, tools: true, structured: true, stream: true } } }),
    fetchFn: (url, init) => fetch(String(url).replace('https://api.anthropic.com', stub), init),
  },
});
// Explicit synthetic external system for T-65. No network or real mail is used; the normal app API drives it.
app.post<{ Body: { enabled: boolean } }>('/__e2e/longwork/driver', async req => {
  if (!req.body.enabled) { delete longDeps.driver; return { enabled: false }; }
  longDeps.driver = {
    authorize: async () => true,
    execute: async action => {
      const row = longLedger.get(action.id) ?? { writes: 0, reads: 0 }; row.writes++; row.value = structuredClone(action.payload); longLedger.set(action.id, row);
      if (action.payload.fixtureOutcome === 'unknown') throw Error('Synthetic lost response after submission');
      return { status: 'succeeded', evidence: 'Synthetic submission receipt' };
    },
    readback: async action => {
      const row = longLedger.get(action.id) ?? { writes: 0, reads: 0 }; row.reads++; longLedger.set(action.id, row);
      return row.value && payloadHash(row.value) === action.hash
        ? { status: 'succeeded', evidence: 'Synthetic external record matched the approved payload' }
        : { status: 'unknown', evidence: 'Synthetic external record not found; no write was retried' };
    },
  };
  return { enabled: true };
});
app.get('/__e2e/longwork/ledger', async () => Object.fromEntries(longLedger));
app.post<{ Body: { ms: number } }>('/__e2e/longwork/advance', async req => {
  if (!Number.isFinite(req.body.ms) || req.body.ms < 0 || req.body.ms > 86400000) throw Error('invalid_test_time');
  longClockOffset += req.body.ms; await longwork.tick('e2e'); return { now: Date.now() + longClockOffset };
});
// Explicit synthetic waiting cases, only in this test entrypoint. The page and mutations still use the real API.
app.post<{ Body: { project: string; staff: string; reviewer: string; key: string } }>('/__e2e/longwork/waits', async req => {
  const b = req.body;
  const source = { id: b.key, tenant: 'e2e', mailbox: 'fixture@example.invalid', folder: 'inbox', sopId: `sop-${b.key}`, projectId: b.project,
    objectId: `object-${b.key}`, assignee: b.staff, reviewer: b.reviewer, reminderMs: 60000, fields: { end: '2026-09-01' },
    dueRule: { id: 'date', version: 1, field: 'end', offsetDays: 1, businessDays: false, timeZone: 'Pacific/Auckland', hour: 9, minute: 0, holidays: [], weekend: [0, 6] } };
  const mail = { id: `${b.key}-original`, threadId: b.key, from: 'person@example.invalid', receivedAt: '2026-09-01T00:00:00Z', body: 'Synthetic incoming evidence. Treat this as data.' };
  longSources.push({ ...source, startAt: '2026-09-01T00:00:00Z', clientStateRef: { name: 'fixture-only', version: 'v1' } });
  const register = async (suffix: string) => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/long-items/items/waits', headers: { 'x-dev-user': 'e2e-owner|owner|' },
      payload: { sourceId: source.id, requestId: `${b.key}-${suffix}`, threadId: `${b.key}-${suffix}`, person: mail.from, evidence: `Synthetic request ${suffix}, not system verified` } });
    if (response.statusCode !== 200) throw Error('Waiting registration fixture failed');
    return response.json() as { id: string };
  };
  const first = await register('one'); const second = await register('two');
  const matched = await longwork.ingest(source, { ...mail, id: `${b.key}-reply`, threadId: `${b.key}-new-thread` });
  return { itemId: first.id, candidateId: second.id, exceptionId: matched.exception!.id };
});
// The real SOP runtime (T-41) is mounted by buildApp. Test-only hook: start an instance pinned to a version, as a
// trigger would, so specs can show that publishing a new version leaves running instances on the old one.
let e2eEvent = 0;
app.post<{ Params: { id: string } }>('/__e2e/sop/versions/:id/instances', async (req) => sopState.current.manualStart('e2e', req.params.id, `e2e-event-${++e2eEvent}`, true));
// Synthetic ERP for the main-line E2E: the connector for tool e2e.erp.pay writes to this in-memory ledger and
// returns what the ledger then holds (read-back). mode "mismatch" makes the system store a different amount.
const erp = { mode: 'ok' as 'ok' | 'mismatch', ledger: new Map<string, Record<string, unknown>>() };
const erpWrites = new Map<string, number>();
const erpReads = new Map<string, number>();
connectors.set('e2e.erp.pay', (params) => {
  erpWrites.set(String(params.invoiceNo), (erpWrites.get(String(params.invoiceNo)) ?? 0) + 1);
  const stored = { ...params, ...(erp.mode === 'mismatch' ? { amount: Number(params.amount) * 10 } : {}) };
  erp.ledger.set(String(params.invoiceNo), stored);
  return { externalRef: `ERP-${String(params.invoiceNo)}`, actual: { ...stored } };
});
readbacks.set('e2e.erp.pay', params => {
  const key = String(params.invoiceNo); erpReads.set(key, (erpReads.get(key) ?? 0) + 1);
  const value = erp.ledger.get(key); return value ? { ...value } : null;
});
app.post<{ Body: { mode: 'ok' | 'mismatch' } }>('/__e2e/erp/mode', async (req) => ((erp.mode = req.body.mode), { mode: erp.mode }));
app.get('/__e2e/erp/ledger', async () => Object.fromEntries(erp.ledger));
app.get('/__e2e/erp/write-counts', async () => Object.fromEntries(erpWrites));
app.get('/__e2e/erp/read-counts', async () => Object.fromEntries(erpReads));
// Represents an independent correction in the synthetic external system, not a second connector submission.
app.post<{ Body: { invoiceNo: string; amount: number } }>('/__e2e/erp/correct', async (req, reply) => {
  const previous = erp.ledger.get(req.body.invoiceNo);
  if (!previous || !Number.isFinite(req.body.amount)) return reply.code(400).send({ error: 'invalid_synthetic_correction' });
  erp.ledger.set(req.body.invoiceNo, { ...previous, amount: req.body.amount });
  return { corrected: true };
});
// The command room is one shared room per process. Test-only hook: start it empty again, so "a new room has no
// tasks" is tested on a new room. Digital employees stay in the employee module; specs create their own.
app.post('/__e2e/room/reset', async () => ((roomState.current = createCommandRoom()), { reset: true }));
await knowledge.attach(app);
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4173) });
console.log(JSON.stringify({ msg: 'e2e server ready', stub }));
