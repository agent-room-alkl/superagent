/**
 * Azure AI Document Intelligence (prebuilt-layout) for PDF / scanned / Office files. Returns text with page+line anchors
 * so answers can cite "file p.N". Auth via managed identity (local auth is disabled in Bicep).
 */
import type { SourceContent } from '@superagent/shared';

export interface DocParser {
  parse(bytes: Uint8Array, fileName: string): Promise<SourceContent>;
}

export interface DocIntelConfig {
  endpoint: string; // https://<name>.cognitiveservices.azure.com
  apiVersion?: string;
  getToken?: () => Promise<string>;
  fetchFn?: typeof fetch;
  pollMs?: number;
  maxPolls?: number;
}

interface Layout {
  pages?: { pageNumber: number; lines?: { content: string }[] }[];
}

export class DocIntelParser implements DocParser {
  constructor(private cfg: DocIntelConfig) {}

  async parse(bytes: Uint8Array, fileName: string): Promise<SourceContent> {
    const f = this.cfg.fetchFn ?? fetch;
    const token = await (this.cfg.getToken ?? defaultToken)();
    const v = this.cfg.apiVersion ?? '2024-11-30';
    const base = this.cfg.endpoint.replace(/\/$/, '');
    const start = await f(`${base}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=${v}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ base64Source: Buffer.from(bytes).toString('base64') }),
    });
    if (start.status !== 202) throw new Error(`analyze failed for ${fileName}: ${start.status}`);
    const op = start.headers.get('operation-location');
    if (!op) throw new Error('missing operation-location');
    for (let i = 0; i < (this.cfg.maxPolls ?? 60); i++) {
      const r = await f(op, { headers: { authorization: `Bearer ${token}` } });
      const j = (await r.json()) as { status: string; analyzeResult?: Layout; error?: { message?: string } };
      if (j.status === 'succeeded') return toContent(j.analyzeResult ?? {}, fileName);
      if (j.status === 'failed') throw new Error(`analyze failed: ${j.error?.message ?? 'unknown'}`);
      await new Promise((ok) => setTimeout(ok, this.cfg.pollMs ?? 1000));
    }
    throw new Error('analyze timed out');
  }
}

export function toContent(layout: Layout, fileName: string): SourceContent {
  let text = '';
  const anchors: SourceContent['anchors'] = [];
  for (const p of layout.pages ?? []) {
    (p.lines ?? []).forEach((l, i) => {
      const start = text.length;
      text += l.content + '\n';
      anchors.push({ start, end: start + l.content.length, locator: `${fileName} p.${p.pageNumber} L${i + 1}` });
    });
  }
  return { text, anchors };
}

async function defaultToken(): Promise<string> {
  const { DefaultAzureCredential } = await import('@azure/identity');
  const t = await new DefaultAzureCredential().getToken('https://cognitiveservices.azure.com/.default');
  if (!t) throw new Error('no Cognitive Services token');
  return t.token;
}
