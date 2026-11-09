/**
 * Document Intelligence end to end inside the knowledge layer: real adapter (src/plugins/document-intelligence.ts)
 * + DocIntelParser bridge + local-file plugin + sync engine, against a fake fetch. No Azure resource is called.
 */
import { describe, it, expect } from 'vitest';
import { SourceError } from '@superagent/shared';
import { DocumentIntelligenceAdapter } from '../src/plugins/document-intelligence.js';
import { DocIntelParser, mimeFor } from '../src/modules/knowledge/docintel-parser.js';
import { createLocalFilePlugin } from '../src/modules/knowledge/plugins/local-file.js';
import { KnowledgeStore } from '../src/modules/knowledge/store.js';
import { syncConnection } from '../src/modules/knowledge/sync.js';

const endpoint = 'https://synthetic.cognitiveservices.azure.com';
const opUrl = `${endpoint}/documentintelligence/documentModels/prebuilt-layout/analyzeResults/00000000-0000-0000-0000-000000000001?api-version=2024-11-30`;

const layout = {
  status: 'succeeded',
  analyzeResult: {
    apiVersion: '2024-11-30',
    modelId: 'prebuilt-layout',
    stringIndexType: 'utf16CodeUnit',
    content: 'Invoice total 480.00\nPaid in full',
    pages: [
      { pageNumber: 1, spans: [{ offset: 0, length: 20 }], lines: [{ content: 'Invoice total 480.00', spans: [{ offset: 0, length: 20 }] }] },
      { pageNumber: 2, spans: [{ offset: 21, length: 12 }], lines: [{ content: 'Paid in full', spans: [{ offset: 21, length: 12 }] }] },
    ],
  },
};

function fakeAzure(script: ((url: string, init: RequestInit) => Response)[]) {
  const seen: { url: string; method: string; auth: string | null; redirect?: RequestRedirect }[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    seen.push({ url, method: init.method ?? 'GET', auth: new Headers(init.headers).get('authorization'), redirect: init.redirect });
    const step = script.shift();
    if (!step) throw new Error('unexpected extra request');
    return step(url, init);
  }) as typeof globalThis.fetch;
  const adapter = new DocumentIntelligenceAdapter({ endpoint, fetch, getToken: async () => ({ token: 'mi-token' }) });
  return { parser: new DocIntelParser(adapter, { sleep: async () => undefined }), seen };
}

const accepted = (loc = opUrl) => () => new Response(null, { status: 202, headers: { 'operation-location': loc, 'retry-after': '0' } });
const json = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

const files = new Map([['up', [{ name: 'invoice.pdf', bytes: new Uint8Array([37, 80, 68, 70]), version: 'h1', audience: ['grp-ap'] }]]]);
function storeWith() {
  const store = new KnowledgeStore();
  store.connections.set('up', { id: 'up', pluginId: 'local-file', scope: {}, credentialRef: null, status: 'confirmed', cursor: null, confirmedBy: 'owner' });
  return store;
}

describe('Document Intelligence parsing in the knowledge layer', () => {
  it('start → poll (running) → succeeded: page/line anchors reach the chunks, with the managed-identity token and no redirects', async () => {
    const { parser, seen } = fakeAzure([accepted(), json({ status: 'running' }), json(layout)]);
    const store = storeWith();
    const r = await syncConnection(store, createLocalFilePlugin(files, parser), 'up');
    expect(r).toMatchObject({ applied: 1, cursorAdvanced: true });
    expect(store.chunks.map((c) => [c.text, c.locator])).toEqual(
      expect.arrayContaining([
        ['Invoice total 480.00', 'invoice.pdf page 1 / line 1'],
        ['Paid in full', 'invoice.pdf page 2 / line 1'],
      ]),
    );
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET', 'GET']);
    expect(seen.every((s) => s.auth === 'Bearer mi-token' && s.redirect === 'error')).toBe(true);
    expect(seen[0]!.url).toContain('/documentintelligence/documentModels/prebuilt-layout:analyze');
  });

  it('an Operation-Location on another host is refused before any request carries the token there', async () => {
    const { parser, seen } = fakeAzure([accepted('https://evil.example/steal')]);
    await expect(parser.parse(new Uint8Array([1]), 'a.pdf')).rejects.toMatchObject({ kind: 'fatal' });
    expect(seen.map((s) => s.url).some((u) => u.startsWith('https://evil.example'))).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('succeeded without a valid analyzeResult is an error, not an empty document', async () => {
    const { parser } = fakeAzure([accepted(), json({ status: 'succeeded' })]);
    await expect(parser.parse(new Uint8Array([1]), 'a.pdf')).rejects.toBeInstanceOf(SourceError);
  });

  it('401 maps to SourceError auth, so the sync engine marks the connection for re-authorisation', async () => {
    const { parser } = fakeAzure([() => new Response(null, { status: 401 })]);
    const store = storeWith();
    const r = await syncConnection(store, createLocalFilePlugin(files, parser), 'up');
    expect(r.cursorAdvanced).toBe(false);
    expect(store.connections.get('up')!.status).toBe('needs_reauth');
  });

  it('throttling leaves the cursor in place for a later retry', async () => {
    const { parser } = fakeAzure([() => new Response(null, { status: 429, headers: { 'retry-after': '1' } })]);
    const store = storeWith();
    const r = await syncConnection(store, createLocalFilePlugin(files, parser), 'up');
    expect(r.cursorAdvanced).toBe(false);
    expect(store.connections.get('up')!.status).toBe('confirmed');
    expect(store.chunks).toEqual([]);
  });

  it('still running after the poll budget → transient (retried on the next sync); unsupported types are refused', async () => {
    const running = Array.from({ length: 3 }, () => json({ status: 'running' }));
    const fake = fakeAzure([accepted(), ...running]);
    const p = new DocIntelParser((fake.parser as unknown as { adapter: DocumentIntelligenceAdapter }).adapter, { maxPolls: 3, sleep: async () => undefined });
    await expect(p.parse(new Uint8Array([1]), 'slow.pdf')).rejects.toMatchObject({ kind: 'transient' });
    await expect(p.parse(new Uint8Array([1]), 'archive.zip')).rejects.toMatchObject({ kind: 'fatal' });
    expect(mimeFor('Report.DOCX')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
});
