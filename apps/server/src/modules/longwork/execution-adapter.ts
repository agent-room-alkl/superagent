import type pg from 'pg';
import { runClaimedInstance } from '../execution/index.js';
import { loadRunByInstance } from '../execution/pg-runs.js';
import { loadVersionById } from '../sop/pg-sop.js';
import { sopEventKey } from '../sop/sop.js';
import { mailSopEvent } from './sop-starts.js';
import type { MailSopConsumer } from './sop-execution.js';

/** The worker binds the execution/gateway stores before invoking this adapter. No connector is installed here. */
export function pgMailSopConsumer(pool: pg.Pool): MailSopConsumer {
  const db = { query: async <T>(sql: string, params: readonly unknown[]) => ({ rows: (await pool.query(sql, params as unknown[])).rows as T[] }) };
  return {
    inspect: (tenant, instance) => loadRunByInstance(db, tenant, instance),
    eligible: async input => {
      const version = await loadVersionById(db, input.versionId);
      if (!version || version.status !== 'published' || !version.report?.ok || version.validatedRevision !== version.revision || version.definition.employeeStatus !== 'active') return false;
      const context = input.data.longItem as { sourceId?: string } | undefined;
      if (!context?.sourceId) return false;
      const event = mailSopEvent(context.sourceId, input.eventId);
      const row = (await pool.query<{ sop_id: string; sop_version_id: string; status: string; event_key: string }>(
        'SELECT sop_id,sop_version_id,status,event_key FROM sop_instances WHERE tenant_id=$1 AND id=$2', [input.tenantId, input.instanceId])).rows[0];
      return !!row && row.status === 'running' && row.sop_version_id === input.versionId && row.sop_id === version.sopId &&
        row.event_key === sopEventKey(input.tenantId, event.source, event.eventId, version.sopId);
    },
    start: runClaimedInstance,
  };
}
