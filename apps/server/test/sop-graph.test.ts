import { describe, it, expect } from 'vitest';
import { layoutSopGraph, validateSopGraph, type SopGraph, type SopGraphContext } from '@superagent/shared';

const ctx: SopGraphContext = {
  employees: { 'emp-ap': { status: 'active' }, 'emp-off': { status: 'offline' } },
  tools: {
    'invoice.lookup': { stage: 'available', effect: 'read' },
    'erp.post': { stage: 'available', effect: 'write' },
    'mail.send': { stage: 'available', effect: 'external' },
    'new.tool': { stage: 'placeholder', effect: 'read' },
  },
};

const good: SopGraph = {
  nodes: [
    { id: 't', kind: 'trigger', label: '收到发票邮件', ref: 'mail:inbox' },
    { id: 'a', kind: 'agent', label: '超级智能体分派' },
    { id: 'e', kind: 'employee', label: '应付专员', ref: 'emp-ap' },
    { id: 'r', kind: 'tool', label: '查询发票', ref: 'invoice.lookup' },
    { id: 'h', kind: 'human_review', label: '财务审核' },
    { id: 'w', kind: 'tool', label: '登记付款', ref: 'erp.post' },
  ],
  edges: [
    { from: 't', to: 'a' },
    { from: 'a', to: 'e' },
    { from: 'e', to: 'r' },
    { from: 'r', to: 'h' },
    { from: 'h', to: 'w' },
  ],
};
const codes = (g: SopGraph) => validateSopGraph(g, ctx).map((i) => i.code);

describe('SOP graph structure checks', () => {
  it('a well-formed graph with review before the write passes', () => {
    expect(validateSopGraph(good, ctx)).toEqual([]);
  });

  it('exactly one trigger', () => {
    expect(codes({ ...good, nodes: good.nodes.filter((n) => n.id !== 't'), edges: good.edges.filter((e) => e.from !== 't') })).toContain('no_trigger');
    expect(codes({ ...good, nodes: [...good.nodes, { id: 't2', kind: 'trigger', label: 'x' }] })).toContain('multiple_triggers');
  });

  it('a write or external tool reachable without human review is refused', () => {
    const bypass = { ...good, edges: [...good.edges, { from: 'r', to: 'w' }] };
    expect(validateSopGraph(bypass, ctx)).toEqual([expect.objectContaining({ code: 'write_without_review', nodeId: 'w' })]);
    const send = { nodes: [...good.nodes, { id: 's', kind: 'tool' as const, label: '发邮件', ref: 'mail.send' }], edges: [...good.edges, { from: 'e', to: 's' }] };
    expect(codes(send)).toEqual(['write_without_review']);
  });

  it('unimplemented (placeholder) tools and unknown refs block publishing', () => {
    const g = { nodes: [...good.nodes, { id: 'p', kind: 'tool' as const, label: '新工具', ref: 'new.tool' }, { id: 'u', kind: 'tool' as const, label: '?', ref: 'nope' }], edges: [...good.edges, { from: 'e', to: 'p' }, { from: 'e', to: 'u' }] };
    expect(codes(g).sort()).toEqual(['tool_not_available', 'unknown_ref']);
  });

  it('missing refs, offline employees, unreachable nodes, dangling edges, self loops, duplicates and cycles', () => {
    expect(codes({ nodes: [...good.nodes, { id: 'x', kind: 'employee', label: '无人' }], edges: [...good.edges, { from: 'a', to: 'x' }] })).toEqual(['missing_ref']);
    expect(codes({ nodes: [...good.nodes, { id: 'o', kind: 'employee', label: '离线', ref: 'emp-off' }], edges: [...good.edges, { from: 'a', to: 'o' }] })).toEqual(['employee_unavailable']);
    expect(codes({ ...good, nodes: [...good.nodes, { id: 'z', kind: 'agent', label: '孤立' }] })).toEqual(['unreachable']);
    expect(codes({ ...good, edges: [...good.edges, { from: 'a', to: 'ghost' }] })).toEqual(['dangling_edge']);
    expect(codes({ ...good, edges: [...good.edges, { from: 'a', to: 'a' }] })).toEqual(['self_loop']);
    expect(codes({ ...good, nodes: [...good.nodes, { id: 'a', kind: 'agent', label: 'dup' }] })).toContain('duplicate_node');
    expect(codes({ ...good, edges: [...good.edges, { from: 'h', to: 'e' }] })).toContain('cycle');
  });

  it('layout places nodes by distance from the trigger', () => {
    const pos = layoutSopGraph(good);
    expect(['t', 'a', 'e', 'r', 'h', 'w'].map((id) => pos.get(id)!.col)).toEqual([0, 1, 2, 3, 4, 5]);
    const branch = layoutSopGraph({ nodes: [...good.nodes, { id: 'b', kind: 'tool', label: 'b', ref: 'invoice.lookup' }], edges: [...good.edges, { from: 'a', to: 'b' }] });
    expect(branch.get('b')).toEqual({ col: 2, row: 1 });
    const cyclic = layoutSopGraph({ ...good, edges: [...good.edges, { from: 'w', to: 'a' }] }); // terminates on bad input
    expect(cyclic.size).toBe(good.nodes.length);
  });
});
