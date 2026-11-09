/**
 * DocParser backed by the Document Intelligence adapter (src/plugins/document-intelligence.ts, PR #8):
 * operation URLs pinned to the configured endpoint and analyzeResults/<uuid> path, no redirects, bounded responses,
 * HTTP 401/403/429/5xx mapped onto SourceError so the sync engine applies the §3.2 semantics.
 * This bridge drives start → poll in-process for the synchronous sync path; durable parse jobs (T-40) call the
 * adapter's start/poll one step per job instead.
 */
import { SourceError, type SourceContent } from '@superagent/shared';
import type { DocumentIntelligenceAdapter } from '../../plugins/document-intelligence.js';
import type { DocParser } from './parser.js';

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  heif: 'image/heif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
  htm: 'text/html',
};

export const mimeFor = (fileName: string): string | null => MIME[fileName.split('.').pop()?.toLowerCase() ?? ''] ?? null;

export interface DocIntelParserOptions {
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class DocIntelParser implements DocParser {
  constructor(
    private adapter: Pick<DocumentIntelligenceAdapter, 'start' | 'poll'>,
    private opts: DocIntelParserOptions = {},
  ) {}

  async parse(bytes: Uint8Array, fileName: string): Promise<SourceContent> {
    const mime = mimeFor(fileName);
    if (!mime) throw new SourceError('fatal', `${fileName}: unsupported file type for Document Intelligence`);
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
    let ref = await this.adapter.start(bytes, mime);
    for (let i = 0; i < (this.opts.maxPolls ?? 120); i++) {
      await sleep(ref.retryAfterMs);
      const r = await this.adapter.poll(ref);
      if (r.status === 'running') {
        ref = { ...ref, retryAfterMs: r.retryAfterMs };
        continue;
      }
      if (r.status === 'failed') throw r.error;
      return { text: r.content.text, anchors: r.content.anchors.map((a) => ({ ...a, locator: `${fileName} ${a.locator}` })) };
    }
    throw new SourceError('transient', `${fileName}: analysis still running; retried on the next sync`);
  }
}
