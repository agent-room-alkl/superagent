import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useLang, useT, type Dict } from '../i18n';
import './ToolsPage.css';

type Stage = 'placeholder' | 'acquire' | 'test' | 'release' | 'deploy' | 'install' | 'available';
type CatalogStatus = 'available' | 'installed' | 'coming_soon';

interface ToolView {
  toolId: string;
  name: string;
  state: string;
  activeVersion: string | null;
  releases: { version: string; healthy: boolean | null }[];
  progress: { done: Stage[]; current: Stage; blocker?: string };
}

interface CatalogTool {
  toolId: string;
  name: { en: string; zh: string };
  summary: { en: string; zh: string };
  effect: 'read' | 'write' | 'external';
  capability: string | null;
  installable: boolean;
  status: CatalogStatus;
  installedEmployees: string[];
}

interface EmployeeSummary {
  id: string;
  name: string;
  duty: string;
  status: string;
}

type TextKey =
  | 'page.title'
  | 'page.subtitle'
  | 'store.title'
  | 'store.subtitle'
  | 'store.filterLabel'
  | 'store.allEmployees'
  | 'store.status.available'
  | 'store.status.installed'
  | 'store.status.coming_soon'
  | 'store.installedOn'
  | 'store.installBtn'
  | 'store.comingSoonBtn'
  | 'store.pickEmployee'
  | 'store.confirmInstall'
  | 'store.cancel'
  | 'store.noEmployees'
  | 'store.installSuccess'
  | 'store.installFailed'
  | 'custom.title'
  | 'custom.subtitle'
  | 'custom.empty'
  | 'custom.listLabel'
  | 'custom.compactLabel'
  | 'custom.toolIdLabel'
  | 'custom.toolIdPlaceholder'
  | 'custom.openBtn'
  | 'custom.notFound'
  | 'custom.activeVersion'
  | 'custom.releases'
  | 'custom.none'
  | 'custom.deployFailed'
  | 'progress.label'
  | 'progress.done'
  | 'progress.current'
  | 'progress.todo'
  | 'progress.ready'
  | 'progress.blocker'
  | 'step.placeholder'
  | 'step.acquire'
  | 'step.test'
  | 'step.release'
  | 'step.deploy'
  | 'step.install'
  | 'step.available';

const TEXT: Dict<TextKey> = {
  en: {
    'page.title': 'Employee tools',
    'page.subtitle': 'Install preset capabilities for employees or inspect custom tool lifecycles',
    'store.title': 'Tool store',
    'store.subtitle': 'Preset tools backed by verified server capabilities. External write connectors are marked coming soon.',
    'store.filterLabel': 'View for employee',
    'store.allEmployees': 'All employees',
    'store.status.available': 'Ready to install',
    'store.status.installed': 'Installed',
    'store.status.coming_soon': 'Coming soon',
    'store.installedOn': 'Installed for: {names}',
    'store.installBtn': 'Install to employee',
    'store.comingSoonBtn': 'Coming soon',
    'store.pickEmployee': 'Select employee',
    'store.confirmInstall': 'Confirm install',
    'store.cancel': 'Cancel',
    'store.noEmployees': 'No digital employees yet. Create an employee first before installing tools.',
    'store.installSuccess': 'Installed {tool} for {employee}.',
    'store.installFailed': 'Install failed: {reason}',
    'custom.title': 'Custom tools',
    'custom.subtitle': 'One card per tool: Placeholder → Acquire → Test → Release → Deploy → Install → Available',
    'custom.empty': 'No tools yet.',
    'custom.listLabel': 'Tool list',
    'custom.compactLabel': 'Compact progress',
    'custom.toolIdLabel': 'Tool ID',
    'custom.toolIdPlaceholder': 'e.g. invoice.lookup',
    'custom.openBtn': 'Open tool card',
    'custom.notFound': 'Not found',
    'custom.activeVersion': 'Active version: {version}; Releases: {releases}',
    'custom.releases': 'Releases',
    'custom.none': 'None',
    'custom.deployFailed': ' (deploy failed)',
    'progress.label': 'Tool progress',
    'progress.done': 'Done',
    'progress.current': 'Current',
    'progress.todo': 'Not started',
    'progress.ready': 'Ready: available for the primary employee',
    'progress.blocker': 'Blocker: {blocker}',
    'step.placeholder': 'Placeholder',
    'step.acquire': 'Acquire',
    'step.test': 'Test',
    'step.release': 'Release',
    'step.deploy': 'Deploy',
    'step.install': 'Install',
    'step.available': 'Available',
  },
  zh: {
    'page.title': '员工工具',
    'page.subtitle': '为数字员工安装预置能力，或管理自建工具的 7 步生命周期',
    'store.title': '工具商店',
    'store.subtitle': '仅对后端已实现的真实能力开放安装，未接入的外部写连接器标注为“即将提供”。',
    'store.filterLabel': '按员工查看',
    'store.allEmployees': '全部员工',
    'store.status.available': '待安装',
    'store.status.installed': '已安装',
    'store.status.coming_soon': '即将提供',
    'store.installedOn': '已安装给：{names}',
    'store.installBtn': '安装到员工',
    'store.comingSoonBtn': '即将提供',
    'store.pickEmployee': '选择员工',
    'store.confirmInstall': '确认安装',
    'store.cancel': '取消',
    'store.noEmployees': '暂无数字员工，请先创建数字员工后再安装工具。',
    'store.installSuccess': '已将 {tool} 安装给 {employee}。',
    'store.installFailed': '安装失败：{reason}',
    'custom.title': '自定义工具',
    'custom.subtitle': '每个工具一张卡：占位 → 获取 → 测试 → 发布 → 部署 → 安装 → 可用',
    'custom.empty': '还没有工具。',
    'custom.listLabel': '工具列表',
    'custom.compactLabel': '紧凑进度',
    'custom.toolIdLabel': '工具 ID',
    'custom.toolIdPlaceholder': '例如 invoice.lookup',
    'custom.openBtn': '打开工具卡',
    'custom.notFound': '未找到',
    'custom.activeVersion': '当前版本：{version}；已发布：{releases}',
    'custom.releases': '已发布',
    'custom.none': '无',
    'custom.deployFailed': '（部署失败）',
    'progress.label': '工具进度',
    'progress.done': '已完成',
    'progress.current': '当前',
    'progress.todo': '未开始',
    'progress.ready': '就绪：主要使用员工可用',
    'progress.blocker': '卡点：{blocker}',
    'step.placeholder': '占位',
    'step.acquire': '获取',
    'step.test': '测试',
    'step.release': '发布',
    'step.deploy': '部署',
    'step.install': '安装',
    'step.available': '可用',
  },
};

