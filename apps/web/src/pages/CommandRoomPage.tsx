import { useCallback, useEffect, useRef, useState } from 'react';
import './execution.css';
import { authHeaders } from '../api';

/**
 * Command room (PRD §3.7), layout and copy from the accepted v12 prototype. Everything on the page comes from the
 * server: the people and digital employees from /room/roster (which reads the employee module), the conversation
 * from /room/stream, the tasks from /room/tasks. There is no sample transcript; an empty room is shown as empty.
 * Root stays fixed; the transcript and the task list scroll.
 */
const ROOM_ID = 'room-1';
const POLL_MS = 4000;

export type MessageKind = 'message' | 'reply' | 'report' | 'review' | 'cancel' | 'hold' | 'resume' | 'contract';

export interface ApiMessage {
  id: string;
  seq: number;
  authorUserId: string;
  body: string;
  taskIds: string[];
  kind?: MessageKind;
}

export interface ApiTask {
  id: string;
  title: string;
  status: string;
  assigneeUserId: string;
  waitingReason: string | null;
  employeeId?: string;
  messageId?: string;
  createdByUserId?: string;
  followupTo?: string | null;
  promptSnapshot?: { employeeId: string; promptVersion: number | null; modelTier: string | null; takenAt: string } | null;
  approval?: 'none' | 'required';
  reviewedByUserId?: string | null;
  evidence?: { fields: { subject: string | null; body: string | null }; sent: boolean } | null;
  verification?: 'none' | 'verified' | 'failed';
  inputSupplement?: string | null;
  hold?: { reason: string; responsible: string } | null;
  contract?: { criteria: string; version: number; revisedByUserId: string; at: string } | null;
  runId?: string | null;
}

/** The linked run as the server reports it: its approvals and the external attempts the gateway recorded. */
export interface TaskOutcome {
  runId: string;
  runStatus: string;
  eventId: string;
  approvals: Array<{ id: string; status: string; standing: boolean; actionStatus: string | null }>;
  attempts: number;
  actions: Array<{ stepId: string; status: string; calls: number; externalRef: string | null; readback: unknown }>;
}

const RUN_STATUS: Record<string, string> = {
  completed: '已完成', running: '进行中', waiting_human: '等待人工', blocked: '已阻塞', outcome_unknown: '结果未知', failed: '失败',
};

/** Whether an approval still authorises anything. A retired one is closed with no decision. */
export function approvalLine(approval: TaskOutcome['approvals'][number]): string {
  if (approval.standing) return '批准有效';
  return approval.status === 'closed' || approval.status === 'withdrawn' ? '批准已作废' : '尚未批准';
}

/** The external attempts the gateway recorded for the run, and what the read-back said. */
export function attemptsLine(outcome: Pick<TaskOutcome, 'attempts' | 'actions'>): string {
  const statuses = outcome.actions.map((action) => action.status);
  const read = statuses.includes('outcome_unknown') ? '，结果未知' : statuses.includes('confirmed') ? '，回读一致' : '';
  return `外部提交 ${outcome.attempts} 次${read}。修改验收契约不会重新提交。`;
}

export function runStatusLabel(status: string): string {
  return RUN_STATUS[status] ?? status;
}


export interface RosterEmployee {
  id: string;
  name: string;
  duty: string;
  status: 'active' | 'paused' | 'offline' | 'unconnected';
  ownerUserId: string;
}

export interface RoomViewer {
  userId: string;
  roles: string[];
  owner: boolean;
}

interface Roster {
  viewer: RoomViewer;
  employees: RosterEmployee[];
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
      return [{ ...message, taskIds: Array.isArray(message.taskIds) ? message.taskIds : [] }];
    } catch {
      return [];
    }
  });
}

export function roomDraftKey(key: string, shift: boolean): 'send' | 'newline' {
  return key === 'Enter' && !shift ? 'send' : 'newline';
}

