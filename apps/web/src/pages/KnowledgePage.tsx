import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import './KnowledgePage.css';
import { DatabaseSourcePanel } from './DatabaseSourcePanel';

interface Evidence { sourceId: string; version: string; start: number; end: number; locator: string; quote: string }
interface Plugin { id: string; name: string; installed: boolean; builtIn: boolean; enabled: boolean; configured: boolean; capabilities: string[] }
interface SourceScope { resourceId?: string; mailbox?: string; folder?: string; receivedSince?: string; driveId?: string; folderPath?: string; projectIds?: string[] }
interface SourceResource { id: string; name: string; pluginId: string; scope: SourceScope; projectIds: string[] }
interface Connection { id: string; name: string; pluginId: string; status: string; scope?: SourceScope }
interface ConnectionPreview { connectionId: string; name: string; pluginId: string; status: string; scope: SourceScope; items: { id: string; title: string; version: string; locator: string; selected: boolean }[]; blocked: number }
interface Item { id: string; title: string; version: string; status: string; confirmed: boolean; locator: string }
interface Recommendation {
  id: string; kind: string; name: string; description: string; humanLocked: boolean; deleted: boolean; stale?: boolean;
  proposedChange?: { name: string; description: string; evidence?: Evidence[] }; evidence: Evidence[];
  relation?: { from:string;to:string;label:string };
  origin?: 'manual' | 'inferred';
}
interface Overview {
  spaceName: string; sourceResources: SourceResource[];
  plugins: Plugin[]; connections: Connection[]; items: Item[];
  analyses: { id: string; status: string; stage: string }[]; recommendations: Recommendation[];
  canConfirm: boolean;
  parseJobs: { id: string; name: string; status: string; error: string | null }[];
  databaseResources?: { id: string; name: string; tables: Record<string, { columns: string[]; sensitive?: string[] }>; maxRows: number }[];
}
interface SearchResult { answer: string; hits: Evidence[] }
const ROOT = '/api/v1/knowledge';
const labels: Record<string, string> = {
  draft: '待确认', ready: '已确认连接', confirmed: '已确认', pending: '待确认版本',
  needs_auth: '需要重新授权', needs_reauth: '需要重新授权', sync_failed: '同步失败', rescan_required: '需要重新扫描',
  paused: '已暂停', revoked: '权限已撤销', deleted: '已删除', parse_failed: '解析失败', parsed: '已解析 · 待确认',
  queued: '排队中', running: '进行中', completed: '已完成', failed: '失败', stale: '依据已变化',
  parse: '解析', extract: '提取', recommend: '生成建议', complete: '完成',
  employee: '员工', tool: '工具', sop: 'SOP', object: '业务对象', relation:'对象关系',
  outcome_unknown: '结果未知 · 需人工核对',
};
const label = (value: string) => labels[value] ?? value;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '请求失败，请稍后重试。';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await api<T & { message?: string; error?: string }>(ROOT + path, init);
  if (response.status < 200 || response.status >= 300 || response.body.error) {
    throw new Error(response.body.message ?? response.body.error ?? `请求失败（HTTP ${response.status}）`);
  }
  return response.body;
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  return evidence.length ? <ol className="knowledge-evidence">
    {evidence.map((entry, index) => <li key={`${entry.sourceId}:${entry.version}:${entry.start}:${index}`}>
      <blockquote>{entry.quote}</blockquote>
      <p>{entry.locator} <span>· 版本 {entry.version} · 字符 {entry.start}–{entry.end}</span></p>
      <small>来源 {entry.sourceId}</small>
    </li>)}
  </ol> : <p className="knowledge-empty">没有可定位依据，不能据此生成或采纳建议。</p>;
}
function ScopeSummary({ scope, projectIds }: { scope: SourceScope; projectIds?: string[] }) {
  const projects = projectIds ?? scope.projectIds;
  return <dl className="knowledge-scope">
    {scope.mailbox ? <div><dt>邮箱</dt><dd>{scope.mailbox}</dd></div> : null}
    {scope.folder ? <div><dt>邮件文件夹</dt><dd>{scope.folder}</dd></div> : null}
    {scope.receivedSince ? <div><dt>邮件起始日期</dt><dd>{scope.receivedSince}</dd></div> : null}
    {scope.driveId ? <div><dt>文档库</dt><dd>{scope.driveId}</dd></div> : null}
    {scope.folderPath ? <div><dt>文件夹路径</dt><dd>{scope.folderPath}</dd></div> : null}
    {scope.resourceId ? <div><dt>授权资源引用</dt><dd>{scope.resourceId}</dd></div> : null}
    {projects ? <div><dt>授权项目范围</dt><dd>{projects.join('、') || '无项目授权'}</dd></div> : null}
  </dl>;
}

