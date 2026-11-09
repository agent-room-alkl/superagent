import { afterEach, describe, expect, it, vi } from 'vitest';
import { SourceError } from '@superagent/shared';
import { DocumentIntelligenceAdapter, type DocumentIntelligenceOptions } from './document-intelligence.js';

const endpoint = 'https://synthetic.cognitiveservices.azure.com';
const operationLocation = `${endpoint}/documentintelligence/documentModels/prebuilt-layout/analyzeResults/00000000-0000-0000-0000-000000000001?api-version=2024-11-30`;
const ref = { operationLocation, retryAfterMs: 1_000 };
const bytes = new Uint8Array([37, 80, 68, 70]);

function fixture() {
  return {
    status: 'succeeded', createdDateTime: '2026-01-01T00:00:00Z', lastUpdatedDateTime: '2026-01-01T00:00:01Z',
    analyzeResult: {
      apiVersion: '2024-11-30', modelId: 'prebuilt-layout', stringIndexType: 'utf16CodeUnit',
      content: 'A😀\nBeta',
      pages: [
        { pageNumber: 1, spans: [{ offset: 0, length: 4 }], lines: [{ content: 'A😀', spans: [{ offset: 0, length: 3 }] }] },
        { pageNumber: 2, spans: [{ offset: 4, length: 4 }], lines: [{ content: 'Beta', spans: [{ offset: 4, length: 4 }] }] },
      ],
      paragraphs: [
        { content: 'A😀', boundingRegions: [{ pageNumber: 1 }], spans: [{ offset: 0, length: 3 }] },
        { content: 'Beta', boundingRegions: [{ pageNumber: 2 }], spans: [{ offset: 4, length: 4 }] },
      ],
    },
  };
}

function harness(responses: Response[], options: Partial<DocumentIntelligenceOptions> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected extra request');
    return response;
  });
  const getToken = vi.fn().mockResolvedValue({ token: 'synthetic-token' });
  const adapter = new DocumentIntelligenceAdapter({ endpoint, fetch, getToken, ...options });
  return { adapter, fetch, getToken };
}

function json(value: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status: 200, headers });
}

afterEach(() => { vi.useRealTimers(); });