export function nextRoomCursor(messages: readonly ApiMessage[], after: number): number {
  return messages.reduce((max, message) => (Number.isFinite(message.seq) ? Math.max(max, message.seq) : max), after);
}

/** Adds messages the page does not have yet and keeps the room's order. A message already shown is not replaced. */
export function mergeRoomMessages(current: readonly ApiMessage[], incoming: readonly ApiMessage[]): ApiMessage[] {
  const seen = new Set(current.map((message) => message.id));
  const added = incoming.filter((message) => !seen.has(message.id) && (seen.add(message.id), true));
  if (added.length === 0) return current as ApiMessage[];
  const order = (message: ApiMessage) => (Number.isFinite(message.seq) ? message.seq : Number.MAX_SAFE_INTEGER);
  return [...current, ...added].sort((a, b) => order(a) - order(b));
}

/** Picking an employee writes "@name " into the draft. A trailing "@" the person just typed is not doubled. */
export function insertMention(draft: string, name: string): string {
  const base = draft.endsWith('@') ? draft.slice(0, -1) : draft;
  const gap = base === '' || /\s$/u.test(base) ? '' : ' ';
  return `${base}${gap}@${name} `;
}

/** Drafts are kept per signed-in person, so one person's unsent text never shows up under another identity. */
export function draftStorageKey(userId: string): string {
  return `superagent.room-draft.${ROOM_ID}.${userId}`;
}

