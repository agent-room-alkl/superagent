import { DefaultAzureCredential } from '@azure/identity';
import { SourceError, type SourceContent, type SourceErrorKind } from '@superagent/shared';

const API_VERSION = '2024-11-30';
const MODEL_PATH = '/documentintelligence/documentModels/prebuilt-layout';
const TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';
const MAX_RETRY_MS = 60_000;
const MIME_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/tiff', 'image/bmp', 'image/heif',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'text/html',
]);

export interface DocumentOperationRef {
  operationLocation: string;
  retryAfterMs: number;
}

export type DocumentPollResult =
  | { status: 'running'; retryAfterMs: number }
  | { status: 'succeeded'; content: SourceContent }
  | { status: 'failed'; error: SourceError };

export interface DocumentIntelligenceOptions {
  endpoint: string;
  getToken?: (scope: string, options: { abortSignal: AbortSignal }) => Promise<string | { token: string } | null>;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}

/** Extracted content is untrusted source material; success does not approve a document. */
export class DocumentIntelligenceAdapter {
  private readonly endpoint: URL;
  private readonly getToken: NonNullable<DocumentIntelligenceOptions['getToken']>;
  private readonly fetch: typeof globalThis.fetch;
  private readonly maxBytes: number;
  private readonly maxResponseBytes: number;
  private readonly timeoutMs: number;

  constructor(options: DocumentIntelligenceOptions) {
    try {
      this.endpoint = new URL(options.endpoint);
    } catch {
      throw new SourceError('fatal', 'Invalid Document Intelligence endpoint.');
    }
    const endpoint = this.endpoint;
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port ||
        endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
        !/\.(?:cognitiveservices\.azure\.(?:com|us|cn)|api\.cognitive\.microsoft\.com)$/.test(endpoint.hostname)) {
      throw new SourceError('fatal', 'Document Intelligence requires a trusted HTTPS Azure service endpoint.');
    }
    const credential = options.getToken ? undefined : new DefaultAzureCredential();
    this.getToken = options.getToken ?? ((scope, requestOptions) => credential!.getToken(scope, requestOptions));
    this.fetch = options.fetch ?? globalThis.fetch;
    this.maxBytes = boundedOption(options.maxBytes, 20 * 1024 * 1024, 100 * 1024 * 1024);
    this.maxResponseBytes = boundedOption(options.maxResponseBytes, 32 * 1024 * 1024, 64 * 1024 * 1024);
    this.timeoutMs = boundedOption(options.timeoutMs, 30_000, 120_000);
  }

  async start(bytes: Uint8Array, mimeType: string): Promise<DocumentOperationRef> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > this.maxBytes) {
      throw new SourceError('fatal', 'Document is empty or exceeds the configured byte limit.');
    }
    if (!MIME_TYPES.has(mimeType.toLowerCase())) {
      throw new SourceError('fatal', 'Unsupported Document Intelligence media type.');
    }
    const url = new URL(`${MODEL_PATH}:analyze`, this.endpoint);
    url.searchParams.set('_overload', 'analyzeDocument');
    url.searchParams.set('api-version', API_VERSION);
    // JS string slicing and SourceContent anchors both use UTF-16 code units.
    url.searchParams.set('stringIndexType', 'utf16CodeUnit');
    const body = JSON.stringify({ base64Source: Buffer.from(bytes).toString('base64') });
    return this.request(url, { method: 'POST', body }, async (response) => {
      if (response.status !== 202) {
        await response.body?.cancel();
        throw httpError(response);
      }
      await response.body?.cancel();
      const location = response.headers.get('operation-location');
      if (!location) throw new SourceError('fatal', 'Azure did not return an operation location.');
      return { operationLocation: this.operationUrl(location).href, retryAfterMs: retryAfter(response) };
    });
  }

  /** Makes exactly one GET. The durable job owner schedules any subsequent poll. */
  async poll(ref: DocumentOperationRef): Promise<DocumentPollResult> {
    const url = this.operationUrl(ref.operationLocation);
    return this.request(url, { method: 'GET' }, async (response) => {
      if (response.status !== 200) {
        await response.body?.cancel();
        throw httpError(response);
      }
      const data = object(await readJson(response, this.maxResponseBytes));
      switch (data.status) {
        case 'notStarted':
        case 'running':
          return { status: 'running', retryAfterMs: retryAfter(response) };
        case 'succeeded':
          return { status: 'succeeded', content: sourceContent(data.analyzeResult) };
        case 'failed':
          return { status: 'failed', error: operationError(data.error) };
        default:
          throw new SourceError('fatal', 'Azure returned an unknown document analysis status.');
      }
    });
  }

  private operationUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); } catch { throw new SourceError('fatal', 'Invalid document operation location.'); }
    const prefix = `${MODEL_PATH}/analyzeResults/`;
    const resultId = url.pathname.slice(prefix.length);
    if (url.origin !== this.endpoint.origin || url.username || url.password || url.hash ||
        !url.pathname.startsWith(prefix) ||
        !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(resultId) ||
        url.searchParams.getAll('api-version').length !== 1 || url.searchParams.get('api-version') !== API_VERSION ||
        [...url.searchParams.keys()].some((key) => key !== 'api-version')) {
      throw new SourceError('fatal', 'Untrusted document operation location.');
    }
    return url;
  }

  private async request<T>(url: URL, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SourceError('transient', 'Document Intelligence request timed out.'));
      }, this.timeoutMs);
    });
    const execute = async (): Promise<T> => {
      let accessToken: string | { token: string } | null;
      try {
        accessToken = await this.getToken(TOKEN_SCOPE, { abortSignal: controller.signal });
      } catch {
        throw new SourceError('auth', 'Unable to acquire an Azure Document Intelligence token.');
      }
      if (controller.signal.aborted) throw new SourceError('transient', 'Document Intelligence request timed out.');
      const token = typeof accessToken === 'string' ? accessToken : accessToken?.token;
      if (!token || /[\r\n]/.test(token)) throw new SourceError('auth', 'Azure Document Intelligence token is unavailable.');
      const response = await this.fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        redirect: 'error', signal: controller.signal,
      });
      return consume(response);
    };
    try {
      return await Promise.race([execute(), deadline]);
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError('transient', 'Document Intelligence request failed.');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function boundedOption(value: number | undefined, fallback: number, ceiling: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > ceiling) {
    throw new SourceError('fatal', 'Invalid Document Intelligence resource limit.');
  }
  return resolved;
}

