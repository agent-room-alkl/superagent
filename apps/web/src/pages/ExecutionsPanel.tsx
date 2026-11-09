import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

/** SOP runs (T-56): manual trigger for the published version and the record of every run with its steps. */
interface Step {
  nodeId: string;
  kind: string;
  label: string;
  status: 'pending' | 'done' | 'waiting_human' | 'blocked' | 'outcome_unknown';
  detail: string | null;
  workItemId: string | null;
  readback: unknown | null;
}
export interface ExecutionView {
  id: string;
  versionNumber: number;
  eventId: string;
  status: 'running' | 'waiting_human' | 'completed' | 'blocked' | 'outcome_unknown';
  steps: Step[];
  exceptionItemId: string | null;
}

const RUN_LABEL: Record<ExecutionView['status'], string> = { running: '运行中', waiting_human: '等待人工', completed: '已完成', blocked: '已阻塞', outcome_unknown: '结果未知（已冻结）' };
const STEP_LABEL: Record<Step['status'], string> = { pending: '未开始', done: '完成', waiting_human: '等待人工', blocked: '阻塞', outcome_unknown: '结果未知' };

export function ExecutionsPanel({ sopId, publishedVersionId }: { sopId: string; publishedVersionId: string | null }) {
  const [runs, setRuns] = useState<ExecutionView[]>([]);
  const [eventId, setEventId] = useState('');
  const [input, setInput] = useState('{\n  \n}');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const r = await api<{ executions?: ExecutionView[] }>(`/api/v1/executions?sopId=${encodeURIComponent(sopId)}`);
    setRuns(r.status === 200 ? [...(r.body.executions ?? [])].reverse() : []);
  }, [sopId]);
  useEffect(() => void load(), [load]);

  async function trigger(e: FormEvent) {
    e.preventDefault();
    let data: unknown;
    try {
      data = JSON.parse(input);
    } catch {
      setMsg('输入数据不是有效的 JSON');
      return;
    }
    const r = await api<ExecutionView & { message?: string }>('/api/v1/executions', { method: 'POST', body: JSON.stringify({ versionId: publishedVersionId, eventId: eventId.trim(), input: data }) });
    setMsg(r.status === 201 ? `已触发运行 ${r.body.id}：${RUN_LABEL[r.body.status]}` : `未触发：${r.body.message ?? r.status}`);
    await load();
  }

  return (
    <section className="panel stack" aria-label="运行记录">
      <h2 className="h2">运行记录</h2>
      <form className="stack" onSubmit={trigger} aria-label="手动触发">
        <label className="field">
          <span>事件编号（同一事件只会开一次实例）</span>
          <input aria-label="事件编号" value={eventId} onChange={(e) => setEventId(e.target.value)} required />
        </label>
        <label className="field">
          <span>输入数据（JSON）</span>
          <textarea aria-label="输入数据" rows={4} value={input} onChange={(e) => setInput(e.target.value)} />
        </label>
        <button className="btn" type="submit" disabled={!publishedVersionId}>按已发布版本触发</button>
        {!publishedVersionId ? <p className="helper">还没有已发布版本。</p> : null}
        <button className="btn" type="button" onClick={() => void load()}>刷新</button>
      </form>
      {msg ? <p className="helper" role="status" aria-label="触发结果">{msg}</p> : null}
      {!runs.length ? <p className="helper">还没有运行。</p> : null}
      <ul className="onto-list">
        {runs.map((r) => (
          <li key={r.id} data-run={r.id}>
            <strong>{r.id}</strong> · 事件 {r.eventId} · v{r.versionNumber} · <span data-run-status={r.status}>{RUN_LABEL[r.status]}</span>
            {r.exceptionItemId ? <> · <a href="#work">例外事项 {r.exceptionItemId}</a></> : null}
            <ol className="run-steps">
              {r.steps.map((s) => (
                <li key={s.nodeId} data-step={s.nodeId} data-step-status={s.status}>
                  {s.label}：{STEP_LABEL[s.status]}{s.detail ? `（${s.detail}）` : ''}
                  {s.workItemId && s.status === 'waiting_human' ? <> · <a href="#work">去待我处理</a></> : null}
                  {s.readback ? <code className="readback">回读 {JSON.stringify(s.readback)}</code> : null}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ul>
    </section>
  );
}
