import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { SOP_NODE_KINDS, validateSopGraph, type SopGraph, type SopGraphContext, type SopNodeKind } from '@superagent/shared';
import { api } from '../api';
import { KIND_LABEL, SopGraphView } from '../components/SopGraphView';
import './SuperAgentPage.css';

/** Contract agreed with the SOP runtime (T-41): /api/v1/sop. */
interface GateReport {
  ok: boolean;
  gates: Record<string, { ok: boolean; detail: string }>;
}
export interface SopVersionView {
  id: string;
  sopId: string;
  number: number;
  status: 'draft' | 'passed' | 'failed' | 'published';
  report: GateReport | null;
  runningInstances: number;
  effectiveAt?: string | null;
  definition: { graph?: SopGraph; [k: string]: unknown };
}
interface SopSummary {
  sopId: string;
  name?: string;
}
interface ToolRow {
  toolId: string;
  name: string;
  stage: SopGraphContext['tools'][string]['stage'];
  effect: SopGraphContext['tools'][string]['effect'];
}
interface EmployeeRow {
  id: string;
  name: string;
  status: string;
}
interface Evidence {
  locator: string;
  quote: string;
}
interface Recommendation {
  id: string;
  key: string;
  kind: string;
  name: string;
  description: string;
  evidence: Evidence[];
  relation?: { from: string; to: string; label: string };
}

const STATUS_LABEL: Record<SopVersionView['status'], string> = { draft: '草稿', passed: '校验通过', failed: '校验未通过', published: '已发布' };
const GATE_LABEL: Record<string, string> = {
  read_ok: '只读步骤可用',
  missing_field: '缺字段时停下补充',
  over_threshold: '超阈值转人工',
  approval_denied: '审批拒绝不执行',
  duplicate_event: '同一事件只开一次',
  employee_offline: '员工离线时不开工',
  paused: '暂停时不开工',
  outcome_unknown: '结果未知不重发',
  permission_revoked: '撤权后停止',
  write_approval: '写入需审批',
};

export function employeeContext(rows: EmployeeRow[]): SopGraphContext['employees'] {
  return Object.fromEntries(rows.map((e) => [e.id, { status: e.status === 'online' || e.status === 'active' ? 'active' : e.status === 'paused' ? 'paused' : 'offline' }]));
}

export function SuperAgentPage() {
  const [tab, setTab] = useState<'sop' | 'ontology'>('sop');
  return (
    <>
      <div className="page-head">
        <h1>超级智能体</h1>
        <p>流程（SOP）与企业本体</p>
      </div>
      <div className="tabs" role="tablist" aria-label="超级智能体">
        <button role="tab" type="button" aria-selected={tab === 'sop'} className="tab" onClick={() => setTab('sop')}>流程</button>
        <button role="tab" type="button" aria-selected={tab === 'ontology'} className="tab" onClick={() => setTab('ontology')}>本体关系</button>
      </div>
      {tab === 'sop' ? <SopWorkspace /> : <OntologyView />}
    </>
  );
}

