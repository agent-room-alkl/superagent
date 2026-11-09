import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { SOP_NODE_KINDS, validateSopGraph, type SopGraph, type SopGraphContext, type SopNodeKind } from '@superagent/shared';
import { api } from '../api';
import { KIND_LABEL, SopGraphView } from '../components/SopGraphView';
import { graphFromPack, knowledgeImpact, packFromRecommendation, unconfirmedItems, validationState, type KnowledgeEvidence, type SopPack } from './sop-workflow';
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
  /** Bumped by every saved revision; validation is valid only for the revision it ran on. */
  revision?: number;
  validatedRevision?: number | null;
  definition: { graph?: SopGraph; pack?: SopPack | null; [k: string]: unknown };
}
interface KnowledgeRecommendation {
  key: string;
  kind: string;
  name: string;
  description: string;
  evidence: KnowledgeEvidence[];
}
interface SopSummary {
  sopId: string;
  latest?: { id: string; number: number; status: SopVersionView['status'] };
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

interface RulesForm {
  requiredFields: string;
  thresholdField: string;
  thresholdMax: string;
}
/** SOP run rules as edited on the page (the runtime's SopDefinition requiredFields / threshold). */
function rulesFrom(def: SopVersionView['definition'] | undefined): RulesForm {
  const req = Array.isArray(def?.requiredFields) ? (def!.requiredFields as string[]) : [];
  const th = def?.threshold as { field?: string; max?: number } | undefined;
  return { requiredFields: req.join(', '), thresholdField: th?.field ?? '', thresholdMax: th?.max != null ? String(th.max) : '' };
}
/** Always sets both keys: a cleared threshold becomes undefined (dropped on save), never the previous value. */
function rulesTo(r: RulesForm): { requiredFields: string[]; threshold: { field: string; max: number } | undefined } {
  const requiredFields = r.requiredFields.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
  const max = Number(r.thresholdMax);
  return { requiredFields, threshold: r.thresholdField.trim() && r.thresholdMax.trim() && Number.isFinite(max) ? { field: r.thresholdField.trim(), max } : undefined };
}

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
  const [newSopId, setNewSopId] = useState('');
  const [versions, setVersions] = useState<SopVersionView[]>([]);
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [knowledge, setKnowledge] = useState<{ recs: KnowledgeRecommendation[] } | { error: string } | null>(null);
  const [draft, setDraft] = useState<SopGraph>({ nodes: [], edges: [] });
  const [pack, setPack] = useState<SopPack | undefined>();
  const [rules, setRules] = useState<RulesForm>(rulesFrom(undefined));
  const [pendingPack, setPendingPack] = useState<SopPack | undefined>();
  const [selected, setSelected] = useState<string>();
  const [effectiveAt, setEffectiveAt] = useState('');
  const [msg, setMsg] = useState('');

  const loadList = useCallback(async () => {
    const r = await api<{ sops: SopSummary[] }>('/api/v1/sop');
    if (r.status !== 200) {
      setUnavailable(r.status === 404 ? 'SOP 运行时尚未接入（T-41），暂时只能查看。' : `无法读取流程（${r.status}）`);
      setSops([]);
      return;
    }
    setUnavailable('');
    setSops(Array.isArray(r.body.sops) ? r.body.sops : []);
  }, []);

  useEffect(() => {
    void loadList();
    void api<ToolRow[]>('/api/v1/tools/').then((r) => r.status === 200 && setTools(r.body));
    void api<EmployeeRow[]>('/api/v1/employees/').then((r) => r.status === 200 && setEmployees(r.body));
    void api<{ recommendations?: KnowledgeRecommendation[]; message?: string }>('/api/v1/knowledge/overview').then((r) =>
      setKnowledge(r.status === 200 ? { recs: r.body.recommendations ?? [] } : { error: r.status === 503 ? '企业知识存储尚未配置，暂无流程包。' : r.body.message ?? `无法读取知识（${r.status}）` }),
    );
  }, [loadList]);

