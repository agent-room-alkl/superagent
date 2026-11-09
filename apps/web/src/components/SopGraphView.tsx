import { layoutSopGraph, type SopGraph, type SopGraphIssue, type SopNodeKind } from '@superagent/shared';

export const KIND_LABEL: Record<SopNodeKind, string> = {
  trigger: '触发点',
  agent: '超级智能体',
  employee: '员工',
  tool: '工具',
  human_review: '人工审核',
};

const W = 168;
const H = 56;
const GX = 48;
const GY = 28;

/**
 * Read-only drawing of an SOP graph. Nodes are buttons (keyboard reachable); nodes with structural issues are
 * marked and described for screen readers. Layout columns follow distance from the trigger.
 */
export function SopGraphView({ graph, issues = [], selected, onSelect }: { graph: SopGraph; issues?: SopGraphIssue[]; selected?: string; onSelect?: (id: string) => void }) {
  const pos = layoutSopGraph(graph);
  const cols = Math.max(1, ...[...pos.values()].map((p) => p.col + 1));
  const rows = Math.max(1, ...[...pos.values()].map((p) => p.row + 1));
  const width = cols * (W + GX);
  const height = rows * (H + GY);
  const at = (id: string) => pos.get(id) ?? { col: 0, row: 0 };
  const bad = new Map<string, string[]>();
  for (const i of issues) if (i.nodeId) bad.set(i.nodeId, [...(bad.get(i.nodeId) ?? []), i.message]);

  if (!graph.nodes.length) return <p className="helper">草稿里还没有节点。</p>;
  return (
    <div className="sop-graph" role="group" aria-label="流程图">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="sop-edges">
        {graph.edges.map((e, i) => {
          const a = at(e.from);
          const b = at(e.to);
          const x1 = a.col * (W + GX) + W;
          const y1 = a.row * (H + GY) + H / 2;
          const x2 = b.col * (W + GX);
          const y2 = b.row * (H + GY) + H / 2;
          return <path key={i} d={`M${x1},${y1} C${x1 + GX / 2},${y1} ${x2 - GX / 2},${y2} ${x2},${y2}`} className="sop-edge" />;
        })}
      </svg>
      {graph.nodes.map((n) => {
        const p = at(n.id);
        const problems = bad.get(n.id);
        return (
          <button
            key={n.id}
            type="button"
            className={`sop-node kind-${n.kind}${problems ? ' has-issue' : ''}${selected === n.id ? ' selected' : ''}`}
            style={{ left: p.col * (W + GX), top: p.row * (H + GY), width: W, height: H }}
            onClick={() => onSelect?.(n.id)}
            aria-pressed={selected === n.id}
            aria-label={`${KIND_LABEL[n.kind]}：${n.label}${problems ? `。问题：${problems.join('；')}` : ''}`}
            data-node={n.id}
          >
            <small>{KIND_LABEL[n.kind]}</small>
            <span>{n.label}</span>
          </button>
        );
      })}
    </div>
  );
}
