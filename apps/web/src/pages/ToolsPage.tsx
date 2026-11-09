import { useState, type FormEvent } from 'react';
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

/** Tool card progress (accepted in T-32): done ✓ / current (highlighted, with blocker) / not started. */
export function ToolProgress({ p }: { p: ToolView['progress'] }) {
  const allDone = p.done.length === STEPS.length;
  return (
    <div>
      <ol className="steps" aria-label="工具进度">
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
  const [msg, setMsg] = useState('');

  async function load(e?: FormEvent) {
    e?.preventDefault();
    const r = await api<ToolView & { message?: string }>(`/api/v1/tools/${encodeURIComponent(toolId)}`);
    if (r.status === 200) {
      setTool(r.body);
      setMsg('');
    } else {
      setTool(null);
      setMsg(r.body.message ?? '未找到');
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>员工工具</h1>
        <p>每个工具一张卡：占位 → 获取 → 测试 → 发布 → 部署 → 安装 → 可用</p>
      </div>
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
