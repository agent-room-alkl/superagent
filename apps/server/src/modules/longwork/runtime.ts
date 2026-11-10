import type { Runtime } from '../../bootstrap.js';
import { LongWork, validateSource } from './service.js';
import { MemoryLongWorkStore, PgLongWorkStore } from './store.js';
import { MailTrigger, type GraphSource } from './graph.js';
import type { LongWorkDeps } from './http.js';
import { prepareMailSopStarts } from './sop-starts.js';
import { MailSopBridge, type MailSopConsumer } from './sop-execution.js';

export function sourceConfig(raw: string | undefined, tenant: string): GraphSource[] {
  if (!raw) return [];
  let sources: GraphSource[];
  try { sources = JSON.parse(raw); } catch { throw Error('invalid_MAIL_TRIGGERS_JSON'); }
  if (!Array.isArray(sources) || sources.length > 50) throw Error('invalid_MAIL_TRIGGERS_JSON');
  for (const s of sources) {
    validateSource(s);
    if (s.tenant !== tenant || !s.clientStateRef?.name || !s.clientStateRef?.version || !Number.isFinite(Date.parse(s.startAt))) throw Error('invalid_MAIL_TRIGGERS_JSON');
    const allowed = ['id', 'tenant', 'mailbox', 'folder', 'sopId', 'projectId', 'objectId', 'assignee', 'reviewer', 'reminderMs', 'dueRule', 'fields', 'clientStateRef', 'startAt'];
    if (Object.keys(s).some(k => !allowed.includes(k))) throw Error('invalid_MAIL_TRIGGERS_JSON');
  }
  if (new Set(sources.map(s => s.id)).size !== sources.length) throw Error('duplicate_mail_source');
  return sources;
}

export function createLongWorkDeps(runtime: Runtime, env = process.env, consumer?: MailSopConsumer): LongWorkDeps {
  const sources = sourceConfig(env.MAIL_TRIGGERS_JSON, runtime.config.platformTenantId);
  const store = runtime.pool ? new PgLongWorkStore(runtime.pool, prepareMailSopStarts(sources)) : new MemoryLongWorkStore();
  const work = new LongWork(store);
  const bridge = new MailSopBridge(store, sources, consumer);
  let mail: MailTrigger | undefined;
  if (sources.length) {
    if (!env.MAIL_NOTIFICATION_URL) throw Error('MAIL_NOTIFICATION_URL is required');
    let credential: import('@azure/identity').DefaultAzureCredential | undefined;
    mail = new MailTrigger(work, sources, env.MAIL_NOTIFICATION_URL, {
      secret: ref => runtime.app.setupDeps.secrets.get(ref),
      token: async () => {
        credential ??= new (await import('@azure/identity')).DefaultAzureCredential();
        const t = await credential.getToken('https://graph.microsoft.com/.default');
        if (!t) throw Error('mail_graph_identity_unavailable'); return t.token;
      },
    });
  }
  return {
    work, ...(mail ? { mail } : {}),
    ready: async () => {
      if (!runtime.pool) return true;
      const row = (await runtime.pool.query("SELECT to_regclass('longwork_state') AS name, to_regclass('longwork_sop_starts') AS starts, to_regclass('sop_versions') AS versions, to_regclass('sop_instances') AS instances, to_regclass('sop_events') AS events, to_regclass('execution_run') AS runs, to_regclass('work_item') AS items")).rows[0];
      return !!row?.name && !!row.starts && !!row.versions && !!row.instances && !!row.events && (!consumer || (!!row.runs && !!row.items));
    },
    tick: async () => {
      await work.tick(runtime.config.platformTenantId);
      await bridge.tick(runtime.config.platformTenantId);
      // A bad mailbox must not prevent other approved sources being scanned. Emit no source bodies or secrets.
      const results = await Promise.allSettled(sources.map(s => mail!.tick(s)));
      if (results.some(r => r.status === 'rejected')) throw Error('mail_scan_failed; periodic scan will retry');
    },
  };
}