function readDraft(userId: string): string {
  try {
    return window.localStorage.getItem(draftStorageKey(userId)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(userId: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(draftStorageKey(userId), value);
    else window.localStorage.removeItem(draftStorageKey(userId));
  } catch {
    // Storage can be unavailable (private window); the draft then lives only in this page.
  }
}

const EMPLOYEE_STATE: Record<RosterEmployee['status'], string> = {
  active: '在线',
  paused: '已暂停',
  offline: '不在线',
  unconnected: '未连接',
};

export function employeeName(employees: readonly RosterEmployee[], employeeId: string | undefined): string {
  return employees.find((employee) => employee.id === employeeId)?.name ?? '数字员工';
}

export function taskStatusLabel(task: Pick<ApiTask, 'status' | 'waitingReason'>): string {
  if (task.status === 'reported') return '已回报，待复核';
  if (task.status === 'reviewed') return '已复核';
  if (task.status === 'cancelled') return '已取消';
  if (task.status === 'rejected') return '已退回';
  if (task.status === 'outcome_unknown') return '结果未知';
  if (task.status === 'waiting') return task.waitingReason ?? '等待';
  return '进行中';
}

export function taskLine(task: ApiTask, employees: readonly RosterEmployee[]): string {
  return `${taskStatusLabel(task)} · ${employeeName(employees, task.employeeId)}`;
}

/** An unsent draft says so. The evidence object itself is never printed. */
export function unsentDraftBoundary(task: Pick<ApiTask, 'title' | 'evidence'>): '尚未发送' | null {
  if (!task.evidence || task.evidence.sent) return null;
  if (!task.title.includes('草稿')) return null;
  return '尚未发送';
}

/** Drawer overview: the title and, for an unsent draft, the boundary. No implementation JSON. */
export function resultOverview(task: Pick<ApiTask, 'title' | 'evidence'>): string {
  const boundary = unsentDraftBoundary(task);
  return boundary ? `${task.title}。${boundary}` : task.title;
}

export function supplementError(text: string): '请填写' | null {
  return text.trim() ? null : '请填写';
}

/** Incoming room events do not replace a workflow draft the person is still editing. */
export function applyAsyncReport<T>(draft: T): T {
  return draft;
}

/** The reports attached to a task, oldest first. Only a report counts: follow-ups and notices are not results. */
export function taskReports(task: Pick<ApiTask, 'id'>, messages: readonly ApiMessage[]): ApiMessage[] {
  return messages.filter((message) => message.kind === 'report' && message.taskIds.includes(task.id));
}

const OPEN_STATUS = new Set(['assigned', 'running', 'waiting']);

/** What this person may do with a task. The server decides again on every call; this only hides dead buttons. */
export interface TaskActions { report: boolean; review: boolean; cancel: boolean; followup: boolean; resume: boolean; contract: boolean }

/** A task held because its employee disconnected. Only reconnecting the employee and resuming it moves it on. */
export function waitingForConnection(task: Pick<ApiTask, 'status' | 'waitingReason'>): boolean {
  return task.status === 'waiting' && task.waitingReason === '等待连接';
}

export function taskActions(task: ApiTask, viewer: RoomViewer | null): TaskActions {
  if (!viewer) return { report: false, review: false, cancel: false, followup: false, resume: false, contract: false };
  const asked = viewer.owner || task.createdByUserId === viewer.userId;
  return {
    report: task.assigneeUserId === viewer.userId && (OPEN_STATUS.has(task.status) || task.status === 'reported'),
    review: asked && task.status === 'reported',
    cancel: asked && OPEN_STATUS.has(task.status),
    followup: (asked || task.assigneeUserId === viewer.userId) && task.status !== 'cancelled',
    resume: asked && waitingForConnection(task),
    contract: asked && task.status !== 'cancelled',
  };
}

export function messageKindLabel(message: ApiMessage, tasks: readonly ApiTask[]): string {
  if (message.kind === 'report') return '回报';
  if (message.kind === 'review') return '复核';
  if (message.kind === 'cancel') return '取消';
  if (message.kind === 'hold') return '等待连接';
  if (message.kind === 'resume') return '恢复';
  if (message.kind === 'contract') return '验收契约';
  if (message.kind === 'reply') return message.taskIds.length > 0 ? '任务' : '回复';
  return tasks.some((task) => task.messageId === message.id) ? '派活' : '消息';
}

export function actorLabel(message: ApiMessage, viewer: RoomViewer | null, tasks: readonly ApiTask[], employees: readonly RosterEmployee[]): string {
  if (message.authorUserId === 'super-agent') return '超级智能体';
  if (message.kind === 'report') {
    const task = tasks.find((item) => message.taskIds.includes(item.id));
    return employeeName(employees, task?.employeeId);
  }
  return viewer && message.authorUserId === viewer.userId ? '我' : '同事';
}

const REFUSALS: Record<string, string> = {
  not_assignee: '只有被指派的同事能回报这条任务。',
  task_closed: '这条任务已经结束，不能再改。',
  not_reported: '还没有回报，不能复核。',
  evidence_failed: '证据不完整，不能复核通过。',
  empty_supplement: '请填写要补充的内容。',
  forbidden: '你不能对这条任务做这个操作。',
  task_not_found: '找不到这条任务。',
  employee_offline: '数字员工还没有重新连接。请先在「数字员工」里恢复它，再恢复这条任务。',
  contract_unchanged: '验收契约没有变化。',
  invalid_contract: '请写清楚怎样才算完成（不超过 2000 字）。',
  not_waiting: '这条任务没有在等待连接。',
};

function newId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

export function CommandRoomPage() {
  const [roster, setRoster] = useState<Roster | null>(null);
  const [offline, setOffline] = useState(false);
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [tasks, setTasks] = useState<ApiTask[]>([]);
  const [draft, setDraft] = useState('');
  const [followupId, setFollowupId] = useState<string | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [reportDraft, setReportDraft] = useState('');
  const [supplementDraft, setSupplementDraft] = useState('');
  const [supplementHelp, setSupplementHelp] = useState('');
  const [contractDraft, setContractDraft] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ taskId: string; data: TaskOutcome | null } | null>(null);
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);

  const cursor = useRef(0);
  const pulling = useRef(false);
  const pullAgain = useRef(false);
  const pending = useRef<{ id: string; body: string; followupTo: string | null } | null>(null);
  const actionId = useRef<{ key: string; id: string } | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const input = useRef<HTMLTextAreaElement | null>(null);

  const viewer = roster?.viewer ?? null;
  const viewerId = viewer?.userId ?? null;
  const employees = roster?.employees ?? [];

  const pull = useCallback(async () => {
    if (pulling.current) {
      pullAgain.current = true;
      return;
    }
    pulling.current = true;
    try {
      const headers = await authHeaders();
      const [rosterRes, streamRes, tasksRes] = await Promise.all([
        fetch(`/api/v1/room/roster?roomId=${ROOM_ID}`, { headers }),
        fetch(`/api/v1/room/stream?roomId=${ROOM_ID}&after=${cursor.current}`, { headers }),
        fetch(`/api/v1/room/tasks?roomId=${ROOM_ID}`, { headers }),
      ]);
      if (!rosterRes.ok || !streamRes.ok || !tasksRes.ok) {
        setOffline(true);
        return;
      }
      const nextRoster = (await rosterRes.json()) as Roster;
      const incoming = roomEventsFromSse(await streamRes.text());
      const data = (await tasksRes.json()) as { tasks?: ApiTask[] };
      setOffline(false);
      setRoster(nextRoster);
      cursor.current = nextRoomCursor(incoming, cursor.current);
      setMessages((current) => mergeRoomMessages(current, incoming));
      setTasks((data.tasks ?? []).filter((task) => typeof task.id === 'string' && typeof task.title === 'string'));
    } catch {
      setOffline(true);
    } finally {
      pulling.current = false;
      if (pullAgain.current) {
        pullAgain.current = false;
        void pull();
      }
    }
  }, []);

  useEffect(() => {
    void pull();
    const timer = setInterval(() => void pull(), POLL_MS);
    return () => clearInterval(timer);
  }, [pull]);

  // The saved draft belongs to the signed-in person. It is restored once they are known and never over typed text.
  useEffect(() => {
    if (!viewerId) return;
    const saved = readDraft(viewerId);
    if (saved) setDraft((current) => (current === '' ? saved : current));
  }, [viewerId]);

  // New messages keep the view at the latest line only while the reader is already there (or has just sent one).
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function changeDraft(value: string) {
    setDraft(value);
    if (viewerId) writeDraft(viewerId, value);
    if (value.endsWith('@')) setMentionOpen(true);
  }

  function pickMention(name: string) {
    const next = insertMention(draft, name);
    changeDraft(next);
    setMentionOpen(false);
    // Typing continues right after the inserted name.
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.length, next.length);
    });
  }

  async function sendDraft() {
    const body = draft.trim();
    if (!body || sending || !viewerId) return;
    const same = pending.current && pending.current.body === body && pending.current.followupTo === followupId;
    const id = same ? pending.current!.id : newId('web');
    pending.current = { id, body, followupTo: followupId };
    setSending(true);
    setNotice('');
    try {
      const response = await fetch('/api/v1/room/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ roomId: ROOM_ID, body, clientMessageId: id, followupTo: followupId }),
      });
      if (!response.ok) {
        setNotice('这条消息没有发出去，草稿还在，可以再发一次。');
        return;
      }
      const data = (await response.json()) as { message: ApiMessage; reply: ApiMessage | null };
      pending.current = null;
      stick.current = true;
      setMessages((current) => mergeRoomMessages(current, [data.message, ...(data.reply ? [data.reply] : [])]));
      setDraft('');
      writeDraft(viewerId, '');
      setFollowupId(null);
      setMentionOpen(false);
      void pull();
    } catch {
      setNotice('这条消息没有发出去，草稿还在，可以再发一次。');
    } finally {
      setSending(false);
    }
  }

  /** report / review / cancel. The same click retried keeps its client id, so it lands once. */
  async function act(task: ApiTask, action: 'report' | 'review' | 'cancel' | 'resume', text?: string) {
    if (acting) return;
    const key = `${action}:${task.id}:${text ?? ''}`;
    const id = actionId.current?.key === key ? actionId.current.id : newId(`web-${action}`);
    actionId.current = { key, id };
    setActing(true);
    setNotice('');
    try {
      const response = await fetch(`/api/v1/room/tasks/${encodeURIComponent(task.id)}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ clientMessageId: id, ...(action === 'report' ? { body: text } : {}) }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        setNotice(REFUSALS[error?.error ?? ''] ?? '这个操作没有成功。');
        return;
      }
      const message = (await response.json()) as ApiMessage;
      actionId.current = null;
      setMessages((current) => mergeRoomMessages(current, [message]));
      if (action === 'report') setReportDraft('');
      void pull();
    } catch {
      setNotice('这个操作没有成功，可以再试一次。');
    } finally {
      setActing(false);
    }
  }

  async function saveSupplement(task: ApiTask) {
    const help = supplementError(supplementDraft);
    if (help) {
      setSupplementHelp(help);
      return;
    }
    if (acting) return;
    const key = `supplement:${task.id}:${supplementDraft.trim()}`;
    const id = actionId.current?.key === key ? actionId.current.id : newId('web-supplement');
    actionId.current = { key, id };
    setActing(true);
    setSupplementHelp('');
    try {
      const response = await fetch(`/api/v1/room/tasks/${encodeURIComponent(task.id)}/supplement`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ text: supplementDraft.trim(), clientMessageId: id }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        setSupplementHelp(error?.error === 'empty_supplement' ? '请填写' : '补充没有保存。');
        return;
      }
      actionId.current = null;
      setSupplementDraft('');
      void pull();
    } catch {
      setSupplementHelp('补充没有保存。');
    } finally {
      setActing(false);
    }
  }

  // The linked run's approvals and attempts, read again whenever the task list refreshes while the drawer is open.
  useEffect(() => {
    if (!openTaskId) return;
    let stop = false;
    void (async () => {
      try {
        const response = await fetch(`/api/v1/room/tasks/${encodeURIComponent(openTaskId)}/outcome`, { headers: await authHeaders() });
        if (!response.ok || stop) return;
        const data = (await response.json()) as { outcome: TaskOutcome | null };
        if (!stop) setOutcome({ taskId: openTaskId, data: data.outcome });
      } catch {
        // The drawer keeps the last outcome it had.
      }
    })();
    return () => {
      stop = true;
    };
  }, [openTaskId, tasks]);

  async function saveContract(task: ApiTask) {
    const criteria = (contractDraft ?? '').trim();
    if (acting || !criteria) return;
    const key = `contract:${task.id}:${criteria}`;
    const id = actionId.current?.key === key ? actionId.current.id : newId('web-contract');
    actionId.current = { key, id };
    setActing(true);
    setNotice('');
    try {
      const response = await fetch(`/api/v1/room/tasks/${encodeURIComponent(task.id)}/contract`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(await authHeaders()) },
        body: JSON.stringify({ criteria, clientMessageId: id }),
      });
      if (!response.ok) {
        const error = (await response.json().catch(() => null)) as { error?: string } | null;
        setNotice(REFUSALS[error?.error ?? ''] ?? '验收契约没有保存。');
        return;
      }
      const data = (await response.json()) as { message: ApiMessage };
      actionId.current = null;
      setContractDraft(null);
      setMessages((current) => mergeRoomMessages(current, [data.message]));
      void pull();
    } catch {
      setNotice('验收契约没有保存，可以再试一次。');
    } finally {
      setActing(false);
    }
  }

  function jumpTo(messageId: string) {
    stick.current = false;
    setFocusMessageId(messageId);
    document.getElementById(`room-msg-${messageId}`)?.scrollIntoView({ block: 'center' });
  }

  function openTaskDrawer(id: string | null) {
    setContractDraft(null);
    setOpenTaskId(id);
  }

  function startFollowup(task: ApiTask) {
    setFollowupId(task.id);
    input.current?.focus();
  }

  const openTask = tasks.find((task) => task.id === openTaskId) ?? null;
  const openOutcome = outcome && openTask && outcome.taskId === openTask.id ? outcome.data : null;
  const followupTask = tasks.find((task) => task.id === followupId) ?? null;
  const source = openTask ? messages.find((message) => message.id === openTask.messageId) ?? null : null;
  const original = openTask?.followupTo ? tasks.find((task) => task.id === openTask.followupTo) ?? null : null;
  const reports = openTask ? taskReports(openTask, messages) : [];
  const may = openTask ? taskActions(openTask, viewer) : null;
  const employeeView = viewer !== null && !viewer.owner;

  return (
    <section className="exec-room" aria-label="Agent Room 指挥室" data-view={viewer ? (viewer.owner ? 'owner' : 'employee') : 'loading'}>
      <div className="page-head">
        <h1>Agent Room 指挥室</h1>
        <p>
          {employeeView
            ? '跟进自己负责的数字员工：交给它的任务、它的回报和追问都在这里。'
            : '同一件工作里，企业负责人、超级智能体和数字员工共享目标、上下文、任务与回报。'}
        </p>
        {viewer?.owner ? <a className="exec-action" href="#brain">配置超级智能体</a> : null}
      </div>
      <div className="exec-grid">
        <section className="panel exec-pane" aria-label="共享协作记录">
          <div className="exec-pane-head">
            <h2>共享协作记录</h2>
            <span>展示任务理由与结果摘要，不展示隐藏思维链</span>
          </div>
          <div
            className="exec-scroll exec-stream"
            ref={scroller}
            onScroll={(event) => {
              const el = event.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {messages.length === 0 ? (
              <p className="exec-empty">{roster ? '还没有对话。闲聊只会得到回复；要派活请 @数字员工 并说清楚要做的事。' : offline ? '暂时连不上指挥室，稍后会自动重试。' : '正在读取指挥室…'}</p>
            ) : messages.map((message) => (
              <article
                key={message.id}
                id={`room-msg-${message.id}`}
                data-message={message.id}
                data-kind={message.kind ?? 'message'}
                className={`exec-message${focusMessageId === message.id ? ' exec-message-focus' : ''}`}
              >
                <header>
                  <strong>{actorLabel(message, viewer, tasks, employees)}</strong>
                  <span>{messageKindLabel(message, tasks)}</span>
                </header>
                <p>{message.body}</p>
                {message.taskIds.filter((id) => tasks.some((task) => task.id === id)).slice(-1).map((id) => (
                  <button type="button" className="exec-link" key={id} data-open-task={id} onClick={() => openTaskDrawer(id)}>查看任务</button>
                ))}
              </article>
            ))}
          </div>
          <form className="exec-composer" onSubmit={(event) => { event.preventDefault(); void sendDraft(); }}>
            <label htmlFor="room-draft">发给指挥室</label>
            {followupTask ? (
              <p className="exec-followup" data-followup={followupTask.id}>
                <span>追问：{followupTask.title}</span>
                <button type="button" onClick={() => setFollowupId(null)}>不追问了</button>
              </p>
            ) : null}
            <textarea
              id="room-draft"
              ref={input}
              value={draft}
              disabled={!viewer}
              onChange={(event) => changeDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && mentionOpen) {
                  setMentionOpen(false);
                  return;
                }
                if (event.nativeEvent.isComposing || roomDraftKey(event.key, event.shiftKey) !== 'send') return;
                event.preventDefault();
                void sendDraft();
              }}
              placeholder={followupTask ? '写下要追问的内容，原任务的员工和上下文会带上。' : '闲聊只会得到回复。要派活请 @数字员工。'}
            />
            {mentionOpen ? (
              <div className="exec-mentions" role="listbox" aria-label="选择数字员工">
                {employees.length === 0 ? (
                  <p>还没有可以指派的数字员工。</p>
                ) : employees.map((employee) => (
                  <button type="button" role="option" aria-selected="false" key={employee.id} data-mention={employee.id} onClick={() => pickMention(employee.name)}>
                    <strong>@{employee.name}</strong>
                    <span>{[employee.duty, EMPLOYEE_STATE[employee.status]].filter(Boolean).join(' · ')}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="exec-composer-actions">
              <button type="submit" disabled={sending || !viewer}>发送</button>
              <button type="button" aria-haspopup="listbox" aria-expanded={mentionOpen} disabled={!viewer} onClick={() => setMentionOpen((open) => !open)}>@ 提及</button>
              <span>Enter 发送，Shift+Enter 换行。同事的新消息不会清掉这里的草稿</span>
            </div>
            <p className="exec-notice" role="status" aria-label="指挥室提示">{notice}</p>
          </form>
        </section>
        <aside className="panel exec-pane" aria-label="任务列表">
          <div className="exec-pane-head">
            <h2>任务</h2>
            <span>由对话产生，链回原消息</span>
          </div>
          <div data-outcome="summary">
            {tasks.length === 0 ? <p>暂无事项</p> : (
              <ul>
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="outcome-message-card"
                      data-outcome="summary-message"
                      onClick={() => { if (task.messageId) jumpTo(task.messageId); setOpenTaskId(task.id); }}
                    >
                      {task.title}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="exec-scroll">
            {tasks.length === 0 ? (
              <p className="exec-empty">当前没有由对话产生的任务。</p>
            ) : tasks.map((task) => (
              <button type="button" className="exec-task" key={task.id} data-task={task.id} data-status={task.status} onClick={() => openTaskDrawer(task.id)}>
                <strong>{task.title}</strong>
                <span>{taskLine(task, employees)}</span>
              </button>
            ))}
          </div>
        </aside>
        {openTask && may ? (
          <aside className="panel exec-drawer" aria-label="任务详情" data-task-detail={openTask.id}>
            <div className="exec-pane-head">
              <h2>任务详情</h2>
              <button type="button" onClick={() => openTaskDrawer(null)}>关闭</button>
            </div>
            <dl>
              <div><dt>概览</dt><dd data-overview>{resultOverview(openTask)}</dd></div>
              <div><dt>状态</dt><dd data-status>{taskStatusLabel(openTask)}</dd></div>
              <div><dt>指派</dt><dd data-assignee>@{employeeName(employees, openTask.employeeId)}{openTask.assigneeUserId === viewerId ? '（由你负责）' : ''}</dd></div>
              <div>
                <dt>来源消息</dt>
                <dd data-source>
                  {source ? source.body : '原消息不在当前可见的记录里。'}
                  {source ? <button type="button" className="exec-link" onClick={() => jumpTo(source.id)}>回到原消息</button> : null}
                </dd>
              </div>
              {openTask.followupTo ? (
                <div>
                  <dt>追问自</dt>
                  <dd data-followup-of>
                    {original ? original.title : '原任务不在当前可见的列表里。'}
                    {original ? <button type="button" className="exec-link" onClick={() => openTaskDrawer(original.id)}>打开原任务</button> : null}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>提示词快照</dt>
                <dd data-snapshot>
                  {openTask.promptSnapshot
                    ? `提示词第 ${openTask.promptSnapshot.promptVersion ?? '?'} 版 · 模型档位 ${openTask.promptSnapshot.modelTier ?? '未记录'} · 交办于 ${openTask.promptSnapshot.takenAt}`
                    : '这条任务没有记录提示词快照。'}
                </dd>
              </div>
              <div>
                <dt>依据与权限</dt>
                <dd data-approval>
                  {openTask.approval === 'required'
                    ? '这是对外动作：执行前要在「待我处理」里批准，这里交办不等于授权。'
                    : '只读或起草，不需要动作审批。只使用该员工被授权的来源。'}
                </dd>
              </div>
              <div>
                <dt>验收契约</dt>
                <dd data-contract>
                  {openTask.contract ? `第 ${openTask.contract.version} 版：${openTask.contract.criteria}` : '还没有写验收契约。'}
                </dd>
              </div>
              {openTask.runId ? (
                <div>
                  <dt>执行与外部动作</dt>
                  <dd data-outcome>
                    {openOutcome ? (
                      <>
                        <p data-run={openOutcome.runId}>事件 {openOutcome.eventId} · {runStatusLabel(openOutcome.runStatus)}</p>
                        <ul>
                          {openOutcome.approvals.map((approval) => (
                            <li key={approval.id} data-approval-item={approval.id} data-standing={approval.standing ? 'yes' : 'no'}>{approvalLine(approval)}</li>
                          ))}
                        </ul>
                        <p data-attempts={openOutcome.attempts}>{attemptsLine(openOutcome)}</p>
                      </>
                    ) : '正在读取执行记录…'}
                  </dd>
                </div>
              ) : null}
              <div>
                <dt>结果与证据</dt>
                <dd data-evidence>
                  {reports.length === 0 ? '还没有回报。' : (
                    <ul>
                      {reports.map((report) => (
                        <li key={report.id}>
                          {report.body}
                          <button type="button" className="exec-link" onClick={() => jumpTo(report.id)}>在对话里看</button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {openTask.status === 'reported' ? <p>已回报，还没有人复核。回报不等于已被接受。</p> : null}
                  {openTask.status === 'reviewed' ? <p>已由人复核通过。</p> : null}
                  {unsentDraftBoundary(openTask) ? <p data-boundary>{unsentDraftBoundary(openTask)}</p> : null}
                  {openTask.hold ? <p data-blocker>负责人：{openTask.hold.responsible}</p> : null}
                </dd>
              </div>
            </dl>
            {openTask.waitingReason === '等待补充' ? (
              <div className="exec-report">
                <label htmlFor="outcome-input">补充资料</label>
                <input id="outcome-input" value={supplementDraft} onChange={(event) => setSupplementDraft(event.target.value)} />
                <p id="outcome-input-help">{supplementHelp}</p>
                <button type="button" data-outcome="save-input" disabled={acting} onClick={() => void saveSupplement(openTask)}>保存补充</button>
              </div>
            ) : null}
            {may.contract ? (
              <div className="exec-report">
                <label htmlFor="room-contract">{openTask.contract ? '修改验收契约' : '写验收契约'}</label>
                <textarea
                  id="room-contract"
                  value={contractDraft ?? openTask.contract?.criteria ?? ''}
                  onChange={(event) => setContractDraft(event.target.value)}
                  placeholder="怎样才算完成，例如：必须核对金额、供应商和产品编号，负责人独立复核"
                />
                {openTask.contract ? <p className="exec-empty">保存新版本后，之前的人工验收和动作批准作废；已有的外部提交和回读证据保留。</p> : null}
                <button type="button" disabled={acting || (contractDraft ?? '').trim() === ''} onClick={() => void saveContract(openTask)}>保存契约</button>
              </div>
            ) : null}
            {may.report ? (
              <div className="exec-report">
                <label htmlFor="room-report">回报内容</label>
                <textarea id="room-report" value={reportDraft} onChange={(event) => setReportDraft(event.target.value)} />
                <button type="button" disabled={acting || reportDraft.trim() === ''} onClick={() => void act(openTask, 'report', reportDraft.trim())}>提交回报</button>
              </div>
            ) : null}
            <div className="exec-composer-actions">
              {may.review ? <button type="button" data-review disabled={acting || openTask.verification === 'failed'} onClick={() => void act(openTask, 'review')}>复核通过</button> : null}
              {may.followup ? <button type="button" onClick={() => startFollowup(openTask)}>追问</button> : null}
              {may.resume ? <button type="button" disabled={acting} onClick={() => void act(openTask, 'resume')}>恢复任务</button> : null}
              {may.cancel ? <button type="button" disabled={acting} onClick={() => void act(openTask, 'cancel')}>取消任务</button> : null}
            </div>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