  const loadVersions = useCallback(async (id: string) => {
    const r = await api<{ versions: SopVersionView[] }>(`/api/v1/sop/${encodeURIComponent(id)}/versions`);
    const list = r.status === 200 && Array.isArray(r.body.versions) ? [...r.body.versions].sort((a, b) => b.number - a.number) : [];
    setVersions(list);
    const editable = list.find((v) => v.status !== 'published') ?? list.find((v) => v.status === 'published');
    setDraft(structuredClone(editable?.definition.graph ?? { nodes: [], edges: [] }));
    setPack(editable?.definition.pack ? structuredClone(editable.definition.pack) : undefined);
    setRules(rulesFrom(editable?.definition));
    setPendingPack(undefined);
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
  const saved = openDraft ?? published;
  const dirty =
    !!saved &&
    (JSON.stringify(saved.definition.graph ?? { nodes: [], edges: [] }) !== JSON.stringify(draft) ||
      JSON.stringify(saved.definition.pack ?? null) !== JSON.stringify(pack ?? null) ||
      JSON.stringify(rulesFrom(saved.definition)) !== JSON.stringify(rules));
  const vstate = validationState(openDraft, dirty);
  const unconfirmed = unconfirmedItems(pack);
  const packs = 'recs' in (knowledge ?? {}) ? (knowledge as { recs: KnowledgeRecommendation[] }).recs.filter((r) => r.kind === 'sop').map(packFromRecommendation) : [];
  const impact = 'recs' in (knowledge ?? {}) ? knowledgeImpact(pack, (knowledge as { recs: KnowledgeRecommendation[] }).recs) : [];
  const node = draft.nodes.find((n) => n.id === selected);
  const canValidate = !!openDraft && !dirty && !issues.length && !unconfirmed.length;
  const canPublish = canValidate && vstate.kind === 'valid';

  async function save(graph = draft, nextPack = pack, forSop = sopId) {
    const base = forSop === sopId ? (openDraft ?? published) : undefined;
    const definition = { ...(base?.definition ?? { employeeStatus: 'active' }), ...rulesTo(rules), graph, pack: nextPack ?? null };
    const r = base
      ? await api<SopVersionView>(`/api/v1/sop/drafts/${encodeURIComponent(base.id)}`, { method: 'PUT', body: JSON.stringify({ definition }) })
      : await api<SopVersionView>('/api/v1/sop/drafts', { method: 'POST', body: JSON.stringify({ sopId: forSop, definition }) });
    setMsg(r.status === 200 ? `已保存为草稿 v${r.body.number}；已发布版本不受影响` : `未保存（${r.status}）`);
    if (r.status === 200) {
      await loadList();
      if (forSop !== sopId) setSopId(forSop);
      else await loadVersions(forSop);
    }
  }

  async function validate() {
    if (!openDraft) return;
    const r = await api<{ status?: string; error?: string; issues?: { message: string }[] }>(`/api/v1/sop/${encodeURIComponent(openDraft.id)}/validate`, {
      method: 'POST',
      body: JSON.stringify({ employees: ctx.employees, tools: ctx.tools }),
    });
    await loadVersions(sopId);
    setMsg(r.status === 200 ? (r.body.status === 'passed' ? '校验通过，可以发布' : '校验未通过，见回归用例') : `未校验：${r.body.issues?.map((i) => i.message).join('；') || r.body.error || r.status}`);
  }

  async function publish() {
    if (!openDraft) return;
    const r = await api<SopVersionView & { error?: string; issues?: { message: string }[] }>(`/api/v1/sop/${encodeURIComponent(openDraft.id)}/publish`, {
      method: 'POST',
      body: JSON.stringify({ ...(effectiveAt ? { effectiveAt: new Date(effectiveAt).toISOString() } : {}), employees: ctx.employees, tools: ctx.tools }),
    });
    await loadVersions(sopId); // reload first: it resets the editor state
    setMsg(r.status === 200 ? `v${r.body.number} 已发布；在途实例继续按原版本运行` : `未发布：${r.body.issues?.map((i) => i.message).join('；') || (r.body.error === 'validation_stale' ? '校验已失效，请重新校验' : r.body.error) || r.status}`);
  }

  /** Applying a pack never touches a published version and never replaces a non-empty draft without confirmation. */
  function requestPack(p: SopPack) {
    if (sopId && draft.nodes.length && openDraft) setPendingPack(p);
    else void applyPack(p);
  }
  async function applyPack(p: SopPack) {
    setPendingPack(undefined);
    const target = sopId || newSopId.trim() || `sop.${p.key}`;
    const fresh = structuredClone(p);
    setDraft(graphFromPack(fresh));
    setPack(fresh);
    await save(graphFromPack(fresh), fresh, target);
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
              <option key={s.sopId} value={s.sopId}>{s.sopId}{s.latest ? `（v${s.latest.number} ${STATUS_LABEL[s.latest.status]}）` : ''}</option>
            ))}
          </select>
        </label>
        {!sopId ? (
          <label className="field">
            <span>新流程编号（从流程包新建时使用）</span>
            <input aria-label="新流程编号" value={newSopId} onChange={(e) => setNewSopId(e.target.value)} placeholder="例如 sop.invoice-intake" />
          </label>
        ) : null}
      </section>