function retryAfter(response: Response): number {
  const value = response.headers.get('retry-after');
  if (!value) return 1_000;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - Date.now();
  return Number.isFinite(seconds) ? Math.min(MAX_RETRY_MS, Math.max(0, Math.ceil(seconds))) : 1_000;
}

function httpError(response: Response): SourceError {
  const status = response.status;
  const kind: SourceErrorKind = status === 401 ? 'auth' : status === 403 ? 'scope' :
    status === 429 ? 'throttled' : status === 404 ? 'not_found' :
    status === 408 || status >= 500 ? 'transient' : 'fatal';
  return new SourceError(kind, `Azure Document Intelligence returned HTTP ${status}.`,
    kind === 'throttled' || kind === 'transient' ? retryAfter(response) : undefined);
}

function operationError(value: unknown): SourceError {
  const error = object(value);
  if (typeof error.code !== 'string' || !error.code) throw malformed();
  const code = error.code.toLowerCase();
  const kind: SourceErrorKind = /unauthorized|authentication/.test(code) ? 'auth' :
    /forbidden|authorization|permission/.test(code) ? 'scope' :
    /throttl|toomanyrequests/.test(code) ? 'throttled' :
    /internalserver|serviceunavailable|timeout/.test(code) ? 'transient' : 'fatal';
  return new SourceError(kind, 'Azure document analysis failed.', kind === 'throttled' ? 1_000 : undefined);
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new SourceError('fatal', 'Document Intelligence response exceeds the byte limit.');
  }
  const reader = response.body?.getReader();
  if (!reader) throw malformed();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const pieces: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new SourceError('fatal', 'Document Intelligence response exceeds the byte limit.');
      }
      pieces.push(decoder.decode(value, { stream: true }));
    }
    pieces.push(decoder.decode());
    return JSON.parse(pieces.join('')) as unknown;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw malformed();
  } finally {
    reader.releaseLock();
  }
}

function malformed(): SourceError {
  return new SourceError('fatal', 'Malformed Azure document analysis response.');
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed();
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw malformed();
  return value;
}

function positiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw malformed();
  return value;
}

function sourceContent(value: unknown): SourceContent {
  const result = object(value);
  if (result.apiVersion !== API_VERSION || result.modelId !== 'prebuilt-layout' ||
      result.stringIndexType !== 'utf16CodeUnit' || typeof result.content !== 'string') throw malformed();
  const text = result.content;
  const anchors: SourceContent['anchors'] = [];
  const addSpans = (value: unknown, locator: string): void => {
    for (const raw of array(value)) {
      const span = object(raw);
      const offset = span.offset;
      const length = span.length;
      if (typeof offset !== 'number' || typeof length !== 'number' || !Number.isSafeInteger(offset) ||
          !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > text.length - length ||
          splitsSurrogate(text, offset) || splitsSurrogate(text, offset + length)) throw malformed();
      if (length > 0) anchors.push({ start: offset, end: offset + length, locator });
      if (anchors.length > 100_000) throw new SourceError('fatal', 'Document contains too many evidence anchors.');
    }
  };
  const pageNumbers = new Set<number>();
  for (const raw of array(result.pages)) {
    const page = object(raw);
    const number = positiveInteger(page.pageNumber);
    if (pageNumbers.has(number)) throw malformed();
    pageNumbers.add(number);
    addSpans(page.spans, `page ${number}`);
    if (page.lines !== undefined) array(page.lines).forEach((rawLine, index) => {
      addSpans(object(rawLine).spans, `page ${number} / line ${index + 1}`);
    });
  }
  if (result.paragraphs !== undefined) array(result.paragraphs).forEach((raw, index) => {
    const paragraph = object(raw);
    const pages = paragraph.boundingRegions === undefined ? [] : [...new Set(array(paragraph.boundingRegions).map((rawRegion) => {
      const number = positiveInteger(object(rawRegion).pageNumber);
      if (!pageNumbers.has(number)) throw malformed();
      return number;
    }))];
    const prefix = pages.length === 0 ? '' : pages.length === 1 ? `page ${pages[0]} / ` : `pages ${pages.join(', ')} / `;
    addSpans(paragraph.spans, `${prefix}paragraph ${index + 1}`);
  });
  return { text, anchors };
}

function splitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