function SopWorkspace() {
  const [sops, setSops] = useState<SopSummary[] | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [sopId, setSopId] = useState('');
  const [versions, setVersions] = useState<SopVersionView[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [draft, setDraft] = useState<SopGraph>({ nodes: [], edges: [] });
  const [selected, setSelected] = useState<string>();
  const [effectiveAt, setEffectiveAt] = useState('');
  const [msg, setMsg] = useState('');
  const [report, setReport] = useState<GateReport | null>(null);

  const loadList = useCallback(async () => {
    const r = await api<SopSummary[]>('/api/v1/sop');
    if (r.status !== 200) {
      setUnavailable(r.status === 404 ? 'SOP 运行时尚未接入（T-41），暂时只能查看。' : `无法读取流程（${r.status}）`);
      setSops([]);
      return;
    }
    setUnavailable('');
    setSops(r.body);
  }, []);

  useEffect(() => {
    void loadList();
    void api<ToolRow[]>('/api/v1/tools/').then((r) => r.status === 200 && setTools(r.body));
    void api<EmployeeRow[]>('/api/v1/employees/').then((r) => r.status === 200 && setEmployees(r.body));
  }, [loadList]);

  const loadVersions = useCallback(async (id: string) => {
    const r = await api<SopVersionView[]>(`/api/v1/sop/${encodeURIComponent(id)}/versions`);
    const list = r.status === 200 ? [...r.body].sort((a, b) => b.number - a.number) : [];
    setVersions(list);
    const editable = list.find((v) => v.status !== 'published') ?? list.find((v) => v.status === 'published');
    setDraft(structuredClone(editable?.definition.graph ?? { nodes: [], edges: [] }));
    setReport(null);
    setSelected(undefined);
  }, []);

  useEffect(() => {
    if (sopId) void loadVersions(sopId);
  }, [sopId, loadVersions]);

  const ctx = useMemo<SopGraphContext>(
    () => ({ employees: employeeContext(employees), tools: Object.fromEntries(tools.map((t) => [t.toolId, { stage: t.stage, effect: t.effect }])) }),
    [employees, tools],
  );
  const issues = useMemo(() => validateSopGraph(draft, ctx), [draft, ctx]);
  const published = versions.find((v) => v.status === 'published');
  const openDraft = versions.find((v) => v.status !== 'published');
  const node = draft.nodes.find((n) => n.id === selected);

  async function saveDraft() {
    const base = openDraft ?? published;
    const definition = { ...(base?.definition ?? { requiredFields: [], employeeStatus: 'active' }), graph: draft };
    const r = base
      ? await api<SopVersionView>(`/api/v1/sop/drafts/${encodeURIComponent(base.id)}`, { method: 'PUT', body: JSON.stringify({ definition }) })
      : await api<SopVersionView>('/api/v1/sop/drafts', { method: 'POST', body: JSON.stringify({ sopId, definition }) });
    setMsg(r.status === 200 ? `已保存为草稿 v${r.body.number}；已发布版本不受影响` : `未保存（${r.status}）`);
    if (r.status === 200) {
      await loadList();
      await loadVersions(sopId);
    }
  }

  async function publish() {
    if (!openDraft) return;
    const r = await api<SopVersionView & { error?: string; report?: GateReport }>(`/api/v1/sop/${encodeURIComponent(openDraft.id)}/publish`, {
      method: 'POST',
      body: JSON.stringify(effectiveAt ? { effectiveAt: new Date(effectiveAt).toISOString() } : {}),
    });
    await loadVersions(sopId); // reload first: it resets the editor state
    setReport(r.body.report ?? null);
    setMsg(r.status === 200 ? `v${r.body.number} 已发布；在途实例继续按原版本运行` : `未发布：${r.body.error ?? r.status}`);
  }

  if (sops === null) return <p className="helper">读取中…</p>;
  return (
    <div className="sop-workspace">
      {unavailable ? <p className="warn">{unavailable}</p> : null}
      <section className="panel stack">
        <label className="field">
          <span>流程</span>
          <select aria-label="选择流程" value={sopId} onChange={(e) => setSopId(e.target.value)}>
            <option value="">请选择</option>
            {sops.map((s) => (
              <option key={s.sopId} value={s.sopId}>{s.name ?? s.sopId}</option>
            ))}
          </select>
        </label>
      </section>

      {sopId ? (
        <>
          <section className="panel stack" aria-label="版本">
            <h2 className="h2">版本</h2>
            <table className="versions">
              <thead>
                <tr><th>版本</th><th>状态</th><th>生效</th><th>在途实例</th></tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.id} data-version={v.number}>
                    <td>v{v.number}</td>
                    <td>{STATUS_LABEL[v.status]}</td>
                    <td>{v.effectiveAt ? new Date(v.effectiveAt).toLocaleString() : '—'}</td>
                    <td>{v.runningInstances}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="helper">修改总是在草稿上进行，不会改动已发布版本；发布新版本后，在途实例继续按原版本运行。</p>
          </section>

          <section className="panel stack" aria-label="流程图">
            <h2 className="h2">{openDraft ? `草稿 v${openDraft.number}` : published ? `已发布 v${published.number}（编辑将新建草稿）` : '新流程草稿'}</h2>
            <SopGraphView graph={draft} issues={issues} selected={selected} onSelect={setSelected} />
            {node ? <NodeDetail node={node} tools={tools} employees={employees} onRemove={() => {
              setDraft((g) => ({ nodes: g.nodes.filter((n) => n.id !== node.id), edges: g.edges.filter((e) => e.from !== node.id && e.to !== node.id) }));
              setSelected(undefined);
            }} /> : null}
            <GraphEditor graph={draft} tools={tools} employees={employees} onChange={setDraft} />
            <button className="btn" type="button" onClick={() => void saveDraft()}>保存草稿</button>
          </section>

          <section className="panel stack" aria-label="发布">
            <h2 className="h2">发布</h2>
            {issues.length ? (
              <ul className="issues" aria-label="结构问题">
                {issues.map((i, k) => <li key={k} data-issue={i.code}>{i.message}</li>)}
              </ul>
            ) : <p className="helper">结构检查通过。发布时还会运行 10 项运行时门禁。</p>}
            <label className="field">
              <span>生效时间（可选）</span>
              <input type="datetime-local" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} />
            </label>
            <button className="btn primary" type="button" disabled={!openDraft || issues.length > 0} onClick={() => void publish()}>校验并发布</button>
            {!openDraft ? <p className="helper">先保存草稿再发布。</p> : null}
            {report ? (
              <ul className="gates" aria-label="门禁结果">
                {Object.entries(report.gates).map(([k, g]) => (
                  <li key={k} className={g.ok ? 'ok' : 'fail'} data-gate={k}>{g.ok ? '✓' : '✗'} {GATE_LABEL[k] ?? k}{g.detail ? `：${g.detail}` : ''}</li>
                ))}
              </ul>
            ) : null}
          </section>
        </>
      ) : null}
      {msg ? <p className="helper" role="status">{msg}</p> : null}
    </div>
  );
}

