import { describe, it, expect } from 'vitest';
import { graphFromPack, knowledgeImpact, missingRegressionCases, packFromRecommendation, REGRESSION_CASES, unconfirmedItems, validationState, type GateReport } from '../src/pages/sop-workflow';

const full: GateReport = { ok: true, gates: Object.fromEntries(REGRESSION_CASES.map((c) => [c, { ok: true, detail: '' }])) };
const ev = (sourceId: string, version: string, quote: string) => ({ sourceId, version, locator: `${sourceId}#L1`, quote });

describe('validation state', () => {
  it('valid only when passed on the current revision with all regression cases and nothing unsaved', () => {
    expect(validationState({ status: 'passed', revision: 3, validatedRevision: 3, report: full }, false)).toEqual({ kind: 'valid' });
    expect(validationState({ status: 'passed', revision: 3, validatedRevision: 3, report: full }, true)).toEqual({ kind: 'dirty' });
    expect(validationState({ status: 'draft', revision: 4, validatedRevision: 3, report: full }, false)).toEqual({ kind: 'stale', validatedRevision: 3, revision: 4 });
    expect(validationState({ status: 'failed', revision: 1, validatedRevision: 1, report: full }, false)).toEqual({ kind: 'failed' });
    expect(validationState({ status: 'draft', revision: 1, validatedRevision: null, report: null }, false)).toEqual({ kind: 'none' });
    expect(validationState({ status: 'published', revision: 1, validatedRevision: 1, report: full }, false)).toEqual({ kind: 'none' });
  });

  it('a report without the baseline regression cases cannot count as valid', () => {
    const partial: GateReport = { ok: true, gates: { read_ok: { ok: true, detail: '' } } };
    expect(missingRegressionCases(partial)).toHaveLength(9);
    expect(validationState({ status: 'passed', revision: 1, validatedRevision: 1, report: partial }, false)).toMatchObject({ kind: 'incomplete' });
    expect(missingRegressionCases(full)).toEqual([]);
  });
});

describe('SOP packs from the knowledge analysis', () => {
  const rec = { key: 'invoice-intake', kind: 'sop', name: '发票受理', description: '', evidence: [ev('s1', 'v1', '收到发票后核对采购单'), ev('s2', 'v4', '金额超过 5000 需经理审批')] };

  it('every rule and the trigger start unconfirmed and carry their evidence; nothing beyond the cited text', () => {
    const p = packFromRecommendation(rec);
    expect(p.items.map((i) => [i.kind, i.text, i.confirmed])).toEqual([
      ['trigger', '触发：发票受理', false],
      ['rule', '收到发票后核对采购单', false],
      ['rule', '金额超过 5000 需经理审批', false],
    ]);
    expect(unconfirmedItems(p)).toHaveLength(3);
    expect(p.items[2]!.evidence).toEqual([rec.evidence[1]]);
    expect(graphFromPack(p).nodes.map((n) => n.kind)).toEqual(['trigger', 'agent', 'human_review']);
  });

  it('knowledge changes are reported against the evidence the draft was built on', () => {
    const p = packFromRecommendation(rec);
    expect(knowledgeImpact(p, [{ evidence: [ev('s1', 'v1', 'x'), ev('s2', 'v4', 'y')] }])).toEqual([]);
    const changed = knowledgeImpact(p, [{ evidence: [ev('s1', 'v2', 'x')] }]);
    expect(changed.map((c) => [c.itemId, c.from, c.to])).toEqual([
      ['invoice-intake:trigger', 'v1', 'v2'],
      ['invoice-intake:rule:1', 'v1', 'v2'],
      ['invoice-intake:rule:2', 'v4', null], // s2 no longer available
    ]);
  });
});
