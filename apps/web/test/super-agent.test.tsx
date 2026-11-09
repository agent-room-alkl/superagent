import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { validateSopGraph, type SopGraph } from '@superagent/shared';
import { SopGraphView } from '../src/components/SopGraphView';
import { OntologyList, employeeContext } from '../src/pages/SuperAgentPage';

const graph: SopGraph = {
  nodes: [
    { id: 't', kind: 'trigger', label: '收到发票' },
    { id: 'e', kind: 'employee', label: '应付专员', ref: 'emp-1' },
    { id: 'w', kind: 'tool', label: '登记付款', ref: 'erp.post' },
  ],
  edges: [{ from: 't', to: 'e' }, { from: 'e', to: 'w' }],
};

describe('SOP graph view', () => {
  it('draws every node as a labelled button with its kind, and marks nodes that have structural issues', () => {
    const issues = validateSopGraph(graph, { employees: { 'emp-1': { status: 'active' } }, tools: { 'erp.post': { stage: 'available', effect: 'write' } } });
    expect(issues.map((i) => i.code)).toEqual(['write_without_review']);
    const html = renderToStaticMarkup(<SopGraphView graph={graph} issues={issues} selected="e" />);
    expect(html.match(/<button/g)).toHaveLength(3);
    expect(html).toContain('aria-label="触发点：收到发票"');
    expect(html).toContain('问题：登记付款 会写入外部系统，之前必须经过人工审核');
    expect(html).toMatch(/class="sop-node kind-tool has-issue"/);
    expect(html).toMatch(/kind-employee selected/);
    expect(html.match(/class="sop-edge"/g)).toHaveLength(2);
  });

  it('an empty draft says so instead of drawing nothing', () => {
    expect(renderToStaticMarkup(<SopGraphView graph={{ nodes: [], edges: [] }} />)).toContain('草稿里还没有节点');
  });

  it('maps employee runtime status onto graph availability', () => {
    expect(employeeContext([{ id: 'a', name: 'A', status: 'online' }, { id: 'b', name: 'B', status: 'paused' }, { id: 'c', name: 'C', status: 'unconnected' }])).toEqual({
      a: { status: 'active' },
      b: { status: 'paused' },
      c: { status: 'offline' },
    });
  });
});

describe('ontology list', () => {
  const ev = [{ locator: 'policy.md#L3', quote: '供应商发票须匹配采购单' }];
  it('lists objects and relations, each with its evidence', () => {
    const html = renderToStaticMarkup(
      <OntologyList
        items={[
          { id: '1', key: 'invoice', kind: 'object', name: '发票', description: '供应商开具', evidence: ev },
          { id: '2', key: 'po', kind: 'object', name: '采购单', description: '内部审批', evidence: ev },
          { id: '3', key: 'invoice-po', kind: 'relation', name: '匹配', description: '', evidence: ev, relation: { from: 'invoice', to: 'po', label: '须匹配' } },
        ]}
      />,
    );
    expect(html).toContain('data-object="invoice"');
    expect(html).toContain('<strong>发票</strong> —须匹配→ <strong>采购单</strong>');
    expect(html.match(/policy\.md#L3/g)).toHaveLength(3);
  });

  it('shows an honest empty state instead of inventing objects or relations', () => {
    expect(renderToStaticMarkup(<OntologyList items={[]} />)).toContain('还没有经确认来源支持的对象');
    const onlyObjects = renderToStaticMarkup(<OntologyList items={[{ id: '1', key: 'a', kind: 'object', name: 'A', description: '', evidence: ev }]} />);
    expect(onlyObjects).toContain('分析尚未给出带依据的关系');
  });
});
