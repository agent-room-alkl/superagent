/**
 * Pure rules behind the SOP workspace (T-48): validation freshness, regression-case completeness, SOP packs from
 * the knowledge analysis, and the impact of knowledge changes on a draft. Kept free of React so they are unit-tested.
 */
import type { SopGraph } from '@superagent/shared';

/** The ten runtime gates run as regression cases on every validation (T-41 runtime). */
export const REGRESSION_CASES = [
  'read_ok',
  'missing_field',
  'over_threshold',
  'approval_denied',
  'duplicate_event',
  'employee_offline',
  'paused',
  'outcome_unknown',
  'permission_revoked',
  'write_approval',
] as const;

export interface KnowledgeEvidence {
  sourceId: string;
  version: string;
  locator: string;
  quote: string;
}

export interface PackItem {
  id: string;
  kind: 'trigger' | 'rule';
  text: string;
  confirmed: boolean;
  evidence: KnowledgeEvidence[];
}

export interface SopPack {
  key: string;
  name: string;
  items: PackItem[];
}

export interface GateReport {
  ok: boolean;
  gates: Record<string, { ok: boolean; detail: string }>;
}

export interface DraftState {
  status: 'draft' | 'passed' | 'failed' | 'published';
  revision?: number;
  validatedRevision?: number | null;
  report: GateReport | null;
}

/** Regression cases a validation report must contain; any missing one blocks publishing. */
export function missingRegressionCases(report: GateReport | null): string[] {
  if (!report) return [...REGRESSION_CASES];
  return REGRESSION_CASES.filter((c) => !(c in report.gates));
}

export type ValidationState =
  | { kind: 'none' }
  | { kind: 'dirty' }
  | { kind: 'stale'; validatedRevision: number; revision: number }
  | { kind: 'failed' }
  | { kind: 'incomplete'; missing: string[] }
  | { kind: 'valid' };

/** Whether the current draft may be published, and if not, why (shown to the user, never silent). */
export function validationState(v: DraftState | undefined, dirty: boolean): ValidationState {
  if (!v || v.status === 'published') return { kind: 'none' };
  if (dirty) return { kind: 'dirty' };
  const rev = v.revision ?? 1;
  if (v.validatedRevision != null && v.validatedRevision !== rev) return { kind: 'stale', validatedRevision: v.validatedRevision, revision: rev };
  if (v.status === 'failed') return { kind: 'failed' };
  if (v.status !== 'passed') return { kind: 'none' };
  const missing = missingRegressionCases(v.report);
  if (missing.length) return { kind: 'incomplete', missing };
  return { kind: 'valid' };
}

interface SopRecommendation {
  key: string;
  kind: string;
  name: string;
  description: string;
  evidence: KnowledgeEvidence[];
}

/**
 * An SOP recommendation from the knowledge analysis becomes a pack: one trigger and one rule per cited passage,
 * each carrying its evidence and starting UNCONFIRMED. Nothing is invented beyond the cited text.
 */
export function packFromRecommendation(r: SopRecommendation): SopPack {
  return {
    key: r.key,
    name: r.name,
    items: [
      { id: `${r.key}:trigger`, kind: 'trigger', text: `触发：${r.name}`, confirmed: false, evidence: r.evidence.slice(0, 1) },
      ...r.evidence.map((e, i) => ({ id: `${r.key}:rule:${i + 1}`, kind: 'rule' as const, text: e.quote, confirmed: false, evidence: [e] })),
    ],
  };
}

/** Skeleton graph for a pack: trigger → super agent → human review (owner adds employees and tools). */
export function graphFromPack(p: SopPack): SopGraph {
  return {
    nodes: [
      { id: 't', kind: 'trigger', label: p.name, ref: `pack:${p.key}` },
      { id: 'a', kind: 'agent', label: '超级智能体分派' },
      { id: 'h', kind: 'human_review', label: '人工确认' },
    ],
    edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'h' }],
  };
}

export const unconfirmedItems = (p: SopPack | undefined) => (p ? p.items.filter((i) => !i.confirmed) : []);

export interface KnowledgeImpact {
  itemId: string;
  text: string;
  locator: string;
  from: string;
  to: string | null; // null = source no longer available to this user
}

/** Compare the evidence a draft was built on with the current knowledge: changed or withdrawn sources. */
export function knowledgeImpact(pack: SopPack | undefined, current: { evidence: KnowledgeEvidence[] }[]): KnowledgeImpact[] {
  if (!pack) return [];
  const now = new Map<string, string>();
  for (const r of current) for (const e of r.evidence) now.set(e.sourceId, e.version);
  const out: KnowledgeImpact[] = [];
  for (const item of pack.items) {
    for (const e of item.evidence) {
      const v = now.get(e.sourceId);
      if (v !== e.version) out.push({ itemId: item.id, text: item.text, locator: e.locator, from: e.version, to: v ?? null });
    }
  }
  return out;
}
