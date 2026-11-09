import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import './DatabaseSourcePanel.css';

interface DatabaseResource {
  id: string;
  name: string;
  tables: Record<string, { columns: string[]; sensitive?: string[] }>;
  maxRows: number;
}
interface DatabaseConnection { id: string; name: string; pluginId: string; status: string; scope?: { resourceId?: string } }
interface QueryTemplate { id: string; sql: string; params: string[]; approvedBy: string }
interface CurrentFact {
  kind: 'current_fact'; rows: Record<string, unknown>[]; rowCount: number;
  queriedAt: string; scope: unknown; schemaVersion: string; revision: string | null;
}
export interface DatabaseSourcePanelProps {
  resources: DatabaseResource[];
  connections: DatabaseConnection[];
  onRefresh: () => Promise<void>;
  pluginEnabled?: boolean;
}

const ROOT = '/api/v1/knowledge';
const MAX_DISPLAY_ROWS = 100;
const MAX_DISPLAY_COLUMNS = 30;
const message = (error: unknown) => error instanceof Error ? error.message : '数据库请求失败，请重试。';

async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await api<T & { message?: string; error?: string }>(ROOT + path,
    body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(response.body.message ?? response.body.error ?? `数据库请求失败（HTTP ${response.status}）`);
  }
  return response.body;
}

function displayValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** The server approves templates and runs read-only queries; this panel never executes raw editor SQL. */
export function DatabaseSourcePanel({ resources, connections, onRefresh, pluginEnabled = true }: DatabaseSourcePanelProps) {
  const [resourceId, setResourceId] = useState('');
  const [name, setName] = useState('');
  const [readOnlyAcknowledged, setReadOnlyAcknowledged] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [templates, setTemplates] = useState<QueryTemplate[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [sql, setSql] = useState('');
  const [parameterNames, setParameterNames] = useState('');
  const [argsText, setArgsText] = useState('[]');
  const [fact, setFact] = useState<CurrentFact | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [templateError, setTemplateError] = useState('');
  const [reload, setReload] = useState(0);
  const requestSequence = useRef(0);
  const mutationActive = useRef(false);
  const selectedResource = resources.find(resource => resource.id === resourceId) ?? resources[0];
  const confirmed = connections.filter(connection => pluginEnabled && resources.length > 0 && connection.pluginId === 'database' && connection.status === 'confirmed' && (!connection.scope?.resourceId || resources.some(resource => resource.id === connection.scope?.resourceId)));
  const selectedConnection = confirmed.find(connection => connection.id === connectionId) ?? confirmed[0];
  const selectedConnectionId = selectedConnection?.id ?? '';
  const selectedTemplate = templates.find(template => template.id === templateId);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    setTemplates([]); setFact(null); setTemplateError(''); setError(''); setArgsText('[]');
    if (!selectedConnectionId) { setLoadingTemplates(false); setTemplateId(''); return; }
    setLoadingTemplates(true);
    void request<{ templates: QueryTemplate[] }>(`/connections/${encodeURIComponent(selectedConnectionId)}/templates`)
      .then(result => {
        if (sequence !== requestSequence.current) return;
        setTemplates(result.templates);
        setTemplateId(current => result.templates.some(template => template.id === current) ? current : result.templates[0]?.id ?? '');
      })
      .catch(caught => { if (sequence === requestSequence.current) setTemplateError(message(caught)); })
      .finally(() => { if (sequence === requestSequence.current) setLoadingTemplates(false); });
    return () => { requestSequence.current++; };
  }, [selectedConnectionId, reload]);

  async function createConnection(event: FormEvent) {
    event.preventDefault();
    if (!selectedResource || !pluginEnabled || !readOnlyAcknowledged || mutationActive.current) return;
    mutationActive.current = true; setBusy('create'); setError(''); setNotice('');
    try {
      await request('/connections', { name: name.trim(), pluginId: 'database', scope: { resourceId: selectedResource.id }, readOnlyAcknowledged: true });
      setName(''); setReadOnlyAcknowledged(false); setNotice('数据库连接草案已创建，请在来源连接列表中核对并确认。');
      try { await onRefresh(); } catch (caught) { setError(`连接已创建，列表刷新失败：${message(caught)}`); }
    } catch (caught) { setError(message(caught)); }
    finally { mutationActive.current = false; setBusy(''); }
  }

  async function approveTemplate(event: FormEvent) {
    event.preventDefault();
    if (!selectedConnectionId || mutationActive.current) return;
    setError(''); setNotice('');
    const params = parameterNames.trim() ? parameterNames.split(',').map(value => value.trim()) : [];
    if (params.some(value => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) || new Set(params).size !== params.length) {
      setError('参数名请使用唯一的英文标识符，以逗号分隔；无参数时留空。'); return;
    }
    if (!/^select\b/i.test(sql.trim())) { setError('模板必须以 SELECT 开头；服务端将继续校验只读语句与允许范围。'); return; }
    const capturedConnection = selectedConnectionId;
    const sequence = requestSequence.current;
    mutationActive.current = true; setBusy('approve'); setFact(null);
    try {
      const saved = await request<{ id: string }>(`/connections/${encodeURIComponent(capturedConnection)}/templates`, { sql: sql.trim(), params });
      if (sequence === requestSequence.current) {
        setTemplateId(saved.id); setNotice(`查询模板已获服务端批准，模板 ID：${saved.id}。请在下方另行执行。`);
        setSql(''); setParameterNames(''); setReload(value => value + 1);
      }
    } catch (caught) { if (sequence === requestSequence.current) setError(message(caught)); }
    finally { mutationActive.current = false; setBusy(''); }
  }
  async function syncStructure() {
    if (!selectedConnectionId || mutationActive.current) return;
    mutationActive.current=true; setBusy('sync'); setError(''); setNotice(''); setFact(null);
    try { const result=await request<{error?:string}>(`/connections/${encodeURIComponent(selectedConnectionId)}/sync`,{}); if(result.error) throw Error(result.error); await onRefresh(); setNotice('数据库表与列结构已读取，资料版本仍需在来源列表核对并确认。'); }
    catch(caught) { setError(message(caught)); }
    finally {mutationActive.current=false;setBusy('');}
  }

  async function runTemplate(event: FormEvent) {
    event.preventDefault();
    if (!selectedConnectionId || !selectedTemplate?.approvedBy || mutationActive.current) return;
    setError(''); setNotice(''); setFact(null);
    let args: unknown;
    try { args = JSON.parse(argsText) as unknown; } catch { setError('执行参数必须是有效的 JSON 数组，例如 ["active", 2026]。'); return; }
    if (!Array.isArray(args)) { setError('执行参数必须是 JSON 数组。'); return; }
    if (args.length !== selectedTemplate.params.length) { setError(`此模板需要 ${selectedTemplate.params.length} 个参数，顺序为：${selectedTemplate.params.join(', ') || '无'}。`); return; }
    const sequence = requestSequence.current;
    mutationActive.current = true; setBusy('query');
    try {
      const result = await request<CurrentFact>(`/connections/${encodeURIComponent(selectedConnectionId)}/query`, { templateId: selectedTemplate.id, args });
      if (result.kind !== 'current_fact' || !Array.isArray(result.rows)) throw new Error('服务端未返回有效的当前事实结果。');
      if (sequence === requestSequence.current) setFact(result);
    } catch (caught) { if (sequence === requestSequence.current) setError(message(caught)); }
    finally { mutationActive.current = false; setBusy(''); }
  }

  async function checkFreshness() {
    if (!fact || !selectedConnectionId || !selectedTemplate || mutationActive.current) return;
    const sequence = requestSequence.current;
    mutationActive.current = true; setBusy('freshness'); setError(''); setNotice('');
    try {
      const result = await request<{ fresh: boolean; reason?: string }>(`/connections/${encodeURIComponent(selectedConnectionId)}/fact-freshness?templateId=${encodeURIComponent(selectedTemplate.id)}&revision=${encodeURIComponent(fact.revision ?? '')}`);
      if (sequence !== requestSequence.current) return;
      if (result.fresh) setNotice('已核对来源数据，当前事实仍有效。');
      else { setFact(null); setError('来源数据已变化或无法核实，结果已过期，请重新查询'); }
    } catch (caught) {
      if (sequence === requestSequence.current) { setFact(null); setError(`来源数据已变化或无法核实，结果已过期，请重新查询。${message(caught)}`); }
    } finally { mutationActive.current = false; setBusy(''); }
  }

  const rows = fact?.rows.slice(0, MAX_DISPLAY_ROWS) ?? [];
  const allColumns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const columns = allColumns.slice(0, MAX_DISPLAY_COLUMNS);

  return <section className="panel database-source" aria-labelledby="database-source-heading">
    <header className="database-source-head"><div><span className="database-source-eyebrow">READ-ONLY DATA / 受控查询</span><h2 id="database-source-heading">只读数据库来源</h2></div><span className="database-source-tag">当前事实</span></header>
    <p className="helper">仅连接 DBA 已批准的独立只读账号与表／视图范围。模板批准与执行分开管理，查询结果附带时间与范围。</p>
    <p className="helper">凭据由管理员通过托管身份或安全凭据引用配置。请勿在连接名称或 SQL 中填写原始密钥、密码、连接字符串或 DSN。</p>
    {error ? <p className="database-source-error" role="alert">{error}</p> : null}
    {notice ? <p className="database-source-notice" role="status">{notice}</p> : null}
    {!pluginEnabled ? <p className="database-source-empty">请先在来源插件目录安装并启用数据库插件，再配置只读来源。</p> : !resources.length ? <p className="database-source-empty">尚未配置 DBA 批准的数据库资源。请先配置独立只读数据库账号，以及允许访问的表、行过滤视图和列范围，再创建连接。</p> : <>
      <form className="database-source-form database-source-inset" onSubmit={createConnection}>
        <h3>创建受控连接</h3>
        <label className="field"><span>DBA 批准的资源</span><select value={selectedResource?.id ?? ''} disabled={!!busy} onChange={event => { setResourceId(event.target.value); setReadOnlyAcknowledged(false); }}>{resources.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
        {selectedResource ? <div className="database-source-scope"><p>每次查询最多 {selectedResource.maxRows} 行 · 资源 {selectedResource.id}</p><ul>{Object.entries(selectedResource.tables).map(([table, spec]) => <li key={table}><strong>{table}</strong><span>{spec.columns.join(', ') || '未配置可读列'}</span>{spec.sensitive?.length ? <small>敏感列由网关限制并脱敏：{spec.sensitive.join(', ')}</small> : null}</li>)}</ul></div> : null}
        <label className="field"><span>数据库连接名称</span><input required maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder="例如：运营只读视图" /></label>
        <label className="database-source-check"><input type="checkbox" required checked={readOnlyAcknowledged} onChange={event => setReadOnlyAcknowledged(event.target.checked)} /><span>我已核对数据库范围，并确认使用独立只读账号接入</span></label>
        <button className="btn" disabled={!!busy || !name.trim() || !selectedResource || !readOnlyAcknowledged}>{busy === 'create' ? '创建中…' : '创建数据库连接草案'}</button>
      </form>
    </>}

    <div className="database-source-inset">
      <label className="field"><span>已确认的数据库连接</span><select value={selectedConnectionId} disabled={!!busy || !confirmed.length} onChange={event => { setConnectionId(event.target.value); setTemplateId(''); setNotice(''); }}>
        {!confirmed.length ? <option value="">请先在来源连接列表确认数据库连接</option> : confirmed.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
      </select></label>
      <button className="btn" type="button" disabled={!!busy || !selectedConnectionId} onClick={()=>void syncStructure()}>{busy==='sync'?'正在读取结构…':'读取数据库结构知识'}</button>
      <p className="helper">结构资料只记录批准的表、列和定位；实时查询记录会留在源数据库。</p>
      {!selectedConnectionId ? <p className="database-source-empty">确认连接后，可提交 SELECT 模板审批，再用获批模板查询当前事实。</p> : <div className="database-source-grid">
        <form className="database-source-form" onSubmit={approveTemplate}>
          <h3>1. 批准 SELECT 查询模板</h3>
          <label className="field"><span>待批准的 SQL 模板</span><textarea required rows={5} maxLength={8000} spellCheck={false} value={sql} onChange={event => setSql(event.target.value)} placeholder="使用已批准的表和列；参数按 $1、$2 顺序绑定" /></label>
          <label className="field"><span>参数名称（英文逗号分隔，可留空）</span><input maxLength={2000} value={parameterNames} onChange={event => setParameterNames(event.target.value)} placeholder="status, year" /></label>
          <p className="helper">此操作仅提交模板审批。网关会校验只读语句、字段范围和敏感列规则；审批成功后再选择模板执行。</p>
          <button className="btn" disabled={!!busy || !sql.trim()}>{busy === 'approve' ? '审批中…' : '提交并批准查询模板'}</button>
        </form>

        <form className="database-source-form" onSubmit={runTemplate}>
          <h3>2. 执行已批准的模板</h3>
          <label className="field"><span>已批准模板</span><select value={selectedTemplate?.id ?? ''} disabled={!!busy || loadingTemplates || !templates.length} onChange={event => { setTemplateId(event.target.value); setFact(null); setArgsText('[]'); }}>
            {!templates.length ? <option value="">{loadingTemplates ? '读取模板中…' : '暂无已批准模板'}</option> : templates.map(template => <option key={template.id} value={template.id}>{template.id}</option>)}
          </select></label>
          {templateError ? <div className="database-source-error" role="alert">{templateError}<button type="button" className="btn" disabled={!!busy || loadingTemplates} onClick={() => setReload(value => value + 1)}>重新读取模板</button></div> : null}
          {selectedTemplate ? <div className="database-source-template"><pre>{selectedTemplate.sql}</pre><p className="helper">批准人：{selectedTemplate.approvedBy || '尚未批准'} · 参数顺序：{selectedTemplate.params.join(', ') || '无参数'}</p></div> : null}
          <label className="field"><span>执行参数（JSON 数组）</span><textarea required rows={2} maxLength={20000} spellCheck={false} value={argsText} onChange={event => setArgsText(event.target.value)} placeholder='["active", 2026]' /></label>
          <button className="btn primary" disabled={!!busy || loadingTemplates || !selectedTemplate?.approvedBy}>{busy === 'query' ? '查询中…' : '执行已批准模板'}</button>
        </form>
      </div>}
    </div>

    {fact ? <section className="database-source-result" aria-label="数据库当前事实结果" aria-live="polite">
      <h3>当前事实 · 查询时点结果</h3><p className="helper">这些结果只描述当前查询事实，不作为企业制度或规则知识保存。</p>
      <dl><div><dt>查询时间</dt><dd>{fact.queriedAt}</dd></div><div><dt>查询范围</dt><dd>{displayValue(fact.scope)}</dd></div><div><dt>结构版本</dt><dd>{fact.schemaVersion}</dd></div><div><dt>返回行数</dt><dd>{fact.rowCount}</dd></div></dl>
      <button className="btn" type="button" disabled={!!busy} onClick={() => void checkFreshness()}>{busy === 'freshness' ? '正在核对来源数据…' : '核对事实是否仍有效'}</button>
      {rows.length ? <><p className="helper">显示 {rows.length} 行、{columns.length} 列。{fact.rows.length > MAX_DISPLAY_ROWS || allColumns.length > MAX_DISPLAY_COLUMNS ? '结果较多，当前页面仅展示前 100 行、30 列；单元格最多显示 500 个字符。' : '单元格最多显示 500 个字符。'}</p><div className="database-source-table-scroll" tabIndex={0} aria-label="可横向滚动的查询结果"><table><thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{displayValue(row[column])}</td>)}</tr>)}</tbody></table></div></> : <p className="database-source-empty">本次查询没有返回记录。</p>}
    </section> : null}
  </section>;
}