const STEP_IDS: Stage[] = ['placeholder', 'acquire', 'test', 'release', 'deploy', 'install', 'available'];

/** The list endpoint only returns the current stage. Steps before it are done; available means all seven are done. */
function progressFromStage(stage: Stage): ToolView['progress'] {
  if (stage === 'available') return { done: [...STEP_IDS], current: 'available' };
  const index = STEP_IDS.indexOf(stage);
  const at = index < 0 ? 0 : index;
  return { done: STEP_IDS.slice(0, at), current: STEP_IDS[at] ?? 'placeholder' };
}

/** Tool card progress (accepted in T-32): done ✓ / current (highlighted, with blocker) / not started. */
export function ToolProgress({ p, label }: { p: ToolView['progress']; label?: string }) {
  const t = useT(TEXT);
  const allDone = p.done.length === STEP_IDS.length;
  return (
    <div>
      <ol className="steps" aria-label={label ?? t('progress.label')}>
        {STEP_IDS.map((id, i) => {
          const done = p.done.includes(id);
          const current = !allDone && p.current === id;
          return (
            <li key={id} className={done ? 'done' : current ? 'current' : 'todo'} aria-current={current ? 'step' : undefined}>
              <span className="mark">{done ? '✓' : i + 1}</span>
              <span>{t(`step.${id}`)}</span>
              <small>{done ? t('progress.done') : current ? t('progress.current') : t('progress.todo')}</small>
            </li>
          );
        })}
      </ol>
      {allDone ? (
        <p className="helper">{t('progress.ready')}</p>
      ) : p.blocker ? (
        <p className="warn">{t('progress.blocker', { blocker: p.blocker })}</p>
      ) : null}
    </div>
  );
}

function initialEmployeeId(): string {
  if (typeof window === 'undefined') return '';
  const hashQuery = window.location.hash.includes('?') ? window.location.hash.slice(window.location.hash.indexOf('?')) : '';
  const params = new URLSearchParams(hashQuery || window.location.search);
  return params.get('employeeId')?.trim() ?? '';
}

