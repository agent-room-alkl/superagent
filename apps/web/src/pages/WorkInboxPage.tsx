import { useCallback, useEffect, useState, type FormEvent } from 'react';
import './execution.css';
import { api } from '../api';

/**
 * 待我处理 (PRD §3.8): only the items the server assigns to the signed-in user, grouped, with the exact content
 * being decided. Every control maps to a server rule; the page never decides what is allowed on its own (canAct
 * comes from the same guard the mutations use).
 */
type Group = 'action' | 'waiting' | 'internal';

interface BatchRow { id: string; clean: boolean; selected: boolean; executed: boolean; projectId?: string | null }

export interface ServerWorkItem {
  id: string;
  kind: string;
  renderer: string;
  status: string;
  projectId?: string | null;
  assigneeUserId?: string;
  payloadVersion: number;
  payloadHash?: string;
  actionStatus: string | null;
  payload: Record<string, unknown>;
  decision?: { by: string; payloadHash: string } | null;
  draft?: Record<string, unknown> | null;
  rows?: BatchRow[];
  systemVerified?: boolean;
  evidenceSource?: 'system' | 'human_report' | null;
  waitingOn?: string | null;
  canAct?: boolean;
  longwork?: { type: 'match' | 'waiting' | 'batch' | 'collection' | 'collection-response'; id: string; projectId: string };
}

interface InboxItem {
  id: string;
  title: string;
  kind: string;
  renderer: string;
  group: Group;
  due: string;
  why: string;
  payloadVersion: number;
  fromServer: boolean;
  actionStatus: string | null;
  /** The exact content being decided (approval parameters), shown before deciding. */
  fields?: [string, string][];
}

export const KIND_LABEL: Record<string, string> = {
  data_check: '数据核对与修正',
  action_approval: '精确动作批准',
  manual_execution: '人工执行并回填',
  branch_choice: '正常分支选择',
  exception_ruling: '例外裁定',
  supply_info: '补资料',
  deliverable_review: '成果复核',
};

export const RENDERER_LABEL: Record<string, string> = {
  field_diff: '字段差异卡',
  batch_table: '批量明细表',
  document_preview: '邮件 / 文档预览',
  issue_list: '问题清单',
};

const STATUS_LABEL: Record<string, string> = {
  open: '待处理', in_progress: '处理中', needs_info: '缺资料', decided: '已决定', closed: '已关闭', expired: '已过期', withdrawn: '已撤回，等待按新版本决定',
};

export const GROUPS: { id: Group; label: string }[] = [
  { id: 'action', label: '需要我行动' },
  { id: 'waiting', label: '等待外部' },
  { id: 'internal', label: '内部未完' },
];

/** Payload keys that are references or rendered separately, not content the approver decides on. */
const INTERNAL_FIELDS = new Set(['executionId', 'stepId', 'title', 'why', 'due', 'options', 'to', 'attachments', 'original', 'changes', 'note', 'humanReference', 'branch', 'dataCheckId', 'sopStart']);

/** An unknown write stays submitted once. The inbox does not offer another decide. */
export function canDecide(item: Pick<InboxItem, 'fromServer' | 'actionStatus'>): boolean {
  return item.fromServer && item.actionStatus !== 'outcome_unknown';
}

export function decisionWhy(reason: string | undefined, current: string): string {
  if (reason === 'version_conflict') return '版本已变，请按新版本再决定。';
  if (reason === 'no_resubmit') return '结果未知，不能再次提交。';
  if (reason === 'invalid_amount') return '金额无效，不能确认。';
  if (reason === 'waiting_data_confirmation') return '上游的数据核对还没确认，不能批准写入。';
  if (reason === 'conflict') return '这一项已经决定过了。';
  return current;
}

export function groupOf(item: Pick<ServerWorkItem, 'waitingOn' | 'kind'>): Group {
  if (item.waitingOn) return 'waiting';
  if (item.kind === 'supply_info' || item.kind === 'branch_choice') return 'internal';
  return 'action';
}

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

