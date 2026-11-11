import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

type Stage = 'placeholder' | 'acquire' | 'test' | 'release' | 'deploy' | 'install' | 'available';
interface ToolView {
  toolId: string;
  name: string;
  state: string;
  activeVersion: string | null;
  releases: { version: string; healthy: boolean | null }[];
  progress: { done: Stage[]; current: Stage; blocker?: string };
}

const STEPS: { id: Stage; label: string }[] = [
  { id: 'placeholder', label: '占位' },
  { id: 'acquire', label: '获取' },
  { id: 'test', label: '测试' },
  { id: 'release', label: '发布' },
  { id: 'deploy', label: '部署' },
  { id: 'install', label: '安装' },
  { id: 'available', label: '可用' },
];

/** The list endpoint only returns the current stage. Steps before it are done; available means all seven are done. */
function progressFromStage(stage: Stage): ToolView['progress'] {
  if (stage === 'available') return { done: STEPS.map((step) => step.id), current: 'available' };
  const index = STEPS.findIndex((step) => step.id === stage);
  const at = index < 0 ? 0 : index;
  return { done: STEPS.slice(0, at).map((step) => step.id), current: STEPS[at]?.id ?? 'placeholder' };
}

/** Tool card progress (accepted in T-32): done ✓ / current (highlighted, with blocker) / not started. */
export function ToolProgress({ p, label = '工具进度' }: { p: ToolView['progress']; label?: string }) {
  const allDone = p.done.length === STEPS.length;
  return (
    <div>
      <ol className="steps" aria-label={label}>
        {STEPS.map((s, i) => {
          const done = p.done.includes(s.id);
          const current = !allDone && p.current === s.id;
          return (
            <li key={s.id} className={done ? 'done' : current ? 'current' : 'todo'} aria-current={current ? 'step' : undefined}>
              <span className="mark">{done ? '✓' : i + 1}</span>
              <span>{s.label}</span>
              <small>{done ? '已完成' : current ? '当前' : '未开始'}</small>
            </li>
          );
        })}
      </ol>
      {allDone ? <p className="helper">就绪：主要使用员工可用</p> : p.blocker ? <p className="warn">卡点：{p.blocker}</p> : null}
    </div>
  );
}

export function ToolsPage() {
  const [toolId, setToolId] = useState('');
  const [tool, setTool] = useState<ToolView | null>(null);
  const [tools, setTools] = useState<{ toolId: string; name: string; stage: Stage }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    void api<{ toolId: string; name: string; stage: Stage }[]>('/api/v1/tools/').then((r) => {
      if (cancelled) return;
      setTools(r.status === 200 && Array.isArray(r.body) ? r.body : []);
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, []);

  async function open(id: string) {
    setToolId(id);
    const r = await api<ToolView & { message?: string }>(`/api/v1/tools/${encodeURIComponent(id)}`);
    if (r.status === 200) {
      setTool(r.body);
      setMsg('');
    } else {
      setTool(null);
      setMsg(r.body.message ?? '未找到');
    }
  }

  async function load(e?: FormEvent) {
    e?.preventDefault();
    await open(toolId);
  }

  return (
    <>
      <div className="page-head">
        <h1>员工工具</h1>
        <p>每个工具一张卡：占位 → 获取 → 测试 → 发布 → 部署 → 安装 → 可用</p>
      </div>
      {loaded && tools.length === 0 ? <p>还没有工具。</p> : null}
      {tools.length > 0 ? (
        <ul className="tool-list" aria-label="工具列表">
          {tools.map((item) => (
            <li key={item.toolId}>
              <button className="btn" type="button" onClick={() => void open(item.toolId)}>{item.name} · {item.toolId}</button>
              <ToolProgress p={progressFromStage(item.stage)} label="紧凑进度" />
            </li>
          ))}
        </ul>
      ) : null}
      <form className="panel stack" onSubmit={load}>
        <label className="field">
          <span>工具 ID</span>
          <input value={toolId} onChange={(e) => setToolId(e.target.value)} placeholder="例如 invoice.lookup" />
        </label>
        <button className="btn" type="submit">打开工具卡</button>
        {msg ? <p className="helper">{msg}</p> : null}
      </form>
      {tool ? (
        <section className="panel stack">
          <h2 className="h2">{tool.name} · {tool.toolId}</h2>
          <ToolProgress p={tool.progress} />
          <p className="helper">
            当前版本：{tool.activeVersion ?? '无'}；已发布：{tool.releases.map((r) => `${r.version}${r.healthy === false ? '（部署失败）' : ''}`).join('，') || '无'}
          </p>
        </section>
      ) : null}
    </>
  );
}
