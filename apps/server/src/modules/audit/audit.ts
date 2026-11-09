/**
 * Append-only audit (PRD §3.9). The application database role has INSERT/SELECT only on audit_log
 * (see apps/server/migrations/0001_roles.sql). Details are redacted before storage.
 */
import { redact } from '../setup/secrets.js';

export interface AuditEntry {
  tenantId: string;
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
  versionRef?: string | null;
  result: 'ok' | 'denied' | 'failed' | 'unknown';
  detail?: Record<string, unknown>;
}

export interface AuditSink {
  append(e: AuditEntry): Promise<void>;
}

const SENSITIVE_KEYS = /^(api_?key|apikey|password|secret|token|authorization|connection_?string)$/i;

export function sanitize(detail: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SENSITIVE_KEYS.test(k)) out[k] = '[redacted]';
    else if (typeof v === 'string') out[k] = redact(v);
    else if (v && typeof v === 'object' && !Array.isArray(v)) out[k] = sanitize(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

export async function audit(sink: AuditSink, e: AuditEntry): Promise<void> {
  await sink.append({ ...e, detail: sanitize(e.detail) });
}

export class InMemoryAuditSink implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async append(e: AuditEntry) {
    this.entries.push(Object.freeze({ ...e }));
  }
}