export function fieldsOf(payload: Record<string, unknown>): [string, string][] {
  return Object.entries(payload ?? {}).filter(([key]) => !INTERNAL_FIELDS.has(key)).map(([key, value]): [string, string] => [key, text(value)]);
}

/** A successful list replaces whatever was shown. An empty list stays empty — there is no sample data. */
export function inboxFromServer(items: ServerWorkItem[] | undefined): InboxItem[] | null {
  if (!items) return null;
  return items.map((item) => ({
    id: item.id,
    title: String(item.payload.title ?? KIND_LABEL[item.kind] ?? item.kind),
    kind: KIND_LABEL[item.kind] ?? item.kind,
    renderer: RENDERER_LABEL[item.renderer] ?? item.renderer,
    group: groupOf(item),
    due: typeof item.payload.due === 'string' ? item.payload.due : '未设截止',
    why: typeof item.payload.why === 'string' ? item.payload.why : '',
    payloadVersion: item.payloadVersion,
    fromServer: true,
    actionStatus: item.actionStatus,
    fields: fieldsOf(item.payload),
  }));
}

export function WorkInboxPage() {
  const [items, setItems] = useState<ServerWorkItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [group, setGroup] = useState<Group | 'all'>('all');
  const [project, setProject] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const query = new URLSearchParams();
    if (project) query.set('project', project);
    if (exceptionsOnly) query.set('exceptions', '1');
    try {
      const r = await api<{ items?: ServerWorkItem[] }>(`/api/v1/work-items${query.size ? `?${query}` : ''}`);
      if (r.status !== 200 || !r.body.items) {
        setFailed(true);
        return;
      }
      setFailed(false);
      setItems(r.body.items);
      if (!project && !exceptionsOnly) {
        const ids = r.body.items.flatMap((i) => [i.projectId, ...(i.rows ?? []).map((row) => row.projectId)]);
        setProjects([...new Set(ids.filter((p): p is string => !!p))].sort());
      }
    } catch {
      setFailed(true);
    }
  }, [project, exceptionsOnly]);
  useEffect(() => void load(), [load]);

  const visible = (items ?? []).filter((item) => group === 'all' || groupOf(item) === group);
  const open = (items ?? []).find((item) => item.id === openId) ?? null;

  async function post(path: string, body: unknown, done?: (data: Record<string, unknown>) => string) {
    if (!open) return;
    const areas = { match: 'exceptions', waiting: 'items', batch: 'batches', collection: 'collections', 'collection-response': 'collections' };
    const url = open.longwork
      ? `/api/v1/long-items/${areas[open.longwork.type]}/${encodeURIComponent(open.longwork.id)}/${path}`
      : `/api/v1/work-items/${open.id}/${path}`;
    const data = open.longwork ? { ...(body as Record<string, unknown>), projectId: open.longwork.projectId } : body;
    let r: { status: number; body: Record<string, unknown> };
    try { r = await api<Record<string, unknown>>(url, { method: 'POST', body: JSON.stringify(data) }); }
    catch { setMsg('没能确认处理结果，请核对当前状态；结果未知的动作只做回读。'); await load(); return; }
    if (r.status === 403) setMsg('这不是分给你的事项，只能查看。');
    else if (r.body.error === 'connector_not_configured') setMsg('未配置可用连接器；没有提交任何外部动作，已批准的行仍保留。');
    else if (r.status >= 400) setMsg(decisionWhy(String(r.body.error ?? ''), `未完成：${String(r.body.error ?? r.status)}`));
    else setMsg(done ? done(r.body) : '');
    await load();
  }

  return (
    <section className="exec-inbox" aria-label="待我处理">
      <div className="page-head">
        <h1 id="page-title">待我处理</h1>
        <p>核对数据、作决定、亲自完成工作；每一步都有证据和下一位责任人。</p>
      </div>
      <div className="exec-toolbar">
        <label>
          工作状态
          <select value={group} onChange={(event) => setGroup(event.target.value as Group | 'all')}>
            <option value="all">在办事项（分组）</option>
            {GROUPS.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </label>
        <label>
          项目
          <select aria-label="项目筛选" value={project} onChange={(event) => setProject(event.target.value)}>
            <option value="">全部项目</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="exec-check">
          <input type="checkbox" checked={exceptionsOnly} onChange={(event) => setExceptionsOnly(event.target.checked)} />
          只看例外
        </label>
        <p>当前身份只能看到分给自己的事项。名单由服务端按角色过滤。</p>
      </div>
      <div className="exec-grid">
        <div className="panel exec-pane">
          <div className="exec-scroll">
            {failed ? <p className="helper" role="alert">没能读取待办，请稍后重试。</p> : null}
            {items === null && !failed ? <p className="helper">正在读取…</p> : null}
            {items !== null && visible.length === 0 ? <p className="helper">没有分给你的事项。</p> : null}
            {GROUPS.map((section) => {
              const rows = visible.filter((item) => groupOf(item) === section.id);
              if (rows.length === 0) return null;
              return (
                <section key={section.id} aria-label={section.label}>
                  <h2 className="exec-group">{section.label}</h2>
                  {rows.map((item) => (
                    <button key={item.id} type="button" className="exec-task" data-item={item.id} onClick={() => { setOpenId(item.id); setMsg(''); }} aria-current={item.id === openId ? 'true' : undefined}>
                      <strong>{String(item.payload.title ?? KIND_LABEL[item.kind] ?? item.kind)}</strong>
                      <span>
                        {KIND_LABEL[item.kind] ?? item.kind} · {RENDERER_LABEL[item.renderer] ?? item.renderer} · 截止 {typeof item.payload.due === 'string' ? item.payload.due : '未设截止'}
                        {item.waitingOn ? ` · 等待 ${item.waitingOn}` : ''}
                        {item.projectId ? ` · ${item.projectId}` : ''}
                      </span>
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        </div>
        {open ? open.longwork ? <LongDrawer item={open} msg={msg} post={post} /> : <Drawer item={open} msg={msg} post={post} /> : null}
      </div>
    </section>
  );
}

type LongPost = (path: string, body: unknown, done?: (data: Record<string, unknown>) => string) => Promise<void>;
function LongDrawer({ item, msg, post }: { item: ServerWorkItem; msg: string; post: LongPost }) {
  const [candidate, setCandidate] = useState('');
  useEffect(() => setCandidate(''), [item.id]);
  const candidates = Array.isArray(item.payload.candidates) ? item.payload.candidates as Array<{ id: string; object?: string; person?: string; thread?: string }> : [];
  const sop = item.payload.sopStart as { reason?: string; versionId?: string; instanceId?: string } | undefined;
  if (item.longwork?.type === 'batch') return <LongBatchDrawer item={item} msg={msg} post={post} />;
  if (item.longwork?.type === 'collection' || item.longwork?.type === 'collection-response') return <CollectionDrawer item={item} msg={msg} post={post} />;
  return <aside className="panel exec-drawer" aria-label="工作项">
    <div className="exec-pane-head"><h2>{String(item.payload.title)}</h2><span>{KIND_LABEL[item.kind]}</span></div>
    <p data-status={item.status}>状态：{STATUS_LABEL[item.status] ?? item.status}</p>
    <p>{String(item.payload.why ?? item.payload.reason ?? '')}</p>
    {sop?.reason ? <p role="note">流程状态：{sop.reason}{sop.versionId ? ` 版本 ${sop.versionId}` : ''}{sop.instanceId ? ` · 实例 ${sop.instanceId}` : ''}</p> : null}
    {item.payload.original !== undefined ? <div><h3>原始来件（仅作数据）</h3><p>{text(item.payload.original)}</p></div> : null}
    <dl className="exec-fields" aria-label="原事项证据">
      {fieldsOf(item.payload).filter(([key]) => !['candidates', 'resolvedTo'].includes(key)).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
    </dl>
    {!item.canAct ? <p className="helper">{item.status === 'closed' ? '事项已关闭，保留原始证据和处理记录。' : '这不是分给你的事项，只能查看。'}</p> : null}
    {item.longwork?.type === 'match' ? <>
      {item.payload.resolvedTo ? <p>{item.payload.resolutionKind === 'new' ? '已另立新事项：' : '已并回原事项：'}{String(item.payload.resolvedTo)}。来件只作数据，没有执行外部动作。</p> : null}
      {item.canAct ? <fieldset aria-label="选择原事项">
        {candidates.map(c => <label key={c.id}><input type="radio" name="long-match" checked={candidate === c.id} onChange={() => setCandidate(c.id)} />{c.id} · {c.object} · {c.person} · {c.thread}</label>)}
        <button type="button" disabled={!candidate} onClick={() => void post('resolve', { itemId: candidate }, () => '来件已并回所选原事项；没有执行外部动作。')}>确认并回原事项</button>
        <button type="button" onClick={() => void post('new-item', {}, () => '来件已登记为独立新事项；原候选未改变，没有执行外部动作。')}>另立新事项</button>
      </fieldset> : null}
    </> : item.canAct ? <button type="button" onClick={() => void post('close', {}, () => '原事项已关闭；没有执行或重复外部调用。')}>关闭原事项</button> : null}
    <p>来件、人工判断和阶段记录都不等于系统已核验外部结果。</p>
    {msg ? <p role="status" aria-label="处理结果">{msg}</p> : null}
  </aside>;
}

interface LongRow { id: string; hash: string; clean: boolean; selected: boolean; state: string; data: Record<string, unknown>; evidence?: string; approvedBy?: string }
const LONG_STATE: Record<string, string> = { pending: '待批准', approved: '已批准，未提交', executing: '提交中，等待核对', succeeded: '已回读核验', failed: '失败或已取消，不会重发', unknown: '结果未知，只能回读' };
function LongBatchDrawer({ item, msg, post }: { item: ServerWorkItem; msg: string; post: LongPost }) {
  const [busy, setBusy] = useState(false);
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  useEffect(() => setOptimistic(null), [item.id]);
  const rows = (item.payload.actionRows ?? []) as LongRow[];
  const selected = rows.filter(r => r.selected && r.clean && ['pending', 'approved'].includes(r.state));
  const act = item.canAct === true && item.status !== 'closed';
  async function action(path: string, body: unknown, done?: (data: Record<string, unknown>) => string) {
    setBusy(true); try { await post(path, body, done); } finally { setBusy(false); }
  }
  async function choose(next: string[]) {
    setOptimistic(next); try { await action('selection', { selected: next }); } finally { setOptimistic(null); }
  }
  const result = (d: Record<string, unknown>) => {
    const results = (d.results ?? []) as Array<{ error?: string }>;
    return results.some(r => r.error) ? '部分行被阻止，请核对逐行状态；成功行不会重复。' : `已处理 ${results.length} 行；请核对逐行回读结果，成功行不会重复。`;
  };
  return <aside className="panel exec-drawer" aria-label="工作项" aria-busy={busy}>
    <div className="exec-pane-head exec-long-head"><h2>{String(item.payload.title)}</h2><span>逐行动作批准</span></div>
    <p>{String(item.payload.why)}</p>
    {!item.canAct ? <p className="helper">这不是分给你的事项，只能查看。</p> : null}
    <table className="exec-long-table" aria-label="持久批量明细"><thead><tr><th>行</th><th>选择</th><th>内容与状态</th></tr></thead><tbody>
      {rows.map(r => <tr key={r.id} data-long-row={r.id}>
        <td>{r.id}</td><td><label className="exec-long-select"><input type="checkbox" aria-label={`选择行 ${r.id}`} checked={optimistic && ['pending', 'approved'].includes(r.state) ? optimistic.includes(r.id) : r.selected} disabled={!act || busy || !r.clean || !['pending', 'approved'].includes(r.state)}
          onChange={e => void choose(e.target.checked ? [...new Set([...selected.map(x => x.id), r.id])] : selected.filter(x => x.id !== r.id).map(x => x.id))} /></label></td>
        <td><p>{!r.clean ? '冲突行，不能选择' : LONG_STATE[r.state] ?? r.state}</p><p>{text(r.data)}</p>
          {r.approvedBy ? <p>批准人：{r.approvedBy}</p> : null}{r.evidence ? <p>结果凭证：{r.evidence}</p> : null}</td>
      </tr>)}
    </tbody></table>
    {act ? <div className="stack exec-long-actions">
      <button className="exec-action" type="button" disabled={busy || !selected.length} onClick={() => void action('approve', { selected: selected.map(r => ({ id: r.id, hash: r.hash })) }, () => '只批准所选行的当前内容，尚未执行。')}>批准所选行</button>
      <button className="exec-action" type="button" disabled={busy || !rows.some(r => r.selected && r.state === 'approved')} onClick={() => void action('run-selected', {}, result)}>执行已批准的所选行</button>
      <button className="exec-action" type="button" disabled={busy || !rows.some(r => ['unknown', 'executing'].includes(r.state))} onClick={() => void action('readback', {}, result)}>只回读未知结果</button>
    </div> : null}
    <p>失败或取消的行不会重发；修订需要新的批次和批准。未配置连接器时不提交任何外部动作。</p>
    {msg ? <p role="status" aria-label="处理结果">{msg}</p> : null}
  </aside>;
}

function CollectionDrawer({ item, msg, post }: { item: ServerWorkItem; msg: string; post: LongPost }) {
  const [reply, setReply] = useState(String(item.payload.myResponse ?? ''));
  useEffect(() => setReply(String(item.payload.myResponse ?? '')), [item.id, item.payload.myResponse]);
  const personal = item.longwork?.type === 'collection-response';
  const responses = (item.payload.responses ?? {}) as Record<string, string>;
  return <aside className="panel exec-drawer" aria-label="工作项">
    <div className="exec-pane-head"><h2>{String(item.payload.title)}</h2><span>{personal ? '我的回复' : '收集汇总'}</span></div>
    <p>截止：{String(item.payload.due)} · {item.payload.collectionState === 'summarized' ? '已截止，汇总固定' : '收集中'}</p>
    <p>{String(item.payload.why)}</p>
    {personal ? <>
      {item.payload.myResponse ? <p>我的已存回复（人工回报，未经系统核验）：{String(item.payload.myResponse)}</p> : <p>尚未回复。</p>}
      {item.canAct ? <form className="stack exec-long-form" aria-label="我的收集回复" onSubmit={e => { e.preventDefault(); void post('reply', { evidence: reply }, () => '你的回复已保存；仍是人工回报，未经系统核验。'); }}>
        <label className="field"><span>我的回复凭证</span><textarea aria-label="我的回复凭证" value={reply} onChange={e => setReply(e.target.value)} /></label>
        <button className="exec-action" type="submit" disabled={!reply.trim()}>保存我的回复</button>
      </form> : <p>截止后不能再改回复。</p>}
    </> : <>
      <p>已回读核验的请求发送：{String(item.payload.verifiedSends)} / {String(item.payload.requestCount)}。仅创建收集不代表请求已发送。</p>
      <p>{item.payload.collectionState === 'summarized' ? '截止时未回复' : '尚未回复'}：{((item.payload.missing ?? []) as string[]).join('、') || '无'}</p>
      <h3>收到的人工回复（未经系统核验）</h3><dl>{Object.entries(responses).map(([person, evidence]) => <div key={person}><dt>{person}</dt><dd>{evidence}</dd></div>)}</dl>
    </>}
    {msg ? <p role="status" aria-label="处理结果">{msg}</p> : null}
  </aside>;
}

function Drawer({ item, msg, post }: { item: ServerWorkItem; msg: string; post: (path: string, body: unknown, done?: (data: Record<string, unknown>) => string) => Promise<void> }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState('');
  const [note, setNote] = useState('');
  const [choice, setChoice] = useState('');
  useEffect(() => { setEdits({}); setEvidence(''); setNote(''); setChoice(''); }, [item.id]);

  const fields = fieldsOf(item.payload);
  const unknown = item.actionStatus === 'outcome_unknown';
  const current = !!item.decision && item.decision.payloadHash === item.payloadHash;
  const act = item.canAct === true;
  const editable = act && (item.kind === 'data_check' || item.kind === 'action_approval') && item.renderer === 'field_diff' && !unknown;
  const decidable = act && canDecide({ fromServer: true, actionStatus: item.actionStatus }) && !item.decision && !item.draft && !['manual_execution', 'branch_choice', 'supply_info'].includes(item.kind);
  const options = Array.isArray(item.payload.options) ? (item.payload.options as unknown[]).map(String) : [];
  const attachments = Array.isArray(item.payload.attachments) ? (item.payload.attachments as Array<{ name?: string; id?: string }>) : [];
  /** Numbers typed as numbers stay numbers (amounts); everything else is text. */
  const parsed = (raw: string) => (/^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw);
  const patch = () => Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, parsed(v)]));

  function saveDraft(e: FormEvent) {
    e.preventDefault();
    void post('stage', { patch: patch() }, () => '修改已暂存，还没保存成新版本。');
  }

  return (
    <aside className="panel exec-drawer" aria-label="工作项">
      <div className="exec-pane-head">
        <h2>{RENDERER_LABEL[item.renderer] ?? item.renderer}</h2>
        <span>{KIND_LABEL[item.kind] ?? item.kind}</span>
      </div>
      <p data-status={item.status}>状态：{STATUS_LABEL[item.status] ?? item.status} · 版本 {item.payloadVersion}</p>
      {typeof item.payload.why === 'string' ? <p>{item.payload.why}</p> : null}
      {!act ? <p className="helper">这不是分给你的事项，只能查看。</p> : null}

      {item.renderer === 'document_preview' ? (
        <dl aria-label="邮件预览">
          {item.payload.to ? <div><dt>收件人</dt><dd>{text(item.payload.to)}</dd></div> : null}
          {attachments.length ? <div><dt>附件</dt><dd><ul>{attachments.map((a, i) => <li key={i}>{a.name ?? '未命名'}（{a.id ?? '无编号'}）</li>)}</ul></dd></div> : null}
          {item.payload.original ? <div><dt>原始来件</dt><dd>{text(item.payload.original)}</dd></div> : null}
          {item.payload.changes ? <div><dt>AI 改动的字段</dt><dd>{text(item.payload.changes)}</dd></div> : null}
        </dl>
      ) : null}

      {fields.length ? (
        <dl className="exec-fields" aria-label="决定的内容">
          {fields.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}
        </dl>
      ) : null}

      {item.draft ? <p role="note">有未保存的修改（{text(item.draft)}），旧的批准不能执行。保存修订后要按新版本重新决定。</p> : null}
      {editable ? (
        <form className="stack" aria-label="修改数据" onSubmit={saveDraft}>
          {fields.map(([key, value]) => (
            <label key={key} className="field"><span>{key}</span>
              <input aria-label={`修改 ${key}`} defaultValue={value} onChange={(e) => setEdits((cur) => ({ ...cur, [key]: e.target.value }))} />
            </label>
          ))}
          <div className="exec-composer-actions">
            <button type="submit" disabled={!Object.keys(edits).length}>暂存修改</button>
            <button type="button" disabled={!Object.keys(edits).length && !item.draft} onClick={() => void post('revise', { patch: { ...(item.draft ?? {}), ...patch() } }, (d) => `已保存为版本 ${String(d.payloadVersion)}，原来的批准已失效。`)}>保存修订</button>
          </div>
        </form>
      ) : null}

      {item.rows?.length ? (
        <table aria-label="批量明细">
          <thead><tr><th>行</th><th>勾选</th><th>状态</th></tr></thead>
          <tbody>
            {item.rows.map((row) => (
              <tr key={row.id} data-row={row.id}>
                <td>{row.projectId ? `${row.projectId} · ` : ''}{row.id}</td>
                <td><input type="checkbox" aria-label={`勾选 ${row.id}`} checked={row.selected} disabled={!act || !row.clean || row.executed} onChange={(e) => void post(`rows/${row.id}`, { selected: e.target.checked })} /></td>
                <td>{row.executed ? '已执行' : !row.clean ? '冲突行，不能选，留在例外里' : row.selected ? '已勾选' : '未勾选'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {item.rows?.length && act ? (
        <button type="button" disabled={!current || unknown} onClick={() => void post('execute-batch', {}, (d) => `已执行 ${((d.rows as BatchRow[]) ?? []).filter((r) => r.executed).length} 行；冲突行没有执行。`)}>执行勾选的干净行</button>
      ) : null}

      {decidable ? <button type="button" onClick={() => void post('decide', { expectedVersion: item.payloadVersion }, (d) => (d.ok ? '已决定。' : decisionWhy(String(d.reason ?? ''), '没有决定成功。')))}>按版本 {item.payloadVersion} 决定</button> : null}
      {unknown ? <p>结果未知，不能再次提交。</p> : null}
      {item.decision ? (
        <p data-decision>
          已由 {item.decision.by} 决定{current ? '' : '（针对旧版本，已失效）'}。
          {item.kind === 'deliverable_review' ? '复核只决定是否接受成果，不授予任何执行权限。' : item.kind !== 'action_approval' ? '这是决定，不是执行授权。' : ''}
        </p>
      ) : null}

      {item.kind === 'branch_choice' ? (
        <div className="stack">
          {typeof item.payload.branch === 'string' ? <p data-branch>已记录的路径：{item.payload.branch}（由 {item.decision?.by ?? '—'} 记录）。记录路径不等于外部审批已通过。</p> : null}
          {act && item.status !== 'decided' ? (
            <fieldset aria-label="选择路径">
              {options.map((o) => <label key={o}><input type="radio" name={`branch-${item.id}`} value={o} checked={choice === o} onChange={() => setChoice(o)} /> {o}</label>)}
              <button type="button" disabled={!choice} onClick={() => void post('branch', { choice }, () => '已记录选择。')}>记录选择</button>
            </fieldset>
          ) : null}
          {act && item.status === 'decided' ? <button type="button" onClick={() => void post('reopen', {}, () => '已重新打开，原来的选择仍保留。')}>重新打开</button> : null}
        </div>
      ) : null}

      {act && (item.kind === 'manual_execution' || item.waitingOn) ? (
        <form className="stack" aria-label="人工回填" onSubmit={(e) => { e.preventDefault(); void post('evidence', { reference: evidence }, () => '已记录人工回填。'); }}>
          <label className="field"><span>回填凭证（外部系统单号或文件编号，必填）</span>
            <input aria-label="回填凭证" value={evidence} onChange={(e) => setEvidence(e.target.value)} />
          </label>
          <button type="submit" disabled={!evidence.trim()}>提交人工回填</button>
        </form>
      ) : null}
      {item.evidenceSource === 'human_report' ? <p data-evidence>人工回报，未经系统核验：{text(item.payload.humanReference)}</p> : null}

      {item.kind === 'exception_ruling' ? (
        <div className="stack">
          {item.payload.reason ? <p>例外原因：{text(item.payload.reason)}</p> : null}
          {item.payload.intended !== undefined ? <p>批准的值：<code>{text(item.payload.intended)}</code></p> : null}
          {item.payload.readback !== undefined ? <p>系统回读：<code>{text(item.payload.readback)}</code></p> : null}
          {typeof item.payload.note === 'string' ? <p data-note>备注：{item.payload.note}（备注不会改变系统结果）</p> : null}
          {act ? (
            <form className="stack" aria-label="例外备注" onSubmit={(e) => { e.preventDefault(); void post('note', { note }, () => '备注已记录；系统结果不变。'); }}>
              <label className="field"><span>备注</span><input aria-label="备注" value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <button type="submit" disabled={!note.trim()}>记录备注</button>
            </form>
          ) : null}
        </div>
      ) : null}

      {msg ? <p role="status" aria-label="处理结果">{msg}</p> : null}
      <dl>
        <div><dt>截止</dt><dd>{typeof item.payload.due === 'string' ? item.payload.due : '未设截止'}</dd></div>
        {item.waitingOn ? <div><dt>等待</dt><dd>{item.waitingOn}（仍挂在原事项上）</dd></div> : null}
        <div><dt>完成之后</dt><dd>批准只改变决定，执行前会重新鉴权并回读。</dd></div>
      </dl>
    </aside>
  );
}