      <section className="panel stack" aria-label="流程包">
        <h2 className="h2">流程包（来自企业知识分析）</h2>
        {knowledge && 'error' in knowledge ? <p className="helper">{knowledge.error}</p> : null}
        {knowledge && 'recs' in knowledge && !packs.length ? <p className="helper">分析还没有给出有依据的流程建议。</p> : null}
        <ul className="onto-list">
          {packs.map((p) => (
            <li key={p.key} data-pack={p.key}>
              <strong>{p.name}</strong> <span className="helper">{p.items.length} 项（触发 1，规则 {p.items.length - 1}），套用后逐项确认</span>
              <button className="btn" type="button" onClick={() => requestPack(p)}>套用到草稿</button>
            </li>
          ))}
        </ul>
        {pendingPack ? (
          <div className="warn" role="alertdialog" aria-label="确认替换草稿">
            <p>将用流程包「{pendingPack.name}」替换当前草稿 v{openDraft?.number} 的内容。已发布版本不受影响。</p>
            <button className="btn primary" type="button" onClick={() => void applyPack(pendingPack)}>确认替换</button>
            <button className="btn" type="button" onClick={() => setPendingPack(undefined)}>取消</button>
          </div>
        ) : null}
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
            <fieldset className="pack-items" aria-label="运行规则">
              <legend>运行规则（校验时用作回归用例的输入）</legend>
              <label className="field">
                <span>必填字段（逗号分隔，缺少时停下补充）</span>
                <input aria-label="必填字段" value={rules.requiredFields} onChange={(e) => setRules({ ...rules, requiredFields: e.target.value })} placeholder="例如 发票号, 金额" />
              </label>
              <label className="field">
                <span>超阈值转人工：字段</span>
                <input aria-label="阈值字段" value={rules.thresholdField} onChange={(e) => setRules({ ...rules, thresholdField: e.target.value })} placeholder="例如 金额" />
              </label>
              <label className="field">
                <span>超阈值转人工：上限</span>
                <input aria-label="阈值上限" inputMode="decimal" value={rules.thresholdMax} onChange={(e) => setRules({ ...rules, thresholdMax: e.target.value })} placeholder="例如 5000" />
              </label>
            </fieldset>
            {pack ? (
              <fieldset className="pack-items" aria-label="流程包确认">
                <legend>流程包「{pack.name}」：规则与触发需逐项确认</legend>
                {pack.items.map((it) => (
                  <label key={it.id} className="pack-item" data-item={it.id}>
                    <input
                      type="checkbox"
                      checked={it.confirmed}
                      onChange={(e) => setPack((p) => p && { ...p, items: p.items.map((x) => (x.id === it.id ? { ...x, confirmed: e.target.checked } : x)) })}
                    />
                    <span>{it.kind === 'trigger' ? '触发' : '规则'}：{it.text}</span>
                    <small>{it.evidence.map((e) => e.locator).join('，')}</small>
                  </label>
                ))}
              </fieldset>
            ) : null}
            {impact.length ? (
              <div className="warn" role="region" aria-label="知识变化影响">
                <strong>企业知识已变化，以下内容的依据受影响：</strong>
                <ul>
                  {impact.map((i, k) => (
                    <li key={k} data-impact={i.itemId}>{i.text}（{i.locator}）：依据 {i.from} → {i.to ?? '已不可用'}</li>
                  ))}
                </ul>
                <p>请核对后修改草稿并重新校验。</p>
              </div>
            ) : null}
            <button className="btn" type="button" onClick={() => void save()}>保存草稿</button>
          </section>

          <section className="panel stack" aria-label="校验与发布">
            <h2 className="h2">校验与发布</h2>
            {issues.length ? (
              <ul className="issues" aria-label="结构问题">
                {issues.map((i, k) => <li key={k} data-issue={i.code}>{i.message}</li>)}
              </ul>
            ) : <p className="helper">结构检查通过。</p>}
            {unconfirmed.length ? <p className="warn" data-block="pack">流程包还有 {unconfirmed.length} 项规则或触发未确认，确认并保存后才能校验和发布。</p> : null}
            {vstate.kind === 'dirty' ? <p className="warn" data-block="dirty">有未保存的修改：保存后需要重新校验。</p> : null}
            {vstate.kind === 'stale' ? <p className="warn" data-block="stale">草稿已修改，之前的校验已失效（校验于第 {vstate.validatedRevision} 次修订，当前第 {vstate.revision} 次）。请重新校验。</p> : null}
            {vstate.kind === 'incomplete' ? <p className="warn" data-block="incomplete">校验缺少回归用例：{vstate.missing.map((m) => GATE_LABEL[m] ?? m).join('，')}。不能发布。</p> : null}
            {vstate.kind === 'failed' ? <p className="warn" data-block="failed">校验未通过，修改后重新校验。</p> : null}
            <button className="btn" type="button" disabled={!canValidate} onClick={() => void validate()}>校验（运行回归用例）</button>
            {openDraft?.report ? (
              <ul className="gates" aria-label="回归用例">
                {Object.entries(openDraft.report.gates).map(([k, g]) => (
                  <li key={k} className={g.ok ? 'ok' : 'fail'} data-gate={k}>{g.ok ? '✓' : '✗'} {GATE_LABEL[k] ?? k}{g.detail ? `：${g.detail}` : ''}</li>
                ))}
              </ul>
            ) : null}
            <label className="field">
              <span>生效时间（可选）</span>
              <input type="datetime-local" value={effectiveAt} onChange={(e) => setEffectiveAt(e.target.value)} />
            </label>
            <button className="btn primary" type="button" disabled={!canPublish} onClick={() => void publish()}>发布</button>
            {!openDraft ? <p className="helper">先保存草稿，再校验和发布。</p> : null}
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
