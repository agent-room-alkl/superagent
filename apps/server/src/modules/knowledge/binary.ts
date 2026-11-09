import { createHash } from 'node:crypto';
import { BlobServiceClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { SourceError, type KnowledgeSourcePlugin, type UserContext } from '@superagent/shared';
import type { DocumentIntelligenceAdapter } from '../../plugins/document-intelligence.js';
import { hydrate, id, invalidateAnalyses, KnowledgeError, snapshot, type ParseJob } from './domain.js';
import type { KnowledgeRepository } from './repository.js';
import { syncConnection } from './sync.js';
export interface BinaryStore { put(ref: string, bytes: Uint8Array, mimeType: string): Promise<void>; get(ref: string): Promise<Uint8Array> }
export interface BinaryDeps { blobs: BinaryStore; parser: Pick<DocumentIntelligenceAdapter, 'start' | 'poll'> }
const TYPES: Record<string, string> = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', tiff: 'image/tiff', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const MAX_BYTES = 20 * 1024 * 1024;
export class AzureBinaryStore implements BinaryStore {
  private container;
  constructor(blobUrl: string) { this.container = new BlobServiceClient(blobUrl, new DefaultAzureCredential()).getContainerClient('knowledge'); }
  async put(ref: string, bytes: Uint8Array, mimeType: string) {
    try { await this.container.getBlockBlobClient(ref).uploadData(bytes, { conditions: { ifNoneMatch: '*' }, blobHTTPHeaders: { blobContentType: mimeType }, abortSignal: AbortSignal.timeout(30_000) }); }
    catch (e) { if ((e as { statusCode?: number }).statusCode !== 409 && (e as { statusCode?: number }).statusCode !== 412) throw e; }
  }
  async get(ref: string) {
    const blob = this.container.getBlockBlobClient(ref), signal = AbortSignal.timeout(30_000);
    const props = await blob.getProperties({ abortSignal: signal });
    if (!props.contentLength || props.contentLength > MAX_BYTES) throw new SourceError('fatal', 'Stored document exceeds the byte limit.');
    return blob.downloadToBuffer(0, props.contentLength, { abortSignal: signal });
  }
}
export async function queueBinaryUpload(repo: KnowledgeRepository, deps: BinaryDeps, ctx: UserContext, input: Record<string, unknown>) {
  const { connectionId, name, base64 } = input;
  if (typeof connectionId !== 'string' || typeof name !== 'string' || !name || name.length > 180 || /[\\/\x00-\x1f]/.test(name) || typeof base64 !== 'string' || base64.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new KnowledgeError('invalid_file', '文件编码、大小或文件名无效。');
  const mimeType = TYPES[name.split('.').pop()!.toLowerCase()]; if (!mimeType) throw new KnowledgeError('unsupported_file', '不支持此文件类型。');
  const bytes = Buffer.from(base64, 'base64'); if (!bytes.length || bytes.length > MAX_BYTES) throw new KnowledgeError('invalid_file', '文件为空或超过 20MB。');
  const version = createHash('sha256').update(bytes).digest('hex');
  const state = await repo.read(ctx), conn = state.source.connections.find(c => c.id === connectionId), meta = state.connectionMeta[connectionId];
  if (!conn || conn.pluginId !== 'local-file' || conn.status !== 'confirmed' || !meta?.audience.includes(ctx.userId) || !meta.projectIds.every(p => ctx.projectScopes.includes(p))) throw new KnowledgeError('source_denied', '先确认当前有权限的本地文件连接。', 403);
  const blobRef = `${encodeURIComponent(ctx.tenantId)}/${connectionId}/${version}`;
  await deps.blobs.put(blobRef, bytes, mimeType);
  return repo.transact(ctx, s => {
    const current = s.source.connections.find(c => c.id === connectionId), currentMeta = s.connectionMeta[connectionId];
    if (current?.status !== 'confirmed' || s.disabledPlugins.includes('local-file') || !currentMeta?.audience.includes(ctx.userId) || !currentMeta.projectIds.every(p => ctx.projectScopes.includes(p))) throw new KnowledgeError('source_denied', '来源连接已变更。', 403);
    const duplicate = s.parseJobs.find(j => j.connectionId === connectionId && j.name === name && j.version === version && !['failed', 'outcome_unknown'].includes(j.status));
    if (duplicate) return { id: duplicate.id, status: duplicate.status };
    // Earlier pending revisions must not overwrite a later upload when Azure completes them out of order.
    for (const old of s.parseJobs.filter(j => j.connectionId === connectionId && j.name === name && ['queued', 'running'].includes(j.status))) { old.status = 'failed'; old.error = 'superseded'; }
    for (const item of s.source.items.filter(i => i.connectionId === connectionId && i.externalId === name)) delete s.confirmations[item.id];
    const job: ParseJob = { id: id(), actor: ctx, connectionId, name, mimeType, blobRef, version, status: 'queued', operationLocation: null, notBefore: Date.now(), leaseToken: null, leaseUntil: 0, attempts: 0, error: null };
    s.parseJobs.push(job); invalidateAnalyses(s); return { id: job.id, status: job.status };
  });
}
/** One leased start or poll per delivery. Pending is scheduled, never a failure or a blocking sleep loop. */
export async function runParseJob(repo: KnowledgeRepository, deps: BinaryDeps, ctx: UserContext, jobId: string) {
  const leaseToken = id();
  const job = await repo.transact(ctx, s => {
    const j = s.parseJobs.find(j => j.id === jobId);
    if (!j || !['queued', 'running'].includes(j.status) || j.notBefore > Date.now() || j.leaseUntil > Date.now()) return null;
    // An abandoned start could have been billed. Never automatically resubmit an unknown POST.
    if (j.status === 'running' && !j.operationLocation && j.attempts > 0) { j.status = 'outcome_unknown'; j.error = 'start_outcome_unknown'; return null; }
    const conn = s.source.connections.find(c => c.id === j.connectionId);
    if (conn?.status !== 'confirmed' || s.disabledPlugins.includes('local-file')) { j.status = 'failed'; j.error = 'source_unavailable'; return null; }
    Object.assign(j, { status: 'running', leaseToken, leaseUntil: Date.now() + 120_000, attempts: j.attempts + 1 }); return j;
  });
  if (!job) return;
  let posting = false;
  try {
    if (!job.operationLocation) {
      const bytes = await deps.blobs.get(job.blobRef);
      if (createHash('sha256').update(bytes).digest('hex') !== job.version) throw new SourceError('fatal', 'Stored document digest mismatch.');
      posting = true; const operation = await deps.parser.start(bytes, job.mimeType);
      await repo.transact(ctx, s => { const j = s.parseJobs.find(j => j.id === jobId)!; if (j.leaseToken !== leaseToken || j.status !== 'running') return; j.operationLocation = operation.operationLocation; j.notBefore = Date.now() + operation.retryAfterMs; j.leaseUntil = 0; });
      return;
    }
    const result = await deps.parser.poll({ operationLocation: job.operationLocation, retryAfterMs: 1000 });
    if (result.status === 'failed') throw result.error;
    await repo.transact(ctx, async s => {
      const j = s.parseJobs.find(j => j.id === jobId)!; if (j.leaseToken !== leaseToken || j.status !== 'running') return;
      if (result.status === 'running') { j.notBefore = Date.now() + result.retryAfterMs; j.leaseUntil = 0; return; }
      const conn = s.source.connections.find(c => c.id === j.connectionId), meta = s.connectionMeta[j.connectionId];
      if (!conn || conn.status !== 'confirmed' || s.disabledPlugins.includes(conn.pluginId) || !meta?.audience.length) throw new SourceError('scope', 'Source authorization changed.');
      const plugin: KnowledgeSourcePlugin = {
        manifest: { id: 'local-file', version: '1', name: '本地文件', permissions: [], capabilities: { incremental: true, attachments: false, liveQuery: false, acl: true } },
        testConnection: async () => ({ ok: true }), listItems: async () => ({ items: [{ externalId: j.name, version: j.version, title: j.name, locator: `upload://${j.name}`, change: 'upsert' }] }),
        getAcl: async () => ({ status: 'known', entries: meta.audience.map(principal => ({ principal, access: 'read' })) }), readItem: async () => result.content,
      };
      const store = hydrate(s.source), sync = await syncConnection(store, plugin, j.connectionId);
      if (sync.error) throw new SourceError('fatal', 'Parsed source rejected.');
      s.source = snapshot(store); j.status = 'completed'; j.leaseUntil = 0; invalidateAnalyses(s);
    });
  } catch (error) {
    await repo.transact(ctx, s => {
      const j = s.parseJobs.find(j => j.id === jobId)!; if (j.leaseToken !== leaseToken || j.status !== 'running') return;
      const kind = error instanceof SourceError ? error.kind : 'transient';
      if (kind === 'auth' || kind === 'scope') {
        const conn = s.source.connections.find(c => c.id === j.connectionId); if (conn) conn.status = 'needs_reauth'; invalidateAnalyses(s);
      }
      if (posting && kind === 'transient') { j.status = 'outcome_unknown'; j.error = 'start_outcome_unknown'; }
      else if (['throttled', 'transient'].includes(kind) && j.attempts < 8) { j.status = 'queued'; j.notBefore = Date.now() + (error instanceof SourceError ? error.retryAfterMs ?? 5000 : 5000); }
      else { j.status = 'failed'; j.error = kind; }
      j.leaseUntil = 0;
    });
  }
}
