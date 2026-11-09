/**
 * SOP graph (PRD §3.6, T-48): the design-time shape of a workflow and its structural checks. Pure functions so the
 * web editor, the publish route and the runtime apply exactly the same rules. Runtime publish gates (missing field,
 * threshold, approval, duplicate event, …) are separate and live with the SOP runtime.
 */
import type { ToolEffect, ToolStage } from './index.js';

export const SOP_NODE_KINDS = ['trigger', 'agent', 'employee', 'tool', 'human_review'] as const;
export type SopNodeKind = (typeof SOP_NODE_KINDS)[number];

export interface SopNode {
  id: string;
  kind: SopNodeKind;
  label: string;
  /** Employee id, tool id, or trigger/source reference. Required for employee and tool nodes. */
  ref?: string;
}

export interface SopEdge {
  from: string;
  to: string;
}

export interface SopGraph {
  nodes: SopNode[];
  edges: SopEdge[];
}

/** What the graph refers to, as known when validating. */
export interface SopGraphContext {
  employees: Record<string, { status: 'active' | 'paused' | 'offline' }>;
  tools: Record<string, { stage: ToolStage; effect: ToolEffect }>;
}

export type SopGraphIssueCode =
  | 'no_trigger'
  | 'multiple_triggers'
  | 'duplicate_node'
  | 'dangling_edge'
  | 'self_loop'
  | 'cycle'
  | 'unreachable'
  | 'missing_ref'
  | 'unknown_ref'
  | 'tool_not_available'
  | 'employee_unavailable'
  | 'write_without_review';

export interface SopGraphIssue {
  code: SopGraphIssueCode;
  nodeId?: string;
  message: string;
}

const WRITE_EFFECTS: ToolEffect[] = ['write', 'external'];

/** Returns every structural problem; an empty list means the graph may go on to the runtime publish gates. */
export function validateSopGraph(g: SopGraph, ctx: SopGraphContext): SopGraphIssue[] {
  const issues: SopGraphIssue[] = [];
  const byId = new Map<string, SopNode>();
  for (const n of g.nodes) {
    if (byId.has(n.id)) issues.push({ code: 'duplicate_node', nodeId: n.id, message: `节点 ${n.id} 重复` });
    byId.set(n.id, n);
  }
  const triggers = g.nodes.filter((n) => n.kind === 'trigger');
  if (!triggers.length) issues.push({ code: 'no_trigger', message: '缺少触发点' });
  if (triggers.length > 1) issues.push({ code: 'multiple_triggers', message: '只能有一个触发点' });

  const out = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) {
      issues.push({ code: 'dangling_edge', message: `连线 ${e.from} → ${e.to} 指向不存在的节点` });
      continue;
    }
    if (e.from === e.to) {
      issues.push({ code: 'self_loop', nodeId: e.from, message: `节点 ${e.from} 连到自己` });
      continue;
    }
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  }

  if (hasCycle([...byId.keys()], out)) issues.push({ code: 'cycle', message: '流程存在循环' });

  const start = triggers[0]?.id;
  const reachable = start ? reach(start, out, () => true) : new Set<string>();
  for (const n of g.nodes) {
    if (start && !reachable.has(n.id)) issues.push({ code: 'unreachable', nodeId: n.id, message: `${n.label} 无法从触发点到达` });
    if ((n.kind === 'tool' || n.kind === 'employee') && !n.ref) {
      issues.push({ code: 'missing_ref', nodeId: n.id, message: `${n.label} 未指定${n.kind === 'tool' ? '工具' : '员工'}` });
      continue;
    }
    if (n.kind === 'employee' && n.ref) {
      const emp = ctx.employees[n.ref];
      if (!emp) issues.push({ code: 'unknown_ref', nodeId: n.id, message: `员工 ${n.ref} 不存在` });
      else if (emp.status !== 'active') issues.push({ code: 'employee_unavailable', nodeId: n.id, message: `员工 ${n.ref} 当前为 ${emp.status}` });
    }
    if (n.kind === 'tool' && n.ref) {
      const tool = ctx.tools[n.ref];
      if (!tool) issues.push({ code: 'unknown_ref', nodeId: n.id, message: `工具 ${n.ref} 不存在` });
      else if (tool.stage !== 'available') issues.push({ code: 'tool_not_available', nodeId: n.id, message: `工具 ${n.ref} 处于「${tool.stage}」，未实现的工具节点不能发布` });
    }
  }

  // Every path from the trigger to a write/external tool must pass a human review node.
  if (start) {
    const withoutReview = reach(start, out, (id) => byId.get(id)?.kind !== 'human_review');
    for (const n of g.nodes) {
      const tool = n.kind === 'tool' && n.ref ? ctx.tools[n.ref] : undefined;
      if (tool && WRITE_EFFECTS.includes(tool.effect) && withoutReview.has(n.id)) {
        issues.push({ code: 'write_without_review', nodeId: n.id, message: `${n.label} 会写入外部系统，之前必须经过人工审核` });
      }
    }
  }
  return issues;
}

function reach(start: string, out: Map<string, string[]>, pass: (id: string) => boolean): Set<string> {
  const seen = new Set<string>([start]);
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    for (const next of out.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (pass(next)) stack.push(next); // a blocked node is reached but not traversed
    }
  }
  return seen;
}

function hasCycle(ids: string[], out: Map<string, string[]>): boolean {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    for (const n of out.get(id) ?? []) if (visit(n)) return true;
    state.set(id, 2);
    return false;
  };
  return ids.some((id) => visit(id));
}

/** Layered layout for drawing: column = longest distance from the trigger, row = order within the column. */
export function layoutSopGraph(g: SopGraph): Map<string, { col: number; row: number }> {
  const out = new Map<string, string[]>();
  for (const e of g.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const col = new Map<string, number>();
  const start = g.nodes.find((n) => n.kind === 'trigger')?.id;
  if (start) {
    col.set(start, 0);
    // longest-path layering on the reachable DAG (bounded by node count to stay safe on bad input)
    for (let pass = 0; pass < g.nodes.length; pass++) {
      let changed = false;
      for (const [from, tos] of out) {
        const c = col.get(from);
        if (c === undefined) continue;
        for (const to of tos) if ((col.get(to) ?? -1) < c + 1 && c + 1 < g.nodes.length) (col.set(to, c + 1), (changed = true));
      }
      if (!changed) break;
    }
  }
  const unplacedCol = Math.max(0, ...col.values()) + 1;
  const rows = new Map<number, number>();
  const pos = new Map<string, { col: number; row: number }>();
  for (const n of g.nodes) {
    const c = col.get(n.id) ?? unplacedCol;
    const r = rows.get(c) ?? 0;
    rows.set(c, r + 1);
    pos.set(n.id, { col: c, row: r });
  }
  return pos;
}
