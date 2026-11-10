/**
 * Result boundaries for a command-room task (prototype qa-outcomes / qa-human-work).
 * A draft is not a sent message, a result is not raw tool JSON, and a failed check cannot be accepted.
 * Supplements and permission releases keep the same task. An async report never receives the SOP draft.
 */

export interface ResultEvidence {
  fields: { subject: string | null; body: string | null };
  /** A room report never sends the draft. Only an explicit outward action may set this. */
  sent: boolean;
}

export type ResultVerification = 'none' | 'verified' | 'failed';

export interface ResultHold {
  reason: string;
  responsible: string;
}

export const PERMISSION_HOLD: ResultHold = { reason: '未授权的工具', responsible: '企业负责人' };

export function evidenceFromReport(body: string): ResultEvidence {
  return { fields: { subject: null, body }, sent: false };
}

export function verificationOf(evidence: ResultEvidence | null): ResultVerification {
  if (!evidence) return 'none';
  const body = evidence.fields.body;
  return typeof body === 'string' && body.trim() !== '' ? 'verified' : 'failed';
}

/** Unsent drafts say so. Anything else, including a sent result, has no draft boundary. */
export function unsentDraftBoundary(title: string, evidence: ResultEvidence | null): '尚未发送' | null {
  if (!evidence || evidence.sent) return null;
  if (!title.includes('草稿')) return null;
  return '尚未发送';
}

/**
 * What a person reads. The evidence fields stay structured and are never printed as implementation JSON,
 * so a key such as "subject" cannot leak into the overview.
 */
export function resultOverview(title: string, evidence: ResultEvidence | null): string {
  const boundary = unsentDraftBoundary(title, evidence);
  return boundary ? `${title}。${boundary}` : title;
}

/** A blank supplement is refused. The caller writes the returned text onto the same task. */
export function acceptSupplement(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('empty_supplement');
  return trimmed;
}

export function summaryLabel(count: number): '暂无事项' | null {
  return count === 0 ? '暂无事项' : null;
}

/** Room events do not take the workflow draft, so a report cannot erase or replace what the person is editing. */
export function applyAsyncReport<T>(draft: T): T {
  return draft;
}