export function ToolsPage() {
  const [lang] = useLang();
  const t = useT(TEXT);

  const [selectedEmpId, setSelectedEmpId] = useState<string>(initialEmployeeId);
  const [employees, setEmployees] = useState<EmployeeSummary[]>([]);
  const [catalog, setCatalog] = useState<CatalogTool[]>([]);
  const [installingToolId, setInstallingToolId] = useState<string | null>(null);
  const [targetEmpId, setTargetEmpId] = useState<string>('');
  const [storeNotice, setStoreNotice] = useState<string>('');
  const [busyInstall, setBusyInstall] = useState(false);

  const [toolId, setToolId] = useState('');
  const [tool, setTool] = useState<ToolView | null>(null);
  const [tools, setTools] = useState<{ toolId: string; name: string; stage: Stage }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState('');

  function queryFor(empId: string): string {
    return empId ? `?employeeId=${encodeURIComponent(empId)}` : '';
  }

  async function refreshAll(empId: string) {
    const suffix = queryFor(empId);
    const [toolsRes, catalogRes, empRes] = await Promise.all([
      api<{ toolId: string; name: string; stage: Stage }[]>(`/api/v1/tools/${suffix}`),
      api<{ tools?: CatalogTool[] }>(`/api/v1/tools/catalog${suffix}`),
      api<EmployeeSummary[]>('/api/v1/employees/'),
    ]);
    setTools(toolsRes.status === 200 && Array.isArray(toolsRes.body) ? toolsRes.body : []);
    setCatalog(catalogRes.status === 200 && Array.isArray(catalogRes.body?.tools) ? catalogRes.body.tools : []);
    const empList = empRes.status === 200 && Array.isArray(empRes.body) ? empRes.body : [];
    setEmployees(empList);
    if (!targetEmpId && empList[0]) setTargetEmpId(empList[0].id);
    setLoaded(true);
  }

  useEffect(() => {
    let cancelled = false;
    const suffix = queryFor(selectedEmpId);
    void Promise.all([
      api<{ toolId: string; name: string; stage: Stage }[]>(`/api/v1/tools/${suffix}`),
      api<{ tools?: CatalogTool[] }>(`/api/v1/tools/catalog${suffix}`),
      api<EmployeeSummary[]>('/api/v1/employees/'),
    ]).then(([toolsRes, catalogRes, empRes]) => {
      if (cancelled) return;
      setTools(toolsRes.status === 200 && Array.isArray(toolsRes.body) ? toolsRes.body : []);
      setCatalog(catalogRes.status === 200 && Array.isArray(catalogRes.body?.tools) ? catalogRes.body.tools : []);
      const empList = empRes.status === 200 && Array.isArray(empRes.body) ? empRes.body : [];
      setEmployees(empList);
      setTargetEmpId((prev) => prev || empList[0]?.id || '');
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedEmpId]);

  function startInstall(item: CatalogTool) {
    setStoreNotice('');
    setInstallingToolId(item.toolId);
    if (selectedEmpId) {
      setTargetEmpId(selectedEmpId);
    } else if (!targetEmpId && employees[0]) {
      setTargetEmpId(employees[0].id);
    }
  }

  async function confirmInstall(item: CatalogTool) {
    if (!targetEmpId) return;
    setBusyInstall(true);
    setStoreNotice('');
    const r = await api<{ installed?: boolean; message?: string }>(
      `/api/v1/tools/catalog/${encodeURIComponent(item.toolId)}/install`,
      { method: 'POST', body: JSON.stringify({ employeeId: targetEmpId }) },
    );
    setBusyInstall(false);
    if (r.status === 200 && r.body?.installed) {
      const empName = employees.find((e) => e.id === targetEmpId)?.name ?? targetEmpId;
      setStoreNotice(t('store.installSuccess', { tool: item.name[lang], employee: empName }));
      setInstallingToolId(null);
      await refreshAll(selectedEmpId);
    } else {
      setStoreNotice(t('store.installFailed', { reason: r.body?.message ?? String(r.status) }));
    }
  }

  async function open(id: string) {
    setToolId(id);
    const r = await api<ToolView & { message?: string }>(`/api/v1/tools/${encodeURIComponent(id)}${queryFor(selectedEmpId)}`);
    if (r.status === 200) {
      setTool(r.body);
      setMsg('');
    } else {
      setTool(null);
      setMsg(r.body.message ?? t('custom.notFound'));
    }
  }

  async function load(e?: FormEvent) {
    e?.preventDefault();
    await open(toolId);
  }

  function employeeNames(ids: string[]): string {
    return ids.map((id) => employees.find((e) => e.id === id)?.name ?? id).join(', ');
  }

  return (
    <>
      <div className="page-head">
        <h1>{t('page.title')}</h1>
        <p>{t('page.subtitle')}</p>
      </div>

      <section className="tool-store-section" aria-label={t('store.title')}>
        <div className="tool-store-head">
          <div>
            <h3 className="h2">{t('store.title')}</h3>
            <p className="helper">{t('store.subtitle')}</p>
          </div>
          {employees.length > 0 ? (
            <label className="tool-store-filter">
              <span>{t('store.filterLabel')}</span>
              <select value={selectedEmpId} onChange={(e) => setSelectedEmpId(e.target.value)}>
                <option value="">{t('store.allEmployees')}</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>
                    {emp.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>

        {storeNotice ? <p className="helper" role="status">{storeNotice}</p> : null}

        <div className="tool-store-grid">
          {catalog.map((item) => {
            const picking = installingToolId === item.toolId;
            return (
              <article key={item.toolId} className="tool-card">
                <div className="stack" style={{ marginBottom: 0 }}>
                  <div className="tool-card-top">
                    <div>
                      <h4 className="tool-card-title">{item.name[lang]}</h4>
                      <span className="tool-card-id">{item.toolId}</span>
                    </div>
                    <span className={`tool-badge ${item.status}`}>{t(`store.status.${item.status}`)}</span>
                  </div>
                  <p className="tool-card-summary">{item.summary[lang]}</p>
                  {item.installedEmployees.length > 0 ? (
                    <p className="helper">{t('store.installedOn', { names: employeeNames(item.installedEmployees) })}</p>
                  ) : null}
                </div>

                <div className="tool-card-actions">
                  {!item.installable ? (
                    <button className="btn" type="button" disabled>
                      {t('store.comingSoonBtn')}
                    </button>
                  ) : !picking ? (
                    <button className="btn primary" type="button" onClick={() => startInstall(item)}>
                      {t('store.installBtn')}
                    </button>
                  ) : (
                    <div className="tool-install-picker">
                      {employees.length === 0 ? (
                        <>
                          <p className="warn">{t('store.noEmployees')}</p>
                          <button className="btn" type="button" onClick={() => setInstallingToolId(null)}>
                            {t('store.cancel')}
                          </button>
                        </>
                      ) : (
                        <>
                          <label className="field">
                            <span>{t('store.pickEmployee')}</span>
                            <select value={targetEmpId} onChange={(e) => setTargetEmpId(e.target.value)}>
                              {employees.map((emp) => (
                                <option key={emp.id} value={emp.id}>
                                  {emp.name}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="tool-install-row">
                            <button className="btn primary" type="button" disabled={busyInstall || !targetEmpId} onClick={() => void confirmInstall(item)}>
                              {t('store.confirmInstall')}
                            </button>
                            <button className="btn" type="button" onClick={() => setInstallingToolId(null)}>
                              {t('store.cancel')}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="tool-custom-section" aria-label={t('custom.title')}>
        <div>
          <h3 className="h2">{t('custom.title')}</h3>
          <p className="helper">{t('custom.subtitle')}</p>
        </div>

        {loaded && tools.length === 0 ? <p>{t('custom.empty')}</p> : null}
        {tools.length > 0 ? (
          <ul className="tool-list" aria-label={t('custom.listLabel')}>
            {tools.map((item) => (
              <li key={item.toolId}>
                <button className="btn" type="button" onClick={() => void open(item.toolId)}>
                  {item.name} · {item.toolId}
                </button>
                <ToolProgress p={progressFromStage(item.stage)} label={t('custom.compactLabel')} />
              </li>
            ))}
          </ul>
        ) : null}

        <form className="panel stack" onSubmit={load}>
          <label className="field">
            <span>{t('custom.toolIdLabel')}</span>
            <input value={toolId} onChange={(e) => setToolId(e.target.value)} placeholder={t('custom.toolIdPlaceholder')} />
          </label>
          <button className="btn" type="submit">
            {t('custom.openBtn')}
          </button>
          {msg ? <p className="helper">{msg}</p> : null}
        </form>

        {tool ? (
          <section className="panel stack">
            <h2 className="h2">
              {tool.name} · {tool.toolId}
            </h2>
            <ToolProgress p={tool.progress} />
            <p className="helper">
              {t('custom.activeVersion', {
                version: tool.activeVersion ?? t('custom.none'),
                releases:
                  tool.releases
                    .map((r) => `${r.version}${r.healthy === false ? t('custom.deployFailed') : ''}`)
                    .join(', ') || t('custom.none'),
              })}
            </p>
          </section>
        ) : null}
      </section>
    </>
  );
}
