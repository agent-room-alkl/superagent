import { useEffect, useRef, useState } from 'react';
import './execution.css';

/**
 * Command room layout and copy from the accepted v12 prototype
 * (heading + 共享协作记录). Root stays fixed; the transcript and task list scroll.
 */
const TRANSCRIPT = [
  { id: 'm1', actor: '负责人', kind: '消息', body: '你好' },
  { id: 'm2', actor: '超级智能体', kind: '回复', body: '你好。需要派活时直接 @数字员工，并说清楚要做的事。' },
  { id: 'm3', actor: '负责人', kind: '派活', body: '@销售员工 整理询价草稿' },
  { id: 'm4', actor: '超级智能体', kind: '任务', body: '已交给 @销售员工：整理询价草稿' },
  { id: 'm5', actor: '销售员工', kind: '回报', body: '询价草稿已放在对话里' },
];

interface ApiMessage {
  id: string;
  seq: number;
  authorUserId: string;
  body: string;
  taskIds: string[];
}

function actorLabel(authorUserId: string): string {
  if (authorUserId === 'super-agent') return '超级智能体';
  if (authorUserId === 'user-sales') return '销售员工';
  if (authorUserId === 'user-ops') return '运营员工';
  return '负责人';
}

/** One-shot SSE body from GET /api/v1/room/stream. A broken frame is skipped. */
export function roomEventsFromSse(body: string): ApiMessage[] {
  return body.split('\n\n').flatMap((block) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (!data) return [];
    try {
      const message = JSON.parse(data) as ApiMessage;
      if (typeof message?.id !== 'string' || typeof message.body !== 'string') return [];
      return [message];
    } catch {
      return [];
    }
  });
}

export function nextRoomCursor(messages: readonly ApiMessage[], after: number): number {
  return messages.reduce((max, message) => (Number.isFinite(message.seq) ? Math.max(max, message.seq) : max), after);
}

interface ApiTask {
  id: string;
  title: string;
  status: string;
  assigneeUserId: string;
  waitingReason: string | null;
}

export function taskLine(task: ApiTask): string {
  const who = actorLabel(task.assigneeUserId);
  if (task.status === 'reported') return `已回报 · ${who}`;
  if (task.status === 'waiting') return `${task.waitingReason ?? '等待'} · ${who}`;
  return `进行中 · ${who}`;
}

/** Report as the task's assignee. A known id missing from this payload keeps the previous user. */
export function assigneeForReport(
  tasks: ReadonlyArray<Pick<ApiTask, 'id' | 'assigneeUserId'>>,
  currentId: string | null,
  fallbackUserId = 'user-sales',
): { taskId: string | null; userId: string } {
  const next = currentId ?? tasks.find((task) => task.assigneeUserId === 'user-sales')?.id ?? null;
  const listed = tasks.find((task) => task.id === next)?.assigneeUserId;
  return { taskId: next, userId: listed ?? (currentId ? fallbackUserId : 'user-sales') };
}

