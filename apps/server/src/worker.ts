/**
 * Worker entry (APP_ROLE=worker). Must run with minReplicas >= 1 (PRD §5.1).
 * Starts through the same fail-closed bootstrap as the web role: with Entra every production dependency must be
 * configured, and PostgreSQL must answer before the loop starts. Job handlers (T-40 parse/analysis, T-41 queue)
 * register on the loop and receive the runtime (pool, llm, config); none run against in-memory stores in production.
 */
import type { Runtime } from './bootstrap.js';

export type WorkerTick = (runtime: Runtime, signal: AbortSignal) => Promise<void>;

export interface WorkerOptions {
  signal?: AbortSignal;
  runtime?: Runtime; // injected in tests; otherwise createRuntime(process.env)
  ticks?: WorkerTick[];
  heartbeatMs?: number;
  log?: (o: Record<string, unknown>) => void;
}

export async function runWorker(opts: WorkerOptions = {}): Promise<void> {
  const log = opts.log ?? ((o) => console.log(JSON.stringify(o)));
  const signal = opts.signal ?? new AbortController().signal;
  const runtime = opts.runtime ?? (await (await import('./bootstrap.js')).createRuntime(process.env));
  try {
    if (runtime.pool) await runtime.pool.query('SELECT 1'); // fail fast when the database is unreachable
    const heartbeatMs = opts.heartbeatMs ?? Number(process.env.WORKER_HEARTBEAT_MS ?? 15000);
    log({ msg: 'worker started', mode: runtime.config.mode, heartbeatMs, ticks: opts.ticks?.length ?? 0 });
    while (!signal.aborted) {
      for (const tick of opts.ticks ?? []) {
        try {
          await tick(runtime, signal);
        } catch (e) {
          log({ msg: 'worker tick failed', error: e instanceof Error ? e.message : String(e) });
        }
      }
      await new Promise((r) => setTimeout(r, heartbeatMs));
      log({ msg: 'worker heartbeat', at: new Date().toISOString() });
    }
  } finally {
    await runtime.close();
  }
}
