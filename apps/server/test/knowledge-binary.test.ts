import { describe, it, expect } from 'vitest';
import type { UserContext } from '@superagent/shared';
import { SourceError } from '@superagent/shared';
import { MemoryKnowledgeRepository } from '../src/modules/knowledge/repository.js';
import { KnowledgeService } from '../src/modules/knowledge/service.js';
import { queueBinaryUpload, runParseJob, type BinaryDeps } from '../src/modules/knowledge/binary.js';
const ctx: UserContext = { tenantId: 'parse-test', userId: 'alice', roles: ['owner'], projectScopes: [] };
async function fixture() {
  const repo = new MemoryKnowledgeRepository(), service = new KnowledgeService({ repo });
  const conn = await service.createConnection(ctx, { name: '扫描件', pluginId: 'local-file' }); await service.confirmConnection(ctx, conn.id);
  const blobs = new Map<string, Uint8Array>(); let starts = 0, polls = 0;
  const deps: BinaryDeps = { blobs: { put: async (ref, bytes) => { blobs.set(ref, bytes); }, get: async ref => blobs.get(ref)! }, parser: {
    start: async () => { starts++; return { operationLocation: 'operation-1', retryAfterMs: 0 }; },
    poll: async () => { polls++; return { status: 'succeeded', content: { text: '扫描规则', anchors: [{ start: 0, end: 4, locator: 'p.2 L1' }] } }; },
  } };
  const upload = (name = 'scan.pdf', bytes = 'synthetic pdf') => queueBinaryUpload(repo, deps, ctx, { connectionId: conn.id, name, base64: Buffer.from(bytes).toString('base64') });
  return { repo, service, conn, deps, blobs, upload, counts: () => ({ starts, polls }) };
}
describe('durable document parsing', () => {
  it('persists operation reference, polls once per delivery, and requires confirmation after parsing', async () => {
    const f = await fixture(), job = await f.upload();
    await runParseJob(f.repo, f.deps, ctx, job.id); expect(f.counts()).toEqual({ starts: 1, polls: 0 });
    expect((await f.repo.read(ctx)).parseJobs[0]).toMatchObject({ operationLocation: 'operation-1', status: 'running', leaseUntil: 0 });
    await runParseJob(f.repo, f.deps, ctx, job.id); expect(f.counts()).toEqual({ starts: 1, polls: 1 });
    expect((await f.service.search(ctx, '扫描')).answer).toBe('无依据');
    const item = (await f.repo.read(ctx)).source.items[0]!; await f.service.confirm(ctx, item.id, item.version);
    expect((await f.service.search(ctx, '扫描')).hits[0]).toMatchObject({ locator: 'scan.pdf p.2 L1', quote: '扫描规则' });
    await runParseJob(f.repo, f.deps, ctx, job.id); expect(f.counts()).toEqual({ starts: 1, polls: 1 });
  });
  it('running RetryAfter persists without failing, sleeping, or consuming duplicate starts', async () => {
    const f = await fixture(), job = await f.upload(); await runParseJob(f.repo, f.deps, ctx, job.id);
    f.deps.parser.poll = async () => ({ status: 'running', retryAfterMs: 30_000 });
    await runParseJob(f.repo, f.deps, ctx, job.id); const state = await f.repo.read(ctx); expect(state.parseJobs[0]!.notBefore).toBeGreaterThan(Date.now());
    await runParseJob(f.repo, f.deps, ctx, job.id); expect(f.counts().starts).toBe(1); expect(state.parseJobs[0]!.status).toBe('running');
  });
  it('unknown POST outcome freezes and never automatically resubmits', async () => {
    const f = await fixture(), job = await f.upload(); let calls = 0;
    f.deps.parser.start = async () => { calls++; throw new SourceError('transient', 'network timeout'); };
    await runParseJob(f.repo, f.deps, ctx, job.id); await runParseJob(f.repo, f.deps, ctx, job.id);
    expect(calls).toBe(1); expect((await f.repo.read(ctx)).parseJobs[0]!.status).toBe('outcome_unknown');
  });
  it('a worker crash after claiming a POST is uncertain, not an automatic second billable request', async () => {
    const f = await fixture(), job = await f.upload(); await f.repo.transact(ctx, s => { Object.assign(s.parseJobs[0]!, { status: 'running', attempts: 1, leaseUntil: Date.now() - 1 }); });
    await runParseJob(f.repo, f.deps, ctx, job.id); expect(f.counts().starts).toBe(0); expect((await f.repo.read(ctx)).parseJobs[0]!.status).toBe('outcome_unknown');
  });
  it('digest mismatch never calls Azure; same binary upload de-duplicates jobs', async () => {
    const f = await fixture(), job = await f.upload(); expect((await f.upload()).id).toBe(job.id);
    for (const key of f.blobs.keys()) f.blobs.set(key, Buffer.from('tampered'));
    await runParseJob(f.repo, f.deps, ctx, job.id); expect(f.counts().starts).toBe(0); expect((await f.repo.read(ctx)).parseJobs[0]).toMatchObject({ status: 'failed', error: 'fatal' });
  });
  it('authorization failure suspends the connection and revokes retrieval', async () => {
    const f = await fixture(), job = await f.upload(); f.deps.parser.start = async () => { throw new SourceError('auth', '401'); };
    await runParseJob(f.repo, f.deps, ctx, job.id); expect((await f.repo.read(ctx)).source.connections[0]!.status).toBe('needs_reauth');
  });
  it('superseded in-flight uploads cannot overwrite later revisions', async () => {
    const f = await fixture(), job = await f.upload(); await runParseJob(f.repo, f.deps, ctx, job.id);
    await f.upload('scan.pdf', 'later revision'); await runParseJob(f.repo, f.deps, ctx, job.id);
    expect((await f.repo.read(ctx)).source.items).toEqual([]); expect((await f.repo.read(ctx)).parseJobs[0]!.error).toBe('superseded');
  });
  it('rejects malformed base64, unsupported files and missing Azure dependencies', async () => {
    const f = await fixture(); await expect(queueBinaryUpload(f.repo, f.deps, ctx, { connectionId: f.conn.id, name: 'scan.pdf', base64: 'not base64' })).rejects.toMatchObject({ code: 'invalid_file' });
    await expect(f.service.uploadBinary(ctx, {})).rejects.toMatchObject({ code: 'parser_unavailable', statusCode: 503 });
    await expect(f.upload('file.exe')).rejects.toMatchObject({ code: 'unsupported_file' });
  });
});