function RemoteSourcePreview({ connection, resource, active, disabled, onAction }: {
  connection: Connection; resource?: SourceResource; active: boolean; disabled: boolean;
  onAction: (key: string, path: string, body: unknown, success: string) => Promise<boolean>;
}) {
  const [preview, setPreview] = useState<ConnectionPreview | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const sequence = useRef(0);
  const scopeKey = JSON.stringify({ scope: resource?.scope, projects: resource?.projectIds, connectionScope: connection.scope });
  useEffect(() => { sequence.current++; setPreview(null); setSelectedIds([]); setError(''); setReading(false); return () => { sequence.current++; }; }, [connection.id, connection.status, active, scopeKey]);
  async function read() {
    if (!active || disabled) return;
    const current = ++sequence.current;
    setReading(true); setError(''); setPreview(null); setSelectedIds([]);
    try {
      const value = await request<ConnectionPreview>(`/connections/${encodeURIComponent(connection.id)}/preview`);
      if (current === sequence.current) setPreview(value);
    } catch (caught) { if (current === sequence.current) setError(errorMessage(caught)); }
    finally { if (current === sequence.current) setReading(false); }
  }
  async function importSelected() {
    if (!active || disabled || !selectedIds.length || connection.status !== 'confirmed') return;
    const ids = [...selectedIds];
    if (await onAction(`import:${connection.id}`, `/connections/${encodeURIComponent(connection.id)}/import`, { ids }, '所选资料已导入，仍需逐版本核对并确认。')) { setPreview(null); setSelectedIds([]); }
  }
  return <div className="knowledge-remote-source">
    <ScopeSummary scope={{ ...resource?.scope, ...connection.scope }} projectIds={resource?.projectIds} />
    <div className="knowledge-actions">
      <button className="btn" type="button" disabled={disabled || !active || reading} onClick={() => void read()}>{reading ? '读取范围预览中…' : '预览来源范围与资料'}</button>
      {connection.status === 'confirmed' ? <button className="btn" type="button" disabled={disabled || !active} onClick={() => void onAction(`sync:${connection.id}`, `/connections/${encodeURIComponent(connection.id)}/sync`, {}, '来源同步已完成，新资料仍需逐版本确认。')}>同步来源</button> : null}
    </div>
    {error ? <p className="knowledge-alert" role="alert">{error}</p> : null}
    {preview ? <section className="knowledge-preview" aria-label={`${connection.name} 来源元数据预览`}>
      <h3>来源元数据预览</h3><ScopeSummary scope={{ ...resource?.scope, ...preview.scope }} projectIds={resource?.projectIds} />
      <p className="helper">预览仅显示允许范围内的标题、版本和定位，不代表正文已获人工确认。导入前服务端会重新核对权限。</p>
      <p className="helper">权限受限资料：{preview.blocked} 份，仅显示数量，不能选择。</p>
      {preview.items.length ? <ul className="knowledge-preview-items">{preview.items.map(item => <li key={item.id}>
        <label className="knowledge-check"><input type="checkbox" disabled={disabled || !active || connection.status !== 'confirmed'} checked={selectedIds.includes(item.id)} onChange={event => setSelectedIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /><span>{item.title}<small>版本 {item.version} · {item.locator}</small></span></label>
      </li>)}</ul> : <p className="knowledge-empty">当前范围没有可导入资料。</p>}
      <button className="btn" type="button" disabled={disabled || !active || connection.status !== 'confirmed' || !selectedIds.length} onClick={() => void importSelected()}>导入所选资料（{selectedIds.length}）</button>
      {connection.status !== 'confirmed' ? <p className="helper">请先独立确认连接，再选择资料导入。</p> : null}
      <button className="btn" type="button" onClick={() => { setPreview(null); setSelectedIds([]); }}>关闭来源预览</button>
    </section> : null}
  </div>;
}
function ItemPreview({ item }: { item: Item }) {
  const [preview, setPreview] = useState<{ chunks: { text: string; locator: string }[]; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function read() {
    setLoading(true); setError('');
    try { setPreview(await request(`/items/${encodeURIComponent(item.id)}/preview?version=${encodeURIComponent(item.version)}`)); }
    catch (caught) { setPreview(null); setError(errorMessage(caught)); } finally { setLoading(false); }
  }
  return <details className="knowledge-item-preview"><summary onClick={() => { if (!preview && !loading) void read(); }}>查看当前版本原文与定位</summary>
    {loading ? <p role="status">正在核对源权限并读取…</p> : null}
    {error ? <p className="knowledge-alert" role="alert">{error}</p> : null}
    {preview ? <>{preview.chunks.map((c, n) => <div key={n}><small>{c.locator}</small><blockquote>{c.text}</blockquote></div>)}{preview.truncated ? <p className="helper">预览达到 200,000 字符上限，请同时核对原始文件。</p> : null}</> : null}
  </details>;
}

function RecommendationCard({ recommendation: r, disabled, onAction }: {
  recommendation: Recommendation; disabled: boolean;
  onAction: (key: string, path: string, body: unknown, success: string) => Promise<boolean>;
}) {
  const [name, setName] = useState(r.name);
  const [description, setDescription] = useState(r.description);
  useEffect(() => { setName(r.name); setDescription(r.description); }, [r.name, r.description]);
  async function save(event: FormEvent) {
    event.preventDefault();
    await onAction(`lock:${r.id}`, `/recommendations/${encodeURIComponent(r.id)}/lock`, { name: name.trim(), description: description.trim() }, '草案已保存并由人工锁定。');
  }
  return <article className="knowledge-recommendation">
    <div className="knowledge-row">
      <span className="knowledge-kind">{label(r.kind)}草案</span>
      <span className={`knowledge-badge ${r.humanLocked ? 'is-gold' : ''}`}>{r.humanLocked ? '人工锁定' : '建议 · 待核对'}</span>
    </div>
    <p className="helper">{r.origin === 'manual' ? '人工补充 · 不是文档推断' : '文档推断 · 需核对来源依据'}</p>
    {r.stale ? <p className="knowledge-alert">依据版本已变化，旧引用已撤回。人工内容保留，请核对新建议后决定是否采纳。</p> : null}
    {r.relation?<p className="helper">{r.relation.from} → {r.relation.to} · {r.relation.label}</p>:null}
    <form onSubmit={save} className="knowledge-form">
      <label className="field"><span>名称</span><input required maxLength={160} value={name} onChange={event => setName(event.target.value)} /></label>
      <label className="field"><span>说明</span><textarea required maxLength={4000} rows={3} value={description} onChange={event => setDescription(event.target.value)} /></label>
      <div className="knowledge-actions">
        <button className="btn" disabled={disabled || !name.trim() || !description.trim() || (r.origin !== 'manual' && !r.evidence.length)}>保存并人工锁定</button>
        <button className="btn knowledge-danger" type="button" disabled={disabled} onClick={() => void onAction(`delete:${r.id}`, `/recommendations/${encodeURIComponent(r.id)}/delete`, {}, '草案已删除，后续分析不会自动恢复。')}>删除草案</button>
      </div>
    </form>
    {r.proposedChange ? <div className="knowledge-proposal">
      <strong>分析提出了修改，尚未覆盖人工内容</strong>
      <p>{r.proposedChange.name}</p><p>{r.proposedChange.description}</p>
      {r.proposedChange.evidence ? <EvidenceList evidence={r.proposedChange.evidence} /> : null}
      <button className="btn" type="button" disabled={disabled} onClick={() => void onAction(`adopt:${r.id}`, `/recommendations/${encodeURIComponent(r.id)}/adopt`, {}, '修改已由人工采纳并锁定。')}>核对后采纳这次修改</button>
    </div> : null}
    {r.origin === 'manual' ? <p className="helper">此角色由人工录入，没有文档推断依据。</p> : <details><summary>查看依据 · {r.evidence.length} 处</summary><EvidenceList evidence={r.evidence} /></details>}
  </article>;
}

export function KnowledgePage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [pluginId, setPluginId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [readOnlyAcknowledged, setReadOnlyAcknowledged] = useState(false);
  const [spaceName, setSpaceName] = useState('');
  const [manualRoleName, setManualRoleName] = useState('');
  const [manualRoleDescription, setManualRoleDescription] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadText, setUploadText] = useState('');
  const [readingFile, setReadingFile] = useState(false);
  const [binaryFile, setBinaryFile] = useState<File | null>(null);
  const [readingBinary, setReadingBinary] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null);
  const refreshSequence = useRef(0);
  const actionInFlight = useRef(false);
  const searchSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    setLoading(true);
    try {
      const value = await request<Overview>('/overview');
      if (sequence === refreshSequence.current) { setOverview(value); setError(''); }
    } catch (caught) {
      if (sequence === refreshSequence.current) setError(errorMessage(caught));
    } finally { if (sequence === refreshSequence.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(); return () => { refreshSequence.current++; searchSequence.current++; }; }, [load]);
  useEffect(() => { setSpaceName(overview?.spaceName ?? ''); }, [overview?.spaceName]);
  const analysisActive = overview?.analyses.some(run => run.status === 'queued' || run.status === 'running') ?? false;
  const parseActive = overview?.parseJobs.some(job => job.status === 'queued' || job.status === 'running') ?? false;
  useEffect(() => {
    if (!analysisActive && !parseActive) return;
    const interval = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(interval);
  }, [analysisActive, parseActive, load]);

  const plugins = overview?.plugins.filter(plugin => plugin.installed && plugin.enabled && plugin.configured && ['local-file', 'email', 'sharepoint'].includes(plugin.id)) ?? [];
  const selectedPlugin = plugins.find(plugin => plugin.id === pluginId)?.id ?? plugins[0]?.id ?? '';
  const sourceResources = overview?.sourceResources?.filter(resource => resource.pluginId === selectedPlugin) ?? [];
  const selectedResource = sourceResources.find(resource => resource.id === resourceId) ?? sourceResources[0];
  const remotePlugin = selectedPlugin === 'email' || selectedPlugin === 'sharepoint';
  const databasePlugin = overview?.plugins.find(plugin => plugin.id === 'database');
  const databaseEnabled = !!databasePlugin?.installed && databasePlugin.enabled && databasePlugin.configured;
  const uploadConnections = overview?.connections.filter(connection => connection.status === 'confirmed' && connection.pluginId === 'local-file' && plugins.some(plugin => plugin.id === connection.pluginId)) ?? [];
  const selectedConnection = uploadConnections.find(connection => connection.id === connectionId)?.id ?? uploadConnections[0]?.id ?? '';
  const confirmedCount = overview?.items.filter(item => item.confirmed).length ?? 0;
  const recommendations = overview?.recommendations.filter(recommendation => !recommendation.deleted) ?? [];
  const selectedResourceScope = JSON.stringify({ scope: selectedResource?.scope, projects: selectedResource?.projectIds });
  useEffect(() => { setReadOnlyAcknowledged(false); }, [selectedPlugin, selectedResource?.id, selectedResourceScope]);

  async function action(key: string, path: string, body: unknown, success: string, method = 'POST'): Promise<boolean> {
    if (actionInFlight.current) return false;
    actionInFlight.current = true;
    setBusy(key); setNotice(''); setError('');
    try {
      await request(path, { method, body: JSON.stringify(body) });
      setNotice(success);
      // Previously returned evidence may no longer have permission or version validity.
      searchSequence.current++; setSearchResult(null); setSearchError(''); setSearching(false);
      await load();
      return true;
    } catch (caught) { setError(errorMessage(caught)); return false; }
    finally { actionInFlight.current = false; setBusy(''); }
  }

  async function createConnection(event: FormEvent) {
    event.preventDefault();
    if (!selectedPlugin || (remotePlugin && (!selectedResource || !readOnlyAcknowledged))) return;
    if (await action('connection', '/connections', { name: connectionName.trim(), pluginId: selectedPlugin, scope: remotePlugin ? { resourceId: selectedResource!.id } : {}, ...(remotePlugin ? { readOnlyAcknowledged: true } : {}) }, '连接草案已创建，请核对范围后确认。')) { setConnectionName(''); setReadOnlyAcknowledged(false); }
  }
  async function renameSpace(event: FormEvent) {
    event.preventDefault();
    await action('space', '/space', { name: spaceName.trim() }, '知识空间名称已保存，仅更新名称元数据。', 'PUT');
  }
  async function addManualRole(event: FormEvent) {
    event.preventDefault();
    if (await action('manual-role', '/manual-roles', { name: manualRoleName.trim(), description: manualRoleDescription.trim() }, '人工角色已补充，不会据此自动启用资料分析。')) { setManualRoleName(''); setManualRoleDescription(''); }
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (await action('upload', '/uploads', { connectionId: selectedConnection, name: uploadName.trim(), text: uploadText }, '资料已提交。解析完成后仍需确认当前版本。')) { setUploadName(''); setUploadText(''); }
  }
  async function readFile(file: File | undefined) {
    if (!file) return;
    setError('');
    if (!/\.(txt|md|csv|markdown)$/i.test(file.name)) { setError('文本入口支持 .txt / .md / .csv / .markdown。PDF 和 Office 文件请使用下方文档解析入口。'); return; }
    if (file.size > 2_000_000) { setError('文本文件不能超过 2 MB。'); return; }
    setReadingFile(true);
    try { const text = await file.text(); if (text.length > 200_000) { setError('文本内容不能超过 200,000 字符。'); return; } setUploadText(text); setUploadName(file.name); }
    catch { setError('无法读取文件，请重试。'); }
    finally { setReadingFile(false); }
  }
  function chooseBinary(file: File | undefined) {
    setBinaryFile(null); setError('');
    if (!file) return;
    if (!/\.(pdf|png|jpe?g|tiff|docx|xlsx|pptx)$/i.test(file.name)) { setError('文档解析仅支持 PDF、PNG、JPG、JPEG、TIFF、DOCX、XLSX、PPTX。'); return; }
    if (file.size === 0 || file.size > 20 * 1024 * 1024) { setError('文档不能为空，且不能超过 20 MiB。'); return; }
    setBinaryFile(file);
  }
  async function uploadBinary(event: FormEvent) {
    event.preventDefault();
    if (!binaryFile || !selectedConnection || readingBinary || actionInFlight.current) return;
    setReadingBinary(true); setError(''); setNotice('');
    try {
      const file = binaryFile;
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result !== 'string' || !reader.result.includes(',')) reject(new Error('无法读取文档文件。'));
          else resolve(reader.result.slice(reader.result.indexOf(',') + 1));
        };
        reader.onerror = () => reject(new Error('无法读取文档文件。'));
        reader.onabort = () => reject(new Error('文档读取已取消。'));
        reader.readAsDataURL(file);
      });
      if (await action('binary', '/files', { connectionId: selectedConnection, name: file.name, base64 }, '文档已加入解析队列。解析完成后仍需核对并确认资料版本。')) setBinaryFile(null);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setReadingBinary(false); }
  }
  async function search(event: FormEvent) {
    event.preventDefault();
    const sequence = ++searchSequence.current;
    setSearching(true); setSearchError(''); setSearchResult(null);
    try {
      const result = await request<SearchResult>(`/search?q=${encodeURIComponent(query.trim())}`);
      if (sequence === searchSequence.current) setSearchResult(result);
    } catch (caught) { if (sequence === searchSequence.current) setSearchError(errorMessage(caught)); }
    finally { if (sequence === searchSequence.current) setSearching(false); }
  }

  return <div className="knowledge-page">
    <header className="page-head knowledge-head"><div><span className="knowledge-eyebrow">KNOWLEDGE / 企业上下文</span><h1>企业知识</h1>{overview ? <p className="knowledge-space-name">{overview.spaceName}</p> : null}</div>
      <button className="btn" type="button" onClick={() => void load()} disabled={loading || !!busy}>{loading ? '读取中…' : '刷新状态'}</button>
    </header>
    <div className="knowledge-intro"><p>从可信来源建立依据，让每一条建议都能回到原文。</p><p className="helper">只读接入 · 来源权限优先 · 解析完成不等于人工确认</p></div>
    {error ? <div className="knowledge-alert" role="alert">{error}</div> : null}
    {notice ? <div className="knowledge-notice" role="status">{notice}</div> : null}
    {!overview && loading ? <div className="panel knowledge-empty" role="status">正在读取来源与知识状态…</div> : null}
    {overview ? <>
      <form className="panel knowledge-space-form" aria-label="知识空间命名" onSubmit={renameSpace}>
        <label className="field"><span>知识空间名称</span><input required maxLength={160} value={spaceName} onChange={event => setSpaceName(event.target.value)} /></label>
        <button className="btn" disabled={!!busy || !spaceName.trim()}>保存知识空间名称</button>
        <p className="helper">仅更新空间名称元数据，不复制数据库或改变来源范围。</p>
      </form>
      <dl className="knowledge-metrics">
        <div><dt>来源连接</dt><dd>{overview.connections.length}<small> {overview.connections.filter(connection => connection.status === 'confirmed').length} 个已确认</small></dd></div>
        <div><dt>已确认版本</dt><dd>{confirmedCount}<small> / {overview.items.length} 份资料</small></dd></div>
        <div><dt>建议草案</dt><dd>{recommendations.length}<small> 待人工核对</small></dd></div>
      </dl>
      <div className="knowledge-grid">
        <section className="panel knowledge-section" aria-labelledby="knowledge-sources-heading">
          <div className="knowledge-section-head"><span className="knowledge-step">01</span><div><h2 id="knowledge-sources-heading">连接知识来源</h2><p className="helper">连接确认与资料版本确认分别管理。</p></div></div>
          <div className="knowledge-plugins" aria-label="来源插件目录">{overview.plugins.map(plugin => <div key={plugin.id} data-testid={`plugin-${plugin.id}`}><strong>{plugin.name}</strong><span className="knowledge-badge">{!plugin.installed ? '未安装' : !plugin.enabled ? '已暂停' : plugin.configured ? '已启用 · 已配置' : '已安装 · 待配置'}</span><small>{plugin.builtIn ? '内置插件 · ' : ''}{plugin.capabilities.join(' · ') || '能力以服务端为准'}</small>
            {!plugin.installed ? <button className="btn" type="button" disabled={!!busy} onClick={() => void action(`install:${plugin.id}`, `/plugins/${encodeURIComponent(plugin.id)}/install`, {}, '插件已安装。请另行配置来源范围并创建连接。')}>安装{plugin.name}插件</button> : <button className="btn" type="button" disabled={!!busy} onClick={() => void action(`plugin:${plugin.id}`, `/plugins/${encodeURIComponent(plugin.id)}`, { enabled: !plugin.enabled }, plugin.enabled ? '插件已暂停，来源数据保持不变。' : '插件已启用，请核对来源连接。')}>{plugin.enabled ? '暂停' : '启用'}{plugin.name}插件</button>}
            {plugin.id === 'database' ? <button type="button" className="btn" onClick={() => document.getElementById('database-source-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>配置只读数据库来源</button> : null}
          </div>)}</div>
          <p className="helper">安装仅登记插件能力；不会创建来源连接、导入资料或生成员工工具。凭据由管理员通过托管身份或安全凭据引用配置，请勿在名称、范围或查询模板中填写原始密钥、密码或 DSN。</p>
          {overview.connections.length ? <ul className="knowledge-source-list">{overview.connections.map(connection => <li key={connection.id}>
            <div><strong>{connection.name}</strong><small>{overview.plugins.find(plugin => plugin.id === connection.pluginId)?.name ?? connection.pluginId}</small></div>
            <span className={`knowledge-badge ${connection.status === 'confirmed' ? 'is-green' : ''}`}>{label(connection.status)}</span>
            {overview.canConfirm && ['draft','tested','pending_confirmation','sync_failed','needs_reauth'].includes(connection.status) ? <button className="btn" disabled={!!busy} onClick={() => void action(`confirm:${connection.id}`, `/connections/${encodeURIComponent(connection.id)}/confirm`, {}, '连接已确认，资料仍需逐版本确认。')}>{connection.status==='draft'?'确认连接':'重新测试并确认连接'}</button> : null}
            {overview.canConfirm && connection.status === 'confirmed' ? <button className="btn" disabled={!!busy} onClick={() => void action(`confirm:${connection.id}`, `/connections/${encodeURIComponent(connection.id)}/confirm`, {}, '连接已重新测试并确认，资料仍需逐版本确认。')}>重新测试连接</button> : null}
            {['email', 'sharepoint'].includes(connection.pluginId) ? <RemoteSourcePreview connection={connection} resource={overview.sourceResources?.find(resource => resource.id === connection.scope?.resourceId)} active={overview.plugins.some(plugin => plugin.id === connection.pluginId && plugin.installed && plugin.enabled && plugin.configured)} disabled={!!busy} onAction={action} /> : null}
          </li>)}</ul> : <p className="knowledge-empty">还没有来源连接。先创建连接，再导入资料。</p>}
          <form onSubmit={createConnection} className="knowledge-form knowledge-inset">
            <label className="field"><span>连接名称</span><input required maxLength={160} value={connectionName} placeholder="例如：团队操作资料" onChange={event => setConnectionName(event.target.value)} /></label>
            <label className="field"><span>来源插件</span><select value={selectedPlugin} onChange={event => { setPluginId(event.target.value); setResourceId(''); setReadOnlyAcknowledged(false); }} disabled={!plugins.length}>{!plugins.length ? <option value="">没有已安装、启用且已配置的插件</option> : plugins.map(plugin => <option key={plugin.id} value={plugin.id}>{plugin.name}</option>)}</select></label>
            {remotePlugin ? <>
              <label className="field"><span>已批准的来源资源</span><select value={selectedResource?.id ?? ''} disabled={!sourceResources.length || !!busy} onChange={event => { setResourceId(event.target.value); setReadOnlyAcknowledged(false); }}>{!sourceResources.length ? <option value="">暂无已批准的来源资源</option> : sourceResources.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
              {selectedResource ? <ScopeSummary scope={selectedResource.scope} projectIds={selectedResource.projectIds} /> : <p className="helper">请由管理员批准来源范围后再创建连接。</p>}
              <label className="knowledge-check"><input type="checkbox" required checked={readOnlyAcknowledged} onChange={event => setReadOnlyAcknowledged(event.target.checked)} /><span>我已核对来源范围，并确认仅以只读方式接入</span></label>
            </> : null}
            <p className="helper">默认读者为当前用户。连接只读；确认操作不能覆盖来源权限和项目范围。需要额外授权的来源由服务端校验。</p>
            <button className="btn" disabled={!!busy || !selectedPlugin || !connectionName.trim() || (remotePlugin && (!selectedResource || !readOnlyAcknowledged))}>{busy === 'connection' ? '创建中…' : '创建连接草案'}</button>
          </form>
        </section>

        <section className="panel knowledge-section" aria-labelledby="knowledge-upload-heading">
          <div className="knowledge-section-head"><span className="knowledge-step">02</span><div><h2 id="knowledge-upload-heading">导入与确认资料</h2><p className="helper">仅已确认且仍有权限的版本可参与检索与分析。</p></div></div>
          <form onSubmit={upload} className="knowledge-form">
            <label className="field"><span>已确认的本地来源</span><select value={selectedConnection} onChange={event => setConnectionId(event.target.value)} disabled={!uploadConnections.length}>{!uploadConnections.length ? <option value="">请先创建并确认本地连接</option> : uploadConnections.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}</select></label>
            <label className="knowledge-file field"><span>{readingFile ? '正在读取文件…' : '选择文本文件（.txt / .md / .csv / .markdown，最多 2 MB）'}</span><input type="file" accept=".txt,.md,.csv,.markdown,text/plain,text/markdown,text/csv" disabled={readingFile || !!busy || !selectedConnection} onChange={event => { void readFile(event.target.files?.[0]); event.target.value = ''; }} /></label>
            <label className="field"><span>资料名称</span><input required maxLength={180} value={uploadName} onChange={event => setUploadName(event.target.value)} placeholder="操作手册.md" /></label>
            <label className="field"><span>文本内容</span><textarea required rows={5} maxLength={200_000} value={uploadText} onChange={event => setUploadText(event.target.value)} placeholder="也可以在此粘贴纯文本…" /></label>
            <p className="helper">文本提交后需核对原文并确认当前版本。PDF、扫描件和 Office 文件请使用下方文档解析入口。</p>
            <button className="btn primary" disabled={!!busy || readingFile || !selectedConnection || !uploadName.trim() || !uploadText.trim()}>{busy === 'upload' ? '提交中…' : '提交资料'}</button>
          </form>
          <form onSubmit={uploadBinary} className="knowledge-form knowledge-inset" aria-labelledby="knowledge-binary-heading">
            <h3 id="knowledge-binary-heading">PDF / 扫描件 / Office 文档解析</h3>
            <label className="knowledge-file field"><span>选择待解析文档（最多 20 MiB）</span><input type="file" accept=".pdf,.png,.jpg,.jpeg,.tiff,.docx,.xlsx,.pptx" disabled={!!busy || readingBinary || !selectedConnection} onChange={event => { chooseBinary(event.target.files?.[0]); event.target.value = ''; }} /></label>
            {binaryFile ? <p className="helper">已选择：{binaryFile.name} · {(binaryFile.size / 1024 / 1024).toFixed(2)} MiB</p> : null}
            <p className="helper">支持 PDF、PNG、JPG、JPEG、TIFF、DOCX、XLSX、PPTX。文件提交到 Azure 持久解析队列；云端服务未配置时将显示实际错误。</p>
            <button className="btn primary" disabled={!!busy || readingBinary || !selectedConnection || !binaryFile}>{readingBinary || busy === 'binary' ? '读取并提交中…' : '提交到文档解析队列'}</button>
          </form>
          {overview.parseJobs.length ? <div className="knowledge-parse-jobs" aria-label="文档解析任务"><h3>文档解析任务</h3><ul className="knowledge-source-list">{overview.parseJobs.map(job => <li key={job.id}>
            <div><strong>{job.name}</strong><small>任务 {job.id}</small>{job.error ? <small className="knowledge-job-error">{job.error}</small> : null}{job.status === 'completed' ? <small>解析完成，请核对下方资料并确认当前版本。</small> : job.status === 'outcome_unknown' ? <small className="knowledge-job-error">请人工核对云端任务和文件状态，再决定后续处理。</small> : null}</div>
            <span className={`knowledge-badge ${job.status === 'completed' ? 'is-green' : job.status === 'outcome_unknown' || job.status === 'failed' ? 'is-warning' : ''}`}>{label(job.status)}</span>
          </li>)}</ul></div> : null}
          {overview.items.length ? <ul className="knowledge-source-list knowledge-items">{overview.items.map(item => <li key={item.id}>
            <div><strong>{item.title}</strong><small>版本 {item.version} · {item.locator}</small><small>{label(item.status)} · {item.confirmed ? '当前版本已人工确认' : '尚未确认用于检索'}</small><ItemPreview key={`${item.id}:${item.version}`} item={item} /></div>
            {item.confirmed ? <span className="knowledge-badge is-green">已确认</span> : ['deleted', 'revoked', 'parse_failed'].includes(item.status) ? <span className="knowledge-badge">不可用</span> : overview.canConfirm ? <button className="btn" disabled={!!busy} title={`核对原始资料后确认版本 ${item.version}`} onClick={() => void action(`item:${item.id}`, `/items/${encodeURIComponent(item.id)}/confirm`, { version: item.version }, '当前资料版本已确认；是否可用仍由源权限决定。')}>确认此版本</button> : null}
          </li>)}</ul> : <p className="knowledge-empty">还没有资料。上传后将在这里显示解析与确认状态。</p>}
        </section>
      </div>

      <DatabaseSourcePanel resources={databaseEnabled ? overview.databaseResources ?? [] : []} connections={overview.connections} pluginEnabled={databaseEnabled} onRefresh={load} />
      <section className="panel knowledge-section" aria-labelledby="knowledge-search-heading">
        <div className="knowledge-section-head"><span className="knowledge-step">03</span><div><h2 id="knowledge-search-heading">有依据地查询</h2><p className="helper">权限未知、未确认、已撤销或过期版本不应进入结果。</p></div></div>
        <form className="knowledge-search-form" onSubmit={search}><label className="field"><span>查询企业资料</span><input required maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="输入需要查证的问题或关键词" /></label><button className="btn primary" disabled={searching || !!busy || !query.trim()}>{searching ? '查询中…' : '查询依据'}</button></form>
        {searchError ? <p className="knowledge-alert" role="alert">{searchError}</p> : null}
        {searchResult ? <div className="knowledge-search-result" aria-live="polite">{searchResult.hits.length ? <><p className="knowledge-answer">{searchResult.answer || '已找到以下来源依据。'}</p><EvidenceList evidence={searchResult.hits} /></> : <p className="knowledge-empty">没有当前可用的依据。请确认来源版本、访问权限，或调整关键词。</p>}</div> : <p className="helper">回答和引用来自服务端实际检索结果；没有依据时不生成结论。</p>}
      </section>

      <section className="panel knowledge-section" aria-labelledby="knowledge-analysis-heading">
        <div className="knowledge-section-head"><span className="knowledge-step">04</span><div><h2 id="knowledge-analysis-heading">知识分析与建议草案</h2><p className="helper">员工、工具、SOP 与业务对象仅形成草案，需人工决定后续操作。</p></div><button className="btn primary" disabled={!!busy || analysisActive || !confirmedCount} onClick={() => void action('analysis', '/analyses', {}, '分析任务已提交，进度以服务端状态为准。')}>{busy === 'analysis' ? '提交中…' : analysisActive ? '分析进行中' : '开始分析'}</button></div>
        {!confirmedCount ? <p className="helper">请先确认至少一份有权限的资料版本。</p> : null}
        <form className="knowledge-form knowledge-inset knowledge-manual-role" aria-label="人工补充角色" onSubmit={addManualRole}>
          <h3>人工补充角色</h3><p className="helper">直接记录人工已知的角色，标注为人工补充；不会伪装成文档推断，也不会替代来源版本确认。</p>
          <label className="field"><span>人工角色名称</span><input required maxLength={160} value={manualRoleName} onChange={event => setManualRoleName(event.target.value)} /></label>
          <label className="field"><span>人工角色说明</span><textarea required rows={3} maxLength={4000} value={manualRoleDescription} onChange={event => setManualRoleDescription(event.target.value)} /></label>
          <button className="btn" disabled={!!busy || !manualRoleName.trim() || !manualRoleDescription.trim()}>添加人工角色</button>
        </form>
        {overview.analyses.length ? <ul className="knowledge-runs">{overview.analyses.slice(-5).reverse().map(run => <li key={run.id}><span className={`knowledge-badge ${run.status === 'completed' ? 'is-green' : ''}`}>{label(run.status)}</span><span>{label(run.stage)}</span><small>{run.id}</small></li>)}</ul> : <p className="knowledge-empty">尚未运行分析。分析开始前会再次检查来源权限和版本。</p>}
        {recommendations.length ? <div className="knowledge-recommendations">{recommendations.map(recommendation => <RecommendationCard key={recommendation.id} recommendation={recommendation} disabled={!!busy} onAction={action} />)}</div> : <p className="knowledge-empty">暂无建议草案。只有带当前有效引用的分析结果才会出现在这里。</p>}
      </section>
    </> : !loading ? <button className="btn" onClick={() => void load()}>重试读取知识状态</button> : null}
  </div>;
}
