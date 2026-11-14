import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useT, type Dict } from '../i18n';
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

const TEXT = {
  en: {
    reqFailed: 'Database request failed. Please try again.',
    reqFailedHttp: 'Database request failed (HTTP {status})',
    eyebrow: 'READ-ONLY DATA / CONTROLLED QUERY',
    heading: 'Read-only database source',
    tag: 'Current fact',
    intro1: 'Connect only to DBA-approved standalone read-only accounts and table/view scopes. Template approval and execution are managed separately, with timestamps and scope attached to results.',
    intro2: 'Credentials are configured by admins via managed identity or secure credential references. Never enter raw secrets, passwords, connection strings, or DSNs in connection names or SQL.',
    noPlugin: 'Install and enable the database plugin in the source catalog before configuring a read-only source.',
    noResources: 'No DBA-approved database resources are configured yet. Configure a standalone read-only account and allowed tables, row-filtered views, and columns before creating a connection.',
    createTitle: 'Create controlled connection',
    dbaResource: 'DBA-approved resource',
    maxRows: 'Up to {maxRows} rows per query · Resource {id}',
    noReadableCols: 'No readable columns configured',
    sensitiveCols: 'Sensitive columns restricted and masked by gateway: {cols}',
    connName: 'Database connection name',
    connNamePlaceholder: 'e.g. Operations read-only view',
    ackLabel: 'I have verified the database scope and confirm connecting with a standalone read-only account',
    creating: 'Creating…',
    createBtn: 'Create database connection draft',
    createSuccess: 'Database connection draft created. Verify and confirm it in the source connections list.',
    refreshFailed: 'Connection created, but refreshing the list failed: {msg}',
    confirmedConn: 'Confirmed database connection',
    noConfirmedConn: 'Confirm a database connection in the source connections list first',
    syncing: 'Reading schema…',
    syncBtn: 'Read database schema knowledge',
    syncSuccess: 'Database tables and columns read. Material versions still need confirmation in the source list.',
    syncHint: 'Schema materials only record approved tables, columns, and locators; live query logs stay in the source database.',
    needConnHint: 'After confirming a connection, you can submit a SELECT template for approval and query current facts with approved templates.',
    approveTitle: '1. Approve SELECT query template',
    sqlLabel: 'SQL template for approval',
    sqlPlaceholder: 'Use approved tables and columns; bind parameters sequentially as $1, $2',
    paramsLabel: 'Parameter names (comma-separated, optional)',
    paramsPlaceholder: 'status, year',
    approveHint: 'This only submits a template for approval. The gateway checks read-only syntax, field scopes, and sensitive column rules; select the template below to run after approval.',
    approving: 'Approving…',
    approveBtn: 'Submit and approve query template',
    paramErr: 'Use unique identifier names separated by commas for parameters, or leave blank if none.',
    selectErr: 'Template must start with SELECT; the server will further verify read-only syntax and allowed scope.',
    approveSuccess: 'Query template approved by server, template ID: {id}. Run it separately below.',
    runTitle: '2. Run approved template',
    approvedTplLabel: 'Approved template',
    loadingTpls: 'Loading templates…',
    noTpls: 'No approved templates yet',
    reloadTpls: 'Reload templates',
    approvedBy: 'Approved by: {by} · Parameter order: {params}',
    unapproved: 'Not yet approved',
    noParams: 'None',
    argsLabel: 'Execution arguments (JSON array)',
    querying: 'Querying…',
    runBtn: 'Run approved template',
    argsJsonErr: 'Execution arguments must be a valid JSON array, e.g. ["active", 2026].',
    argsArrayErr: 'Execution arguments must be a JSON array.',
    argsCountErr: 'This template requires {count} argument(s) in order: {params}.',
    invalidFactErr: 'Server did not return a valid current fact result.',
    resultAria: 'Database current fact result',
    resultTitle: 'Current fact · Point-in-time query result',
    resultHint: 'These results only describe current queried facts and are not saved as enterprise policies or rule knowledge.',
    queriedAt: 'Queried at',
    queryScope: 'Query scope',
    schemaVersion: 'Schema version',
    rowCount: 'Row count',
    checkingFresh: 'Checking source data…',
    checkFreshBtn: 'Check if fact is still fresh',
    freshOk: 'Source data verified; current fact is still valid.',
    freshStale: 'Source data changed or could not be verified; result expired, please query again',
    freshStaleDetail: 'Source data changed or could not be verified; result expired, please query again. {msg}',
    rowsSummaryTruncated: 'Showing {rows} rows, {cols} columns. Results are large; only the first 100 rows and 30 columns are shown, with up to 500 characters per cell.',
    rowsSummary: 'Showing {rows} rows, {cols} columns. Up to 500 characters per cell.',
    tableAria: 'Horizontally scrollable query result',
    emptyRows: 'This query returned no records.',
  },
  zh: {
    reqFailed: '数据库请求失败，请重试。',
    reqFailedHttp: '数据库请求失败（HTTP {status}）',
    eyebrow: 'READ-ONLY DATA / 受控查询',
    heading: '只读数据库来源',
    tag: '当前事实',
    intro1: '仅连接 DBA 已批准的独立只读账号与表／视图范围。模板批准与执行分开管理，查询结果附带时间与范围。',
    intro2: '凭据由管理员通过托管身份或安全凭据引用配置。请勿在连接名称或 SQL 中填写原始密钥、密码、连接字符串或 DSN。',
    noPlugin: '请先在来源插件目录安装并启用数据库插件，再配置只读来源。',
    noResources: '尚未配置 DBA 批准的数据库资源。请先配置独立只读数据库账号，以及允许访问的表、行过滤视图和列范围，再创建连接。',
    createTitle: '创建受控连接',
    dbaResource: 'DBA 批准的资源',
    maxRows: '每次查询最多 {maxRows} 行 · 资源 {id}',
    noReadableCols: '未配置可读列',
    sensitiveCols: '敏感列由网关限制并脱敏：{cols}',
    connName: '数据库连接名称',
    connNamePlaceholder: '例如：运营只读视图',
    ackLabel: '我已核对数据库范围，并确认使用独立只读账号接入',
    creating: '创建中…',
    createBtn: '创建数据库连接草案',
    createSuccess: '数据库连接草案已创建，请在来源连接列表中核对并确认。',
    refreshFailed: '连接已创建，列表刷新失败：{msg}',
    confirmedConn: '已确认的数据库连接',
    noConfirmedConn: '请先在来源连接列表确认数据库连接',
    syncing: '正在读取结构…',
    syncBtn: '读取数据库结构知识',
    syncSuccess: '数据库表与列结构已读取，资料版本仍需在来源列表核对并确认。',
    syncHint: '结构资料只记录批准的表、列和定位；实时查询记录会留在源数据库。',
    needConnHint: '确认连接后，可提交 SELECT 模板审批，再用获批模板查询当前事实。',
    approveTitle: '1. 批准 SELECT 查询模板',
    sqlLabel: '待批准的 SQL 模板',
    sqlPlaceholder: '使用已批准的表和列；参数按 $1、$2 顺序绑定',
    paramsLabel: '参数名称（英文逗号分隔，可留空）',
    paramsPlaceholder: 'status, year',
    approveHint: '此操作仅提交模板审批。网关会校验只读语句、字段范围和敏感列规则；审批成功后再选择模板执行。',
    approving: '审批中…',
    approveBtn: '提交并批准查询模板',
    paramErr: '参数名请使用唯一的英文标识符，以逗号分隔；无参数时留空。',
    selectErr: '模板必须以 SELECT 开头；服务端将继续校验只读语句与允许范围。',
    approveSuccess: '查询模板已获服务端批准，模板 ID：{id}。请在下方另行执行。',
    runTitle: '2. 执行已批准的模板',
    approvedTplLabel: '已批准模板',
    loadingTpls: '读取模板中…',
    noTpls: '暂无已批准模板',
    reloadTpls: '重新读取模板',
    approvedBy: '批准人：{by} · 参数顺序：{params}',
    unapproved: '尚未批准',
    noParams: '无参数',
    argsLabel: '执行参数（JSON 数组）',
    querying: '查询中…',
    runBtn: '执行已批准模板',
    argsJsonErr: '执行参数必须是有效的 JSON 数组，例如 ["active", 2026]。',
    argsArrayErr: '执行参数必须是 JSON 数组。',
    argsCountErr: '此模板需要 {count} 个参数，顺序为：{params}。',
    invalidFactErr: '服务端未返回有效的当前事实结果。',
    resultAria: '数据库当前事实结果',
    resultTitle: '当前事实 · 查询时点结果',
    resultHint: '这些结果只描述当前查询事实，不作为企业制度或规则知识保存。',
    queriedAt: '查询时间',
    queryScope: '查询范围',
    schemaVersion: '结构版本',
    rowCount: '返回行数',
    checkingFresh: '正在核对来源数据…',
    checkFreshBtn: '核对事实是否仍有效',
    freshOk: '已核对来源数据，当前事实仍有效。',
    freshStale: '来源数据已变化或无法核实，结果已过期，请重新查询',
    freshStaleDetail: '来源数据已变化或无法核实，结果已过期，请重新查询。{msg}',
    rowsSummaryTruncated: '显示 {rows} 行、{cols} 列。结果较多，当前页面仅展示前 100 行、30 列；单元格最多显示 500 个字符。',
    rowsSummary: '显示 {rows} 行、{cols} 列。单元格最多显示 500 个字符。',
    tableAria: '可横向滚动的查询结果',
    emptyRows: '本次查询没有返回记录。',
  },
} satisfies Dict<string>;

function displayValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (value === undefined) return '—';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

/** The server approves templates and runs read-only queries; this panel never executes raw editor SQL. */
export function DatabaseSourcePanel({ resources, connections, onRefresh, pluginEnabled = true }: DatabaseSourcePanelProps) {
  const t = useT(TEXT);
  const message = (error: unknown) => error instanceof Error ? error.message : t('reqFailed');

  async function request<T>(path: string, body?: unknown): Promise<T> {
    const response = await api<T & { message?: string; error?: string }>(ROOT + path,
      body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(response.body.message ?? response.body.error ?? t('reqFailedHttp', { status: response.status }));
    }
    return response.body;
  }

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
      setName(''); setReadOnlyAcknowledged(false); setNotice(t('createSuccess'));
      try { await onRefresh(); } catch (caught) { setError(t('refreshFailed', { msg: message(caught) })); }
    } catch (caught) { setError(message(caught)); }
    finally { mutationActive.current = false; setBusy(''); }
  }

  async function approveTemplate(event: FormEvent) {
    event.preventDefault();
    if (!selectedConnectionId || mutationActive.current) return;
    setError(''); setNotice('');
    const params = parameterNames.trim() ? parameterNames.split(',').map(value => value.trim()) : [];
    if (params.some(value => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) || new Set(params).size !== params.length) {
      setError(t('paramErr')); return;
    }
    if (!/^select\b/i.test(sql.trim())) { setError(t('selectErr')); return; }
    const capturedConnection = selectedConnectionId;
    const sequence = requestSequence.current;
    mutationActive.current = true; setBusy('approve'); setFact(null);
    try {
      const saved = await request<{ id: string }>(`/connections/${encodeURIComponent(capturedConnection)}/templates`, { sql: sql.trim(), params });
      if (sequence === requestSequence.current) {
        setTemplateId(saved.id); setNotice(t('approveSuccess', { id: saved.id }));
        setSql(''); setParameterNames(''); setReload(value => value + 1);
      }
    } catch (caught) { if (sequence === requestSequence.current) setError(message(caught)); }
    finally { mutationActive.current = false; setBusy(''); }
  }
  async function syncStructure() {
    if (!selectedConnectionId || mutationActive.current) return;
    mutationActive.current = true; setBusy('sync'); setError(''); setNotice(''); setFact(null);
    try { const result = await request<{ error?: string }>(`/connections/${encodeURIComponent(selectedConnectionId)}/sync`, {}); if (result.error) throw Error(result.error); await onRefresh(); setNotice(t('syncSuccess')); }
    catch (caught) { setError(message(caught)); }
    finally { mutationActive.current = false; setBusy(''); }
  }

  async function runTemplate(event: FormEvent) {
    event.preventDefault();
    if (!selectedConnectionId || !selectedTemplate?.approvedBy || mutationActive.current) return;
    setError(''); setNotice(''); setFact(null);
    let args: unknown;
    try { args = JSON.parse(argsText) as unknown; } catch { setError(t('argsJsonErr')); return; }
    if (!Array.isArray(args)) { setError(t('argsArrayErr')); return; }
    if (args.length !== selectedTemplate.params.length) { setError(t('argsCountErr', { count: selectedTemplate.params.length, params: selectedTemplate.params.join(', ') || t('noParams') })); return; }
    const sequence = requestSequence.current;
    mutationActive.current = true; setBusy('query');
    try {
      const result = await request<CurrentFact>(`/connections/${encodeURIComponent(selectedConnectionId)}/query`, { templateId: selectedTemplate.id, args });
      if (result.kind !== 'current_fact' || !Array.isArray(result.rows)) throw new Error(t('invalidFactErr'));
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
      if (result.fresh) setNotice(t('freshOk'));
      else { setFact(null); setError(t('freshStale')); }
    } catch (caught) {
      if (sequence === requestSequence.current) { setFact(null); setError(t('freshStaleDetail', { msg: message(caught) })); }
    } finally { mutationActive.current = false; setBusy(''); }
  }

  const rows = fact?.rows.slice(0, MAX_DISPLAY_ROWS) ?? [];
  const allColumns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const columns = allColumns.slice(0, MAX_DISPLAY_COLUMNS);

  return <section className="panel database-source" aria-labelledby="database-source-heading">
    <header className="database-source-head"><div><span className="database-source-eyebrow">{t('eyebrow')}</span><h2 id="database-source-heading">{t('heading')}</h2></div><span className="database-source-tag">{t('tag')}</span></header>
    <p className="helper">{t('intro1')}</p>
    <p className="helper">{t('intro2')}</p>
    {error ? <p className="database-source-error" role="alert">{error}</p> : null}
    {notice ? <p className="database-source-notice" role="status">{notice}</p> : null}
    {!pluginEnabled ? <p className="database-source-empty">{t('noPlugin')}</p> : !resources.length ? <p className="database-source-empty">{t('noResources')}</p> : <>
      <form className="database-source-form database-source-inset" onSubmit={createConnection}>
        <h3>{t('createTitle')}</h3>
        <label className="field"><span>{t('dbaResource')}</span><select value={selectedResource?.id ?? ''} disabled={!!busy} onChange={event => { setResourceId(event.target.value); setReadOnlyAcknowledged(false); }}>{resources.map(resource => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select></label>
        {selectedResource ? <div className="database-source-scope"><p>{t('maxRows', { maxRows: selectedResource.maxRows, id: selectedResource.id })}</p><ul>{Object.entries(selectedResource.tables).map(([table, spec]) => <li key={table}><strong>{table}</strong><span>{spec.columns.join(', ') || t('noReadableCols')}</span>{spec.sensitive?.length ? <small>{t('sensitiveCols', { cols: spec.sensitive.join(', ') })}</small> : null}</li>)}</ul></div> : null}
        <label className="field"><span>{t('connName')}</span><input required maxLength={160} value={name} onChange={event => setName(event.target.value)} placeholder={t('connNamePlaceholder')} /></label>
        <label className="database-source-check"><input type="checkbox" required checked={readOnlyAcknowledged} onChange={event => setReadOnlyAcknowledged(event.target.checked)} /><span>{t('ackLabel')}</span></label>
        <button className="btn" disabled={!!busy || !name.trim() || !selectedResource || !readOnlyAcknowledged}>{busy === 'create' ? t('creating') : t('createBtn')}</button>
      </form>
    </>}

    <div className="database-source-inset">
      <label className="field"><span>{t('confirmedConn')}</span><select value={selectedConnectionId} disabled={!!busy || !confirmed.length} onChange={event => { setConnectionId(event.target.value); setTemplateId(''); setNotice(''); }}>
        {!confirmed.length ? <option value="">{t('noConfirmedConn')}</option> : confirmed.map(connection => <option key={connection.id} value={connection.id}>{connection.name}</option>)}
      </select></label>
      <button className="btn" type="button" disabled={!!busy || !selectedConnectionId} onClick={() => void syncStructure()}>{busy === 'sync' ? t('syncing') : t('syncBtn')}</button>
      <p className="helper">{t('syncHint')}</p>
      {!selectedConnectionId ? <p className="database-source-empty">{t('needConnHint')}</p> : <div className="database-source-grid">
        <form className="database-source-form" onSubmit={approveTemplate}>
          <h3>{t('approveTitle')}</h3>
          <label className="field"><span>{t('sqlLabel')}</span><textarea required rows={5} maxLength={8000} spellCheck={false} value={sql} onChange={event => setSql(event.target.value)} placeholder={t('sqlPlaceholder')} /></label>
          <label className="field"><span>{t('paramsLabel')}</span><input maxLength={2000} value={parameterNames} onChange={event => setParameterNames(event.target.value)} placeholder={t('paramsPlaceholder')} /></label>
          <p className="helper">{t('approveHint')}</p>
          <button className="btn" disabled={!!busy || !sql.trim()}>{busy === 'approve' ? t('approving') : t('approveBtn')}</button>
        </form>

        <form className="database-source-form" onSubmit={runTemplate}>
          <h3>{t('runTitle')}</h3>
          <label className="field"><span>{t('approvedTplLabel')}</span><select value={selectedTemplate?.id ?? ''} disabled={!!busy || loadingTemplates || !templates.length} onChange={event => { setTemplateId(event.target.value); setFact(null); setArgsText('[]'); }}>
            {!templates.length ? <option value="">{loadingTemplates ? t('loadingTpls') : t('noTpls')}</option> : templates.map(template => <option key={template.id} value={template.id}>{template.id}</option>)}
          </select></label>
          {templateError ? <div className="database-source-error" role="alert">{templateError}<button type="button" className="btn" disabled={!!busy || loadingTemplates} onClick={() => setReload(value => value + 1)}>{t('reloadTpls')}</button></div> : null}
          {selectedTemplate ? <div className="database-source-template"><pre>{selectedTemplate.sql}</pre><p className="helper">{t('approvedBy', { by: selectedTemplate.approvedBy || t('unapproved'), params: selectedTemplate.params.join(', ') || t('noParams') })}</p></div> : null}
          <label className="field"><span>{t('argsLabel')}</span><textarea required rows={2} maxLength={20000} spellCheck={false} value={argsText} onChange={event => setArgsText(event.target.value)} placeholder='["active", 2026]' /></label>
          <button className="btn" disabled={!!busy || loadingTemplates || !selectedTemplate?.approvedBy}>{busy === 'query' ? t('querying') : t('runBtn')}</button>
        </form>
      </div>}
    </div>

    {fact ? <section className="database-source-result" aria-label={t('resultAria')} aria-live="polite">
      <h3>{t('resultTitle')}</h3><p className="helper">{t('resultHint')}</p>
      <dl><div><dt>{t('queriedAt')}</dt><dd>{fact.queriedAt}</dd></div><div><dt>{t('queryScope')}</dt><dd>{displayValue(fact.scope)}</dd></div><div><dt>{t('schemaVersion')}</dt><dd>{fact.schemaVersion}</dd></div><div><dt>{t('rowCount')}</dt><dd>{fact.rowCount}</dd></div></dl>
      <button className="btn" type="button" disabled={!!busy} onClick={() => void checkFreshness()}>{busy === 'freshness' ? t('checkingFresh') : t('checkFreshBtn')}</button>
      {rows.length ? <><p className="helper">{t(fact.rows.length > MAX_DISPLAY_ROWS || allColumns.length > MAX_DISPLAY_COLUMNS ? 'rowsSummaryTruncated' : 'rowsSummary', { rows: rows.length, cols: columns.length })}</p><div className="database-source-table-scroll" tabIndex={0} aria-label={t('tableAria')}><table><thead><tr>{columns.map(column => <th key={column} scope="col">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => <td key={column}>{displayValue(row[column])}</td>)}</tr>)}</tbody></table></div></> : <p className="database-source-empty">{t('emptyRows')}</p>}
    </section> : null}
  </section>;
}