function NodeDetail({ node, tools, employees, onRemove }: { node: SopGraph['nodes'][number]; tools: ToolRow[]; employees: EmployeeRow[]; onRemove: () => void }) {
  const tool = node.kind === 'tool' ? tools.find((t) => t.toolId === node.ref) : undefined;
  const emp = node.kind === 'employee' ? employees.find((e) => e.id === node.ref) : undefined;
  return (
    <div className="node-detail" aria-label="节点详情">
      <strong>{KIND_LABEL[node.kind]}：{node.label}</strong>
      {node.ref ? <p>引用：{node.ref}</p> : null}
      {tool ? <p>工具「{tool.name}」· 当前阶段 {tool.stage} · 作用 {tool.effect} · <a href="#tools">打开工具卡</a></p> : null}
      {emp ? <p>员工「{emp.name}」· {emp.status} · <a href="#employees">查看员工</a></p> : null}
      <button className="btn" type="button" onClick={onRemove}>从草稿删除此节点</button>
    </div>
  );
}

function GraphEditor({ graph, tools, employees, onChange }: { graph: SopGraph; tools: ToolRow[]; employees: EmployeeRow[]; onChange: (g: SopGraph) => void }) {
  const [kind, setKind] = useState<SopNodeKind>('agent');
  const [label, setLabel] = useState('');
  const [ref, setRef] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  function addNode(e: FormEvent) {
    e.preventDefault();
    let n = graph.nodes.length + 1;
    while (graph.nodes.some((x) => x.id === `n${n}`)) n++;
    onChange({ ...graph, nodes: [...graph.nodes, { id: `n${n}`, kind, label: label.trim() || KIND_LABEL[kind], ...(ref ? { ref } : {}) }] });
    setLabel('');
    setRef('');
  }
  function addEdge(e: FormEvent) {
    e.preventDefault();
    if (!from || !to || graph.edges.some((x) => x.from === from && x.to === to)) return;
    onChange({ ...graph, edges: [...graph.edges, { from, to }] });
  }
  const refOptions = kind === 'tool' ? tools.map((t) => ({ id: t.toolId, label: `${t.name}（${t.stage}）` })) : kind === 'employee' ? employees.map((x) => ({ id: x.id, label: x.name })) : [];
  return (
    <div className="graph-editor">
      <form className="row" onSubmit={addNode} aria-label="添加节点">
        <select aria-label="节点类型" value={kind} onChange={(e) => (setKind(e.target.value as SopNodeKind), setRef(''))}>
          {SOP_NODE_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <input aria-label="节点名称" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="名称" />
        {refOptions.length ? (
          <select aria-label="引用" value={ref} onChange={(e) => setRef(e.target.value)}>
            <option value="">选择{KIND_LABEL[kind]}</option>
            {refOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        ) : kind === 'trigger' ? <input aria-label="引用" value={ref} onChange={(e) => setRef(e.target.value)} placeholder="来源或日期规则" /> : null}
        <button className="btn" type="submit">添加节点</button>
      </form>
      <form className="row" onSubmit={addEdge} aria-label="添加连线">
        <select aria-label="从" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="">从…</option>
          {graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
        </select>
        <select aria-label="到" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">到…</option>
          {graph.nodes.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
        </select>
        <button className="btn" type="submit">添加连线</button>
      </form>
    </div>
  );
}

/** Objects/entities and relations from the knowledge analysis, each with its evidence. Mobile: a readable list. */
export function OntologyView() {
  const [recs, setRecs] = useState<Recommendation[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<{ recommendations?: Recommendation[]; message?: string }>('/api/v1/knowledge/overview').then((r) => {
      if (r.status === 200) setRecs((r.body.recommendations ?? []).filter((x) => x.kind === 'object' || x.kind === 'relation'));
      else setError(r.status === 503 ? '企业知识存储尚未配置，无法生成本体。' : r.body.message ?? `无法读取（${r.status}）`);
    });
  }, []);
  if (error) return <p className="warn">{error}</p>;
  if (!recs) return <p className="helper">读取中…</p>;
  return <OntologyList items={recs} />;
}

export function OntologyList({ items }: { items: Recommendation[] }) {
  const objects = items.filter((i) => i.kind === 'object');
  const relations = items.filter((i) => i.kind === 'relation' && i.relation);
  if (!objects.length) return <p className="helper">还没有经确认来源支持的对象。先在企业知识里确认来源并运行分析。</p>;
  const nameOf = (key: string) => objects.find((o) => o.key === key)?.name ?? key;
  return (
    <div className="ontology">
      <section className="panel stack" aria-label="对象与实体">
        <h2 className="h2">对象与实体</h2>
        <ul className="onto-list">
          {objects.map((o) => (
            <li key={o.id} data-object={o.key}>
              <strong>{o.name}</strong> <span className="helper">{o.description}</span>
              <Evidences ev={o.evidence} />
            </li>
          ))}
        </ul>
      </section>
      <section className="panel stack" aria-label="关系">
        <h2 className="h2">关系</h2>
        {relations.length ? (
          <ul className="onto-list">
            {relations.map((r) => (
              <li key={r.id} data-relation={r.key}>
                <strong>{nameOf(r.relation!.from)}</strong> —{r.relation!.label}→ <strong>{nameOf(r.relation!.to)}</strong>
                <Evidences ev={r.evidence} />
              </li>
            ))}
          </ul>
        ) : <p className="helper">分析尚未给出带依据的关系。</p>}
      </section>
    </div>
  );
}

function Evidences({ ev }: { ev: Evidence[] }) {
  return (
    <ul className="evidence" aria-label="依据">
      {ev.map((e, i) => <li key={i}><cite>{e.locator}</cite> “{e.quote}”</li>)}
    </ul>
  );
}