export function CommandRoomPage() {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState(TRANSCRIPT);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState('整理询价草稿');
  const [liveTasks, setLiveTasks] = useState<ApiTask[] | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [reportAs, setReportAs] = useState('user-sales');
  const taskIdRef = useRef<string | null>(null);
  const [pending, setPending] = useState<{ id: string; body: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [reporting, setReporting] = useState(false);
  const reportClientId = useRef<string | null>(null);
  const reportInFlight = useRef(false);
  const cursor = useRef(0);

  useEffect(() => {
    let stop = false;
    async function pull() {
      const after = cursor.current;
      try {
        const response = await fetch(`/api/v1/room/stream?roomId=room-1&after=${after}`);
        if (!response.ok || stop) return;
        const incoming = roomEventsFromSse(await response.text());
        if (!incoming.length) return;
        const mapped = incoming.map((message) => ({
          id: message.id,
          actor: actorLabel(message.authorUserId),
          kind: message.taskIds?.length ? '任务' : '消息',
          body: message.body,
        }));
        cursor.current = nextRoomCursor(incoming, after);
        setMessages((current) => {
          if (after === 0) return mapped;
          const seen = new Set(current.map((message) => message.id));
          return [...current, ...mapped.filter((message) => !seen.has(message.id))];
        });
      } catch {
        // Keep the prototype transcript when the API is not running.
      }
    }
    void pull();
    const timer = setInterval(() => void pull(), 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let stop = false;
    async function pullTasks() {
      try {
        const response = await fetch('/api/v1/room/tasks');
        if (!response.ok || stop) return;
        const data = (await response.json()) as { tasks?: ApiTask[] };
        const tasks = (data.tasks ?? []).filter((task) => typeof task.id === 'string' && typeof task.title === 'string');
        if (stop) return;
        setLiveTasks(tasks);
        const chosen = assigneeForReport(tasks, taskIdRef.current);
        if (!taskIdRef.current && chosen.taskId) {
          taskIdRef.current = chosen.taskId;
          setTaskId(chosen.taskId);
        }
        if (tasks.some((task) => task.id === chosen.taskId)) setReportAs(chosen.userId);
      } catch {
        // Keep the prototype task when the API is not running.
      }
    }
    void pullTasks();
    const timer = setInterval(() => void pullTasks(), 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  async function sendDraft() {
    const body = draft.trim();
    if (!body || sending) return;
    const id = pending?.body === body ? pending.id : `web-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`}`;
    setPending({ id, body });
    setSending(true);
    try {
      const response = await fetch('/api/v1/room/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomId: 'room-1', projectId: 'p1', body, clientMessageId: id }),
      });
      if (!response.ok) return;
      const data = (await response.json()) as { message: ApiMessage; reply: ApiMessage | null; task: { id: string; title: string; assigneeUserId?: string } | null; duplicate?: boolean };
      if (data.duplicate) {
        setPending(null);
        setDraft('');
        return;
      }
      const posted = [data.message, ...(data.reply ? [data.reply] : [])];
      cursor.current = nextRoomCursor(posted, cursor.current);
      setMessages((current) => [
        ...current,
        { id: data.message.id, actor: actorLabel(data.message.authorUserId), kind: '消息', body: data.message.body },
        ...(data.reply ? [{ id: data.reply.id, actor: actorLabel(data.reply.authorUserId), kind: data.task ? '任务' : '回复', body: data.reply.body }] : []),
      ]);
      if (data.task) {
        setTaskTitle(data.task.title);
        taskIdRef.current = data.task.id;
        setTaskId(data.task.id);
        if (typeof data.task.assigneeUserId === 'string') setReportAs(data.task.assigneeUserId);
      }
      setPending(null);
      setDraft('');
    } catch {
      setMessages((current) => (
        current.some((message) => message.id === id)
          ? current
          : [...current, { id, actor: '负责人', kind: '消息', body }]
      ));
    } finally {
      setSending(false);
    }
  }

  async function incomingReport() {
    const body = '补充：客户希望本周五前看到报价。';
    if (!taskId) {
      setMessages((current) => [
        ...current,
        { id: `m${current.length + 1}`, actor: '销售员工', kind: '回报', body },
      ]);
      return;
    }
    if (reportInFlight.current) return;
    reportInFlight.current = true;
    const id = reportClientId.current ?? `web-report-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`}`;
    reportClientId.current = id;
    setReporting(true);
    try {
      const response = await fetch(`/api/v1/room/tasks/${taskId}/report`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-user-id': reportAs,
          'x-roles': 'employee',
          'x-projects': 'p1',
        },
        body: JSON.stringify({ body, clientMessageId: id }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        if (error?.error === 'not_assignee') {
          setMessages((current) => [
            ...current,
            { id: `err-${id}`, actor: '超级智能体', kind: '回复', body: '只有被指派的同事能回报这条任务。' },
          ]);
        }
        return;
      }
      const message = (await response.json()) as ApiMessage;
      reportClientId.current = null;
      cursor.current = nextRoomCursor([message], cursor.current);
      setMessages((current) => (
        current.some((item) => item.id === message.id)
          ? current
          : [...current, { id: message.id, actor: actorLabel(message.authorUserId), kind: '回报', body: message.body }]
      ));
    } catch {
      setMessages((current) => (
        current.some((item) => item.id === id)
          ? current
          : [...current, { id, actor: actorLabel(reportAs), kind: '回报', body }]
      ));
    } finally {
      reportInFlight.current = false;
      setReporting(false);
    }
  }

  return (
    <section className="exec-room" aria-label="Agent Room 指挥室">
      <div className="page-head">
        <h1>Agent Room 指挥室</h1>
        <p>同一件工作里，企业负责人、超级智能体和数字员工共享目标、上下文、任务与回报。</p>
        <a className="exec-action" href="#brain">配置超级智能体</a>
      </div>
      <div className="exec-grid">
        <section className="panel exec-pane" aria-label="共享协作记录">
          <div className="exec-pane-head">
            <h2>共享协作记录</h2>
            <span>展示任务理由与结果摘要，不展示隐藏思维链</span>
          </div>
          <div className="exec-scroll">
            {messages.map((message) => (
              <article key={message.id} className="exec-message">
                <header>
                  <strong>{message.actor}</strong>
                  <span>{message.kind}</span>
                </header>
                <p>{message.body}</p>
              </article>
            ))}
          </div>
          <form className="exec-composer" onSubmit={(event) => { event.preventDefault(); void sendDraft(); }}>
            <label htmlFor="room-draft">发给指挥室</label>
            <textarea
              id="room-draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="闲聊只会得到回复。要派活请 @数字员工。"
            />
            <div className="exec-composer-actions">
              <button type="submit" disabled={sending}>发送</button>
              <button type="button" onClick={() => void incomingReport()} disabled={reporting}>模拟同事回报</button>
              <span>同事的新消息不会清掉这里的草稿</span>
            </div>
          </form>
        </section>
        <aside className="panel exec-pane" aria-label="任务列表">
          <div className="exec-pane-head">
            <h2>任务</h2>
            <span>由对话产生，链回原消息</span>
          </div>
          <div className="exec-scroll">
            {(liveTasks ?? [{ id: 'local-task', title: taskTitle, status: 'reported', assigneeUserId: 'user-sales', waitingReason: null }]).map((task) => (
              <button type="button" className="exec-task" key={task.id} onClick={() => setOpenTaskId(task.id)}>
                <strong>{task.title}</strong>
                <span>{taskLine(task)}</span>
              </button>
            ))}
          </div>
        </aside>
        {openTaskId ? (
          <aside className="panel exec-drawer" aria-label="任务详情">
            <div className="exec-pane-head">
              <h2>任务详情</h2>
              <button type="button" onClick={() => setOpenTaskId(null)}>关闭</button>
            </div>
            <dl>
              <div><dt>概览</dt><dd>{(liveTasks ?? []).find((task) => task.id === openTaskId)?.title ?? taskTitle}</dd></div>
              <div><dt>来源消息</dt><dd>@销售员工 整理询价草稿</dd></div>
              <div><dt>依据与权限</dt><dd>只使用该员工被授权的来源</dd></div>
              <div><dt>执行记录</dt><dd>询价草稿已放在对话里</dd></div>
            </dl>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
