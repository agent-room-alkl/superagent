import type { UserContext } from '@superagent/shared';
import { setTimeout as delay } from 'node:timers/promises';
import type { KnowledgeDeps } from './service.js';
import { runParseJob } from './binary.js';
import { runAnalysis } from '../analysis/service.js';
import { sourceScope } from './sources.js';
import { mayRead } from './domain.js';
/** The persisted parseJobs/analyses ledger is the authoritative queue; no process-local launch is required. */
export async function tickKnowledge(deps: KnowledgeDeps, tenantId: string): Promise<boolean> {
  const internal: UserContext = { tenantId, userId: 'knowledge-worker', roles: [], projectScopes: [] };
  const state = await deps.repo.read(internal);
  const job = state.parseJobs.find(j => j.actor.tenantId === tenantId && ['queued', 'running'].includes(j.status) && j.notBefore <= Date.now() && j.leaseUntil <= Date.now());
  if (job && deps.binary) { await runParseJob(deps.repo, deps.binary, job.actor, job.id); return true; }
  const run = state.analyses.find(r => r.actor.tenantId === tenantId && ['queued', 'running'].includes(r.status) && ((r as typeof r & { leaseUntil?: number }).leaseUntil ?? 0) <= Date.now());
  if (run && deps.model) {
    const denied = state.source.items.some(item => {
      if (!mayRead(state, run.actor, item)) return false;
      const conn = state.source.connections.find(c => c.id === item.connectionId)!;
      if (conn.pluginId === 'email' || conn.pluginId === 'sharepoint') { try { sourceScope(deps.sourceResources ?? [], run.actor, conn.pluginId, conn.scope, state.connectionMeta[conn.id]!.audience); return false; } catch { return true; } }
      if (conn.pluginId !== 'database') return false;
      try { return !deps.database?.scope(run.actor, conn.scope); } catch { return true; }
    });
    if (denied) { await deps.repo.transact(run.actor, s => { const r = s.analyses.find(r => r.id === run.id)!; r.status = 'stale'; r.error = 'source_scope_changed'; }); return true; }
    await runAnalysis(deps.repo, deps.model, run.actor, run.id); return true;
  }
  return false;
}
export async function runKnowledgeWorker(deps: KnowledgeDeps, tenantId: string, signal: AbortSignal) {
  while (!signal.aborted) {
    try { const worked = await tickKnowledge(deps, tenantId); if (worked) continue; }
    catch { console.error(JSON.stringify({ msg: 'knowledge_worker_tick_failed' })); }
    try { await delay(1000, undefined, { signal }); } catch { if (!signal.aborted) throw Error('Worker timer failed'); }
  }
}
