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
import { connectors } from '../../server/src/modules/execution/index.js';

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
const app = await buildApp({
  knowledgeDeps: knowledge.deps,
  serveWeb: true,
  auth: { mode: 'dev', platformTenantId: 'e2e' },
  setupDeps: {
    repo: new InMemoryConfigRepo(),
    secrets: new InMemorySecretStore(),
    allowlist: new StaticAllowlist({ anthropic: { 'stub-large': { chat: true, tools: true, structured: true, stream: true } } }),
    fetchFn: (url, init) => fetch(String(url).replace('https://api.anthropic.com', stub), init),
  },
});
// The real SOP runtime (T-41) is mounted by buildApp. Test-only hook: start an instance pinned to a version, as a
// trigger would, so specs can show that publishing a new version leaves running instances on the old one.
let e2eEvent = 0;
app.post<{ Params: { id: string } }>('/__e2e/sop/versions/:id/instances', async (req) => sopState.current.manualStart('e2e', req.params.id, `e2e-event-${++e2eEvent}`, true));
// Synthetic ERP for the main-line E2E: the connector for tool e2e.erp.pay writes to this in-memory ledger and
// returns what the ledger then holds (read-back). mode "mismatch" makes the system store a different amount.
const erp = { mode: 'ok' as 'ok' | 'mismatch', ledger: new Map<string, Record<string, unknown>>() };
connectors.set('e2e.erp.pay', (params) => {
  const stored = { ...params, ...(erp.mode === 'mismatch' ? { amount: Number(params.amount) * 10 } : {}) };
  erp.ledger.set(String(params.invoiceNo), stored);
  return { externalRef: `ERP-${String(params.invoiceNo)}`, actual: { ...stored } };
});
app.post<{ Body: { mode: 'ok' | 'mismatch' } }>('/__e2e/erp/mode', async (req) => ((erp.mode = req.body.mode), { mode: erp.mode }));
app.get('/__e2e/erp/ledger', async () => Object.fromEntries(erp.ledger));
await knowledge.attach(app);
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 4173) });
console.log(JSON.stringify({ msg: 'e2e server ready', stub }));
