/**
 * Restricted screenshot retention (T-43). Every computer-use / replay step screenshot goes here, never to a public or
 * shared location. Production: a dedicated Blob container readable only by the app identity, with a lifecycle rule
 * that deletes after `retentionDays`. Local/tests: in-memory store with the same contract.
 */
export interface ScreenshotRecord {
  runId: string;
  step: number;
  key: string;
  bytes: number;
  expiresAt: string;
}

export interface ScreenshotStore {
  put(runId: string, step: number, png: Uint8Array): Promise<ScreenshotRecord>;
  list(runId: string): Promise<ScreenshotRecord[]>;
}

export class InMemoryScreenshotStore implements ScreenshotStore {
  private items: ScreenshotRecord[] = [];
  constructor(private retentionDays = 7, private now = () => new Date()) {}
  async put(runId: string, step: number, png: Uint8Array): Promise<ScreenshotRecord> {
    const r = { runId, step, key: `screenshots/${runId}/${String(step).padStart(3, '0')}.png`, bytes: png.byteLength, expiresAt: new Date(this.now().getTime() + this.retentionDays * 86_400_000).toISOString() };
    this.items.push(r);
    return r;
  }
  async list(runId: string): Promise<ScreenshotRecord[]> {
    return this.items.filter((i) => i.runId === runId);
  }
}

/** Blob implementation (managed identity). Container "screenshots" is private; lifecycle deletion configured in Bicep. */
export async function createBlobScreenshotStore(blobUrl: string, retentionDays = 7): Promise<ScreenshotStore> {
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const container = new BlobServiceClient(blobUrl, new DefaultAzureCredential()).getContainerClient('screenshots');
  return {
    async put(runId, step, png) {
      const key = `${runId}/${String(step).padStart(3, '0')}.png`;
      const expiresAt = new Date(Date.now() + retentionDays * 86_400_000).toISOString();
      await container.getBlockBlobClient(key).uploadData(png, { blobHTTPHeaders: { blobContentType: 'image/png' }, metadata: { expiresAt } });
      return { runId, step, key: `screenshots/${key}`, bytes: png.byteLength, expiresAt };
    },
    async list(runId) {
      const out: ScreenshotRecord[] = [];
      for await (const b of container.listBlobsFlat({ prefix: `${runId}/`, includeMetadata: true })) {
        out.push({ runId, step: Number(b.name.split('/')[1]?.slice(0, 3)), key: `screenshots/${b.name}`, bytes: b.properties.contentLength ?? 0, expiresAt: b.metadata?.expiresAt ?? '' });
      }
      return out;
    },
  };
}
