/**
 * Recorded browser procedure format (T-43). Recording output is converted to this declarative form: literal business
 * values become parameters mapped to the tool contract inputs, and every procedure ends with read-back assertions.
 * Read and write procedures are separate tools; write procedures always require an exact approval (PRD §3.8).
 */
import { assertNoLoginState } from './guards.js';

export type Step =
  | { op: 'goto'; url: string }
  | { op: 'click'; selector: string }
  | { op: 'fill'; selector: string; param: string } // value comes from inputs[param], never a literal
  | { op: 'select'; selector: string; param: string }
  | { op: 'waitFor'; selector: string }
  | { op: 'submit'; selector: string } // marks a state-changing action
  | { op: 'extract'; selector: string; as: string } // read-back value into outputs[as]
  | { op: 'assertText'; selector: string; equalsParam?: string; contains?: string };

export interface Procedure {
  toolId: string;
  effect: 'read' | 'write';
  params: string[];
  steps: Step[];
}

export function validateProcedure(p: Procedure): void {
  assertNoLoginState(p);
  if (!p.steps.length) throw new Error('procedure has no steps');
  const hasSubmit = p.steps.some((s) => s.op === 'submit');
  if (p.effect === 'read' && hasSubmit) throw new Error('read procedure must not contain submit steps');
  if (p.effect === 'write' && !p.steps.some((s) => s.op === 'extract' || s.op === 'assertText')) {
    throw new Error('write procedure must end with read-back (extract or assertText)');
  }
  for (const s of p.steps) {
    if ((s.op === 'fill' || s.op === 'select') && !p.params.includes(s.param)) throw new Error(`step uses undeclared param ${s.param}`);
  }
}

/** Turns literal values captured during recording into declared parameters. */
export function parameterize(recorded: { op: 'fill' | 'select'; selector: string; value: string }[], names: Record<string, string>): Step[] {
  return recorded.map((r) => {
    const param = names[r.selector];
    if (!param) throw new Error(`no parameter name for ${r.selector}; literal business values cannot be stored in a tool`);
    return { op: r.op, selector: r.selector, param };
  });
}
