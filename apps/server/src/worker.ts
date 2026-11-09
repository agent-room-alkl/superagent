/**
 * Worker entry (APP_ROLE=worker). Must run with minReplicas >= 1 (PRD §5.1).
 * The Postgres queue (SKIP LOCKED, leases, heartbeat, dead-letter) is implemented by T-41 in modules/runtime.
 */
export async function runWorker(signal?: AbortSignal): Promise<void> {
  const heartbeatMs = Number(process.env.WORKER_HEARTBEAT_MS ?? 15000);
  console.log(JSON.stringify({ msg: 'worker started', heartbeatMs }));
  while (!signal?.aborted) {
    await new Promise((r) => setTimeout(r, heartbeatMs));
    console.log(JSON.stringify({ msg: 'worker heartbeat', at: new Date().toISOString() }));
  }
}
