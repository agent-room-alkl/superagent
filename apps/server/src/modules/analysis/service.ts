import type { UserContext } from '@superagent/shared';
import { evidenceValid, id, KnowledgeError, mayRead, mergeRecommendations, positionedChunks, signature, type Evidence, type Recommendation } from '../knowledge/domain.js';
import type { KnowledgeRepository } from '../knowledge/repository.js';
export interface AnalysisModel {
  check?(tenantId: string): Promise<void>;
  /** Implementation MUST reserve budget before the call and freeze uncertain outcomes. No direct-provider fallback. */
  recommend(input: { tenantId: string; runId: string; evidence: Evidence[]; maxOutputTokens: number }): Promise<unknown>;
}
export function validateProposals(value: unknown): Omit<Recommendation, 'id' | 'humanLocked' | 'deleted'>[] {
  if (!Array.isArray(value) || value.length > 30) throw new KnowledgeError('invalid_model_output', '分析返回的草案结构无效。', 422);
  return value.map(v => {
    if (!v || typeof v !== 'object') throw new KnowledgeError('invalid_model_output', '分析草案无效。', 422);
    const p = v as Record<string, unknown>;
    for (const [key, max] of [['key', 120], ['name', 160], ['description', 4000]] as const) if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > max) throw new KnowledgeError('invalid_model_output', '分析草案字段无效。', 422);
    if (!['employee', 'tool', 'sop', 'object'].includes(String(p.kind)) || !Array.isArray(p.evidence) || !p.evidence.length || p.evidence.length > 12) throw new KnowledgeError('invalid_model_output', '草案类型或依据无效。', 422);
    for (const e of p.evidence) if (!e || typeof e !== 'object' || typeof e.sourceId !== 'string' || typeof e.version !== 'string' || typeof e.locator !== 'string' || typeof e.quote !== 'string' || e.quote.length > 1200 || !Number.isSafeInteger(e.start) || !Number.isSafeInteger(e.end)) throw new KnowledgeError('invalid_model_output', '草案引用无效。', 422);
    return { key: p.key as string, name: p.name as string, description: p.description as string, kind: p.kind as Recommendation['kind'], evidence: p.evidence as Evidence[] };
  });
}
/** Reference-only durable queue handler. Worker retries are safe; source changes during model calls discard results. */
export async function runAnalysis(repo: KnowledgeRepository, model: AnalysisModel, ctx: UserContext, runId: string): Promise<void> {
  const leaseToken = id();
  const input = await repo.transact(ctx, s => {
    const run = s.analyses.find(r => r.id === runId && r.actor.userId === ctx.userId);
    if (!run || !['queued', 'running'].includes(run.status)) return null;
    const leased = run as typeof run & { leaseUntil?: number; leaseToken?: string };
    if (run.status === 'running' && (leased.leaseUntil ?? 0) > Date.now()) return null;
    if (run.status === 'running' && run.stage === 'recommend') { run.status = 'outcome_unknown'; run.error = 'model_outcome_unknown'; return null; }
    if (run.signature !== signature(s, ctx)) { run.status = 'stale'; return null; }
    Object.assign(run, { status: 'running', stage: 'extract', leaseToken, leaseUntil: Date.now() + 300_000 });
    const evidence: Evidence[] = [];
    for (const i of s.source.items.filter(i => mayRead(s, ctx, i))) for (const c of positionedChunks(s, i)) {
      if (evidence.length >= 40) break;
      if (c.text.length) evidence.push({ sourceId: i.id, version: i.version, start: c.start, end: Math.min(c.end, c.start + 1200), locator: c.locator, quote: c.text.slice(0, 1200) });
    }
    return evidence;
  });
  if (!input) return;
  try {
    const active = await repo.transact(ctx, s => {
      const run = s.analyses.find(r => r.id === runId)!;
      if (run.status !== 'running' || run.signature !== signature(s, ctx)) { run.status = 'stale'; return false; }
      run.stage = 'recommend'; return true;
    });
    if (!active) return;
    const result = validateProposals(await model.recommend({ tenantId: ctx.tenantId, runId, evidence: input, maxOutputTokens: 4096 }));
    await repo.transact(ctx, s => {
      const run = s.analyses.find(r => r.id === runId)!;
      if (run.status !== 'running' || (run as typeof run & { leaseToken?: string }).leaseToken !== leaseToken || run.signature !== signature(s, ctx)) { if (run.status === 'running') run.status = 'stale'; return; }
      // Model may quote only the supplied bounded evidence, never hidden corpus or invented offsets.
      if (!result.every(p => p.evidence.every(e => evidenceValid(s, ctx, e) && input.some(i => i.sourceId === e.sourceId && i.version === e.version && i.locator === e.locator && e.start >= i.start && e.end <= i.end && i.quote.slice(e.start - i.start, e.end - i.start) === e.quote)))) throw new KnowledgeError('unsupported_recommendation', '建议缺少当前分析的有效依据。', 422);
      mergeRecommendations(s, ctx, result);
      const store = s.source;
      for (const proposal of result) for (const e of proposal.evidence) {
        const citer = s.recommendations.find(r => r.key === proposal.key && r.kind === proposal.kind)?.id;
        if (!citer) continue;
        const entry = store.citations.find(([key]) => key === e.sourceId);
        if (entry) { if (!entry[1].includes(citer)) entry[1].push(citer); } else store.citations.push([e.sourceId, [citer]]);
      }
      run.status = 'completed'; run.stage = 'complete'; run.error = null;
    });
  } catch (error) {
    await repo.transact(ctx, s => { const run = s.analyses.find(r => r.id === runId); if (run?.status === 'running' && (run as typeof run & { leaseToken?: string }).leaseToken === leaseToken) { run.status = 'failed'; run.error = error instanceof KnowledgeError ? error.code : 'analysis_failed'; } });
  }
}