describe('DocumentIntelligenceAdapter REST contract', () => {
  it('submits only server-owned bytes with Entra auth and persists the validated 202 operation', async () => {
    const { adapter, fetch, getToken } = harness([
      new Response(null, { status: 202, headers: { 'Operation-Location': operationLocation, 'Retry-After': '3' } }),
    ]);
    expect(await adapter.start(bytes, 'application/pdf')).toEqual({ operationLocation, retryAfterMs: 3_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [target, request] = fetch.mock.calls[0]!;
    const url = new URL(String(target));
    expect(url.pathname).toBe('/documentintelligence/documentModels/prebuilt-layout:analyze');
    expect(Object.fromEntries(url.searchParams)).toEqual({ _overload: 'analyzeDocument', 'api-version': '2024-11-30', stringIndexType: 'utf16CodeUnit' });
    expect(JSON.parse(String(request?.body))).toEqual({ base64Source: 'JVBERg==' });
    expect(request?.headers).toEqual({ Authorization: 'Bearer synthetic-token', 'Content-Type': 'application/json', Accept: 'application/json' });
    expect(request?.redirect).toBe('error');
    expect(getToken).toHaveBeenCalledWith('https://cognitiveservices.azure.com/.default', { abortSignal: expect.any(AbortSignal) });
  });

  it.each(['running', 'notStarted'])('makes one poll for %s and returns a capped scheduling delay', async (status) => {
    const { adapter, fetch } = harness([json({ status }, { 'Retry-After': '90000' })]);
    expect(await adapter.poll(ref)).toEqual({ status: 'running', retryAfterMs: 60_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('preserves UTF-16 offsets, page spans, paragraphs and lines without approval metadata', async () => {
    const { adapter } = harness([json(fixture())]);
    const result = await adapter.poll(ref);
    expect(result).toEqual({ status: 'succeeded', content: {
      text: 'A😀\nBeta',
      anchors: [
        { start: 0, end: 4, locator: 'page 1' },
        { start: 0, end: 3, locator: 'page 1 / line 1' },
        { start: 4, end: 8, locator: 'page 2' },
        { start: 4, end: 8, locator: 'page 2 / line 1' },
        { start: 0, end: 3, locator: 'page 1 / paragraph 1' },
        { start: 4, end: 8, locator: 'page 2 / paragraph 2' },
      ],
    } });
    if (result.status !== 'succeeded') throw new Error('Expected extraction');
    expect(result.content.text.slice(4, 8)).toBe('Beta');
  });

  it('maps a terminal provider failure without exposing provider messages', async () => {
    const { adapter } = harness([json({ status: 'failed', error: { code: 'InvalidContent', message: 'private document text' } })]);
    const result = await adapter.poll(ref);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('Expected failure');
    expect(result.error).toBeInstanceOf(SourceError);
    expect(result.error.kind).toBe('fatal');
    expect(result.error.message).not.toContain('private');
  });

  it.each([[401, 'auth'], [403, 'scope'], [404, 'not_found'], [429, 'throttled'], [503, 'transient'], [400, 'fatal']])(
    'maps HTTP %s into %s', async (status, kind) => {
      const { adapter } = harness([new Response('not a JSON success', { status: Number(status), headers: { 'Retry-After': '2' } })]);
      await expect(adapter.poll(ref)).rejects.toMatchObject({ kind, ...(status === 429 || status === 503 ? { retryAfterMs: 2_000 } : {}) });
    },
  );

  it('uses HTTP-date Retry-After and does not retry automatically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { adapter, fetch } = harness([new Response(null, { status: 429, headers: { 'Retry-After': 'Thu, 01 Jan 2026 00:00:05 GMT' } })]);
    await expect(adapter.start(bytes, 'application/pdf')).rejects.toMatchObject({ kind: 'throttled', retryAfterMs: 5_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('bounds requests even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}));
    const { adapter } = harness([], { fetch, timeoutMs: 50 });
    const pending = expect(adapter.poll(ref)).rejects.toMatchObject({ kind: 'transient', message: expect.stringContaining('timed out') });
    await vi.advanceTimersByTimeAsync(51);
    await pending;
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('bounds token acquisition and never sends an expired request after its deadline', async () => {
    vi.useFakeTimers();
    let resolveToken!: (value: string) => void;
    const { adapter, fetch } = harness([], { getToken: () => new Promise((resolve) => { resolveToken = resolve; }), timeoutMs: 50 });
    const pending = expect(adapter.poll(ref)).rejects.toMatchObject({ kind: 'transient' });
    await vi.advanceTimersByTimeAsync(51);
    await pending;
    resolveToken('late-token');
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps missing credentials and network failure without leaking error messages', async () => {
    const missing = harness([], { getToken: async () => null });
    await expect(missing.adapter.poll(ref)).rejects.toMatchObject({ kind: 'auth' });
    expect(missing.fetch).not.toHaveBeenCalled();
    const broken = harness([], { fetch: async () => { throw new Error('secret network detail'); } });
    await expect(broken.adapter.poll(ref)).rejects.toMatchObject({ kind: 'transient', message: 'Document Intelligence request failed.' });
  });
});

describe('DocumentIntelligenceAdapter boundaries', () => {
  it.each([
    'http://synthetic.cognitiveservices.azure.com', 'https://attacker.example',
    'https://synthetic.cognitiveservices.azure.com.attacker.example',
    `${endpoint}/custom`, `https://user:pass@synthetic.cognitiveservices.azure.com`,
  ])('rejects untrusted endpoint %s', (value) => {
    expect(() => harness([], { endpoint: value })).toThrow(SourceError);
  });

  it.each([
    operationLocation.replace(endpoint, 'https://attacker.example'),
    operationLocation.replace('prebuilt-layout', 'other-model'),
    operationLocation.replace('/analyzeResults/', '/analyzeResults/%2f'),
    operationLocation.replace('2024-11-30', '2023-07-31'),
    `${operationLocation}&api-version=2024-11-30`, `${operationLocation}#fragment`,
    `${operationLocation}&other=secret`,
  ])('rejects an unsafe persisted operation before requesting a token: %s', async (operationLocation) => {
    const { adapter, fetch, getToken } = harness([]);
    await expect(adapter.poll({ operationLocation, retryAfterMs: 0 })).rejects.toMatchObject({ kind: 'fatal' });
    expect(getToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsafe or missing operation locations returned on submission', async () => {
    for (const headers of [{ 'Operation-Location': 'https://attacker.example/result' }, {}] as HeadersInit[]) {
      const { adapter, fetch } = harness([new Response(null, { status: 202, headers })]);
      await expect(adapter.start(bytes, 'application/pdf')).rejects.toMatchObject({ kind: 'fatal' });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('disables redirects on both start and poll and rejects unexpected redirect responses', async () => {
    const { adapter, fetch } = harness([
      new Response(null, { status: 302, headers: { Location: 'https://attacker.example' } }),
      new Response(null, { status: 307, headers: { Location: 'https://attacker.example' } }),
    ]);
    await expect(adapter.start(bytes, 'application/pdf')).rejects.toMatchObject({ kind: 'fatal' });
    await expect(adapter.poll(ref)).rejects.toMatchObject({ kind: 'fatal' });
    expect(fetch.mock.calls.every(([, request]) => request?.redirect === 'error')).toBe(true);
  });

  it('rejects empty/oversized bytes and unsupported MIME types before acquiring credentials', async () => {
    const { adapter, getToken } = harness([], { maxBytes: 3 });
    await expect(adapter.start(bytes, 'application/pdf')).rejects.toMatchObject({ kind: 'fatal' });
    await expect(adapter.start(new Uint8Array(), 'application/pdf')).rejects.toMatchObject({ kind: 'fatal' });
    await expect(adapter.start(new Uint8Array([1]), 'application/x-executable')).rejects.toMatchObject({ kind: 'fatal' });
    expect(getToken).not.toHaveBeenCalled();
  });

  it('bounds streamed responses even when Content-Length is omitted or understated', async () => {
    for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': '999' }] as HeadersInit[]) {
      const { adapter } = harness([json(fixture(), headers)], { maxResponseBytes: 100 });
      await expect(adapter.poll(ref)).rejects.toMatchObject({ kind: 'fatal', message: expect.stringContaining('byte limit') });
    }
  });

  it.each(['invalid JSON', '{"status":"imaginary"}', '{"status":"failed"}', '{"status":"succeeded"}'])('rejects malformed result %s', async (body) => {
    const { adapter } = harness([new Response(body)]);
    await expect(adapter.poll(ref)).rejects.toMatchObject({ kind: 'fatal' });
  });

  it.each([
    { offset: -1, length: 2 }, { offset: 0.5, length: 2 }, { offset: 0, length: 99 },
    { offset: 2, length: 1 }, { offset: 1, length: 1 }, { offset: 0, length: -1 },
  ])('rejects out-of-bounds and split-surrogate spans %j', async (span) => {
    const payload = fixture();
    payload.analyzeResult.pages[0]!.spans = [span];
    const { adapter } = harness([json(payload)]);
    await expect(adapter.poll(ref)).rejects.toMatchObject({ kind: 'fatal' });
  });

  it('requires the requested UTF-16 result type and valid paragraph page references', async () => {
    const wrongIndex = fixture();
    wrongIndex.analyzeResult.stringIndexType = 'unicodeCodePoint';
    const wrongPage = fixture();
    wrongPage.analyzeResult.paragraphs[0]!.boundingRegions[0]!.pageNumber = 99;
    for (const payload of [wrongIndex, wrongPage]) {
      const { adapter } = harness([json(payload)]);
      await expect(adapter.poll(ref)).rejects.toMatchObject({ kind: 'fatal' });
    }
  });
});
