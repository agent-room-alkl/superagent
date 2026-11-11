import type { TaskStatus } from '@superagent/shared';
import { asksAvailability, isExternalAction, isGreeting, needsParameters, workText } from './intent.js';
import {
  acceptSupplement, applyAsyncReport, evidenceFromReport, permissionHold, resultOverview, summaryLabel, verificationOf,
  type ResultEvidence, type ResultHold, type ResultVerification,
} from './result-gate.js';

export interface Viewer {
  userId: string;
  roles: Array<'admin' | 'owner' | 'employee' | 'reviewer'>;
  projectScopes: string[];
}

export interface EmployeeRef {
  id: string;
  name: string;
  /** The person responsible for this digital employee. Tasks given to it are theirs to see and report on. */
  ownerUserId: string;
  status: 'active' | 'paused' | 'offline' | 'unconnected';
  duty?: string;
  promptVersion?: number;
  modelTier?: string;
}

/** A fixed list (tests) or a live read of the digital-employee registry. */
export type EmployeeSource = EmployeeRef[] | (() => EmployeeRef[]);

export interface RoomMessage {
  id: string;
  seq: number;
  roomId: string;
  tenantId: string;
  authorUserId: string;
  body: string;
  clientMessageId: string;
  mentions: string[];
  taskIds: string[];
  /** message: someone speaking. reply: the super agent answering. report / review / cancel: an event on a task. */
  kind: MessageKind;
}

export type MessageKind = 'message' | 'reply' | 'report' | 'review' | 'cancel' | 'hold' | 'resume' | 'contract';

/** What counts as done for a task. Each revision is a new version; acceptance is always against the current one. */
export interface TaskContract {
  criteria: string;
  version: number;
  revisedByUserId: string;
  at: string;
}

/** What the employee was running with when the task was handed over. */
export interface PromptSnapshot {
  employeeId: string;
  promptVersion: number | null;
  modelTier: string | null;
  takenAt: string;
}

export interface RoomTask {
  id: string;
  tenantId: string;
  roomId: string;
  projectId: string | null;
  messageId: string;
  assigneeUserId: string;
  employeeId: string;
  title: string;
  status: TaskStatus;
  waitingReason: string | null;
  createdByUserId: string;
  /** The task this one continues. The employee and project carry over from it. */
  followupTo: string | null;
  promptSnapshot: PromptSnapshot | null;
  /** "required" when the request is an outward action; reading and drafting need none. */
  approval: 'none' | 'required';
  reviewedByUserId: string | null;
  /** Structured result. Null until someone reports. Never rendered by stringifying it. */
  evidence: ResultEvidence | null;
  verification: ResultVerification;
  inputSupplement: string | null;
  /** Set while the task is waiting on a person. Cleared on release; the task id stays. */
  hold: ResultHold | null;
  contract: TaskContract | null;
  /** The execution run that carries this task's external action, linked by the runtime or the person who asked. */
  runId: string | null;
}

export interface RoomSnapshot {
  seq: number;
  messages: RoomMessage[];
  tasks: RoomTask[];
  members: Array<{ roomId: string; userIds: string[] }>;
}

export interface PostInput {
  roomId: string;
  tenantId: string;
  projectId?: string | null;
  authorUserId: string;
  authorRoles?: Viewer['roles'];
  authorProjectScopes?: string[];
  /** When false, a real assignment is kept and marked waiting for the model. */
  modelAvailable?: boolean;
  body: string;
  clientMessageId: string;
  /** Continue an earlier task instead of naming an employee again. */
  followupTo?: string | null;
}

const OPEN: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['assigned', 'running', 'waiting']);
const COMPLETED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['completed', 'reviewed']);
const WAITING_CONNECTION = '等待连接';
const ACTIVE = (employee: EmployeeRef | undefined) => employee?.status === 'active';

function isOwner(viewer: Pick<Viewer, 'roles'>): boolean {
  return viewer.roles.includes('owner') || viewer.roles.includes('admin');
}

/** Rows written before messages carried a kind: a reply is known by its client id, a report by its task link. */
function kindOf(message: RoomMessage, tasks: readonly RoomTask[]): MessageKind {
  if (message.kind) return message.kind;
  if (message.clientMessageId.startsWith('reply:')) return 'reply';
  const isSource = tasks.some((task) => task.messageId === message.id);
  return message.taskIds.length > 0 && !isSource && message.authorUserId !== 'super-agent' ? 'report' : 'message';
}

/** Fields added after the first room snapshots were written get their defaults here. */
function withDefaults(task: RoomTask): RoomTask {
  return {
    ...task,
    createdByUserId: task.createdByUserId ?? '',
    followupTo: task.followupTo ?? null,
    promptSnapshot: task.promptSnapshot ? { ...task.promptSnapshot } : null,
    approval: task.approval ?? 'none',
    reviewedByUserId: task.reviewedByUserId ?? null,
    evidence: task.evidence
      ? {
          fields: { subject: task.evidence.fields?.subject ?? null, body: task.evidence.fields?.body ?? null },
          sent: task.evidence.sent === true,
        }
      : null,
    verification: task.verification === 'verified' || task.verification === 'failed' ? task.verification : 'none',
    inputSupplement: task.inputSupplement ?? null,
    hold: task.hold?.toolId ? { reason: task.hold.reason, responsible: task.hold.responsible, toolId: task.hold.toolId } : null,
    contract: task.contract ? { ...task.contract } : null,
    runId: task.runId ?? null,
  };
}

/**
 * Command room (PRD §3.7). Messages and tasks stay in the store across reloads.
 * SSE clients pass the last seq they rendered; the same client message id posts once.
 *
 * Small talk, questions and vague outward requests get a reply and no task. A task exists only when someone names
 * a digital employee they may assign and says what to do, or continues a task they can already see.
 */
export class CommandRoom {
  private seq = 0;
  private readonly messages: RoomMessage[] = [];
  private readonly tasks: RoomTask[] = [];
  private readonly byClientId = new Map<string, RoomMessage>();
  private readonly members = new Map<string, Set<string>>();
  private readonly source: EmployeeSource;
  private readonly now: () => Date;

  constructor(employees: EmployeeSource, now: () => Date = () => new Date()) {
    this.source = employees;
    this.now = now;
  }

  private employees(): EmployeeRef[] {
    return typeof this.source === 'function' ? this.source() : this.source;
  }

  /** Enough state to rebuild the room after a process restart. */
  snapshot(): RoomSnapshot {
    return {
      seq: this.seq,
      messages: this.messages.map((message) => ({ ...message, mentions: [...message.mentions], taskIds: [...message.taskIds] })),
      tasks: this.tasks.map((task) => withDefaults(task)),
      members: [...this.members.entries()].map(([roomId, userIds]) => ({ roomId, userIds: [...userIds] })),
    };
  }

  static restore(employees: EmployeeSource, saved: RoomSnapshot): CommandRoom {
    const room = new CommandRoom(employees);
    room.seq = saved.seq;
    for (const message of saved.messages) {
      const copy = { ...message, mentions: [...message.mentions], taskIds: [...message.taskIds], kind: kindOf(message, saved.tasks) };
      room.messages.push(copy);
      room.byClientId.set(`${copy.roomId}:${copy.clientMessageId}`, copy);
    }
    for (const task of saved.tasks) room.tasks.push(withDefaults(task));
    for (const member of saved.members) room.members.set(member.roomId, new Set(member.userIds));
    return room;
  }

  addMember(roomId: string, userId: string): void {
    const set = this.members.get(roomId) ?? new Set<string>();
    set.add(userId);
    this.members.set(roomId, set);
  }

  /** The digital employees this person may name: an owner sees all, anyone else only the ones they answer for. */
  roster(viewer: Viewer): EmployeeRef[] {
    return this.employees().filter((employee) => isOwner(viewer) || employee.ownerUserId === viewer.userId);
  }

  post(input: PostInput): { message: RoomMessage; reply: RoomMessage | null; task: RoomTask | null; duplicate: boolean } {
    const key = `${input.roomId}:${input.clientMessageId}`;
    const prior = this.byClientId.get(key);
    if (prior) {
      const task = this.tasks.find((item) => item.messageId === prior.id) ?? null;
      return { message: prior, reply: null, task, duplicate: true };
    }

    const author: Viewer = {
      userId: input.authorUserId,
      // No roles means the caller did not say who they are acting as; room-level callers are owners.
      roles: input.authorRoles && input.authorRoles.length > 0 ? input.authorRoles : ['owner'],
      projectScopes: input.authorProjectScopes ?? [],
    };
    const mentions = this.resolveMentions(input.body);
    const original = input.followupTo ? this.tasks.find((item) => item.id === input.followupTo) ?? null : null;
    const originalVisible = original !== null && original.roomId === input.roomId && this.canSeeTask(original, author);
    const message = this.push({
      roomId: input.roomId,
      tenantId: input.tenantId,
      authorUserId: input.authorUserId,
      body: input.body,
      clientMessageId: input.clientMessageId,
      mentions: mentions.map((employee) => employee.id),
      // A follow-up belongs with the task it continues, so the people on that task see it.
      taskIds: originalVisible ? [original.id] : [],
      kind: 'message',
    });
    this.byClientId.set(key, message);
    const say = (body: string, link: { mentions?: string[]; taskIds?: string[] } = {}) => this.push({
      roomId: input.roomId,
      tenantId: input.tenantId,
      authorUserId: 'super-agent',
      body,
      clientMessageId: `reply:${message.id}`,
      mentions: link.mentions ?? [],
      taskIds: link.taskIds ?? [],
      kind: 'reply',
    });
    const noTask = (body: string) => ({ message, reply: say(body, { taskIds: message.taskIds }), task: null, duplicate: false });

    if (input.followupTo && !originalVisible) return noTask('找不到要追问的任务，这条没有建任务。');

    const employee = mentions[0] ?? (original ? this.employees().find((item) => item.id === original.employeeId) ?? null : null);
    if (original && !employee) return noTask('原任务的数字员工已经不在了，这条没有建任务。');

    if (employee && this.outsideProject(input, original)) return noTask('这超出了你的项目范围，我不会创建这个任务。');

    const body = input.body.trim();
    if (!employee) {
      if (isGreeting(body)) return noTask('你好。需要派活时直接 @数字员工，并说清楚要做的事。');
      if (asksAvailability(body)) return noTask(this.availability(author));
      if (isExternalAction(body)) return noTask('这是对外动作。请先补充具体对象（收件人或单号）、内容和依据，再 @数字员工，我才会建任务。');
      return noTask('这件事最终要得到什么结果？说清楚要做的事并 @数字员工，我再建任务。');
    }

    if (!isOwner(author) && employee.ownerUserId !== author.userId) {
      return noTask(`@${employee.name} 不在当前身份可以指派的范围内，我不会创建这个任务。`);
    }
    if (isGreeting(body) || workText(body) === '') {
      return noTask(`已看到 @${mentions.map((item) => item.name).join(' @')}，这条还不是明确的工作请求。`);
    }
    if (needsParameters(body)) {
      return noTask('这是对外动作。请先补充具体对象（收件人或单号）、内容和依据，我再交给数字员工。');
    }

    const offline = employee.status === 'paused' || employee.status === 'offline' || employee.status === 'unconnected';
    const modelDown = input.modelAvailable === false;
    const waiting = offline || modelDown;
    const task: RoomTask = {
      id: `task_${message.seq}`,
      tenantId: input.tenantId,
      roomId: input.roomId,
      projectId: input.projectId ?? original?.projectId ?? null,
      messageId: message.id,
      assigneeUserId: employee.ownerUserId,
      employeeId: employee.id,
      // The task is named by the work asked for; who it went to is on the task, not repeated in its name.
      title: workText(body),
      status: waiting ? 'waiting' : 'assigned',
      waitingReason: modelDown ? '等待模型' : offline ? '等待连接' : null,
      createdByUserId: input.authorUserId,
      followupTo: original?.id ?? null,
      promptSnapshot: {
        employeeId: employee.id,
        promptVersion: employee.promptVersion ?? null,
        modelTier: employee.modelTier ?? null,
        takenAt: this.now().toISOString(),
      },
      approval: isExternalAction(body) ? 'required' : 'none',
      reviewedByUserId: null,
      // A draft is unsent from the moment it exists. Nothing is marked done until a person reports it.
      evidence: workText(body).includes('草稿') ? { fields: { subject: null, body: null }, sent: false } : null,
      verification: 'none',
      inputSupplement: null,
      hold: null,
      contract: null,
      runId: null,
    };
    this.tasks.push(task);
    message.taskIds = original ? [original.id, task.id] : [task.id];
    const reply = say(
      modelDown
        ? '暂时无法处理。任务已保留，状态是等待模型。'
        : waiting
          ? `已把这件事交给 @${employee.name}，对方当前${employee.status === 'paused' ? '已暂停' : '不在线'}，任务标为等待连接。`
          : original
            ? `已作为「${original.title}」的追问交给 @${employee.name}：${task.title}`
            : `已交给 @${employee.name}：${task.title}`,
      { mentions: [employee.id], taskIds: [task.id] },
    );
    return { message, reply, task, duplicate: false };
  }

  report(taskId: string, authorUserId: string, body: string, clientMessageId: string): RoomMessage {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('task_not_found');
    if (task.assigneeUserId !== authorUserId) throw new Error('not_assignee');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return prior;
    if (task.status === 'cancelled' || COMPLETED.has(task.status)) throw new Error('task_closed');
    const text = body.trim();
    if (!text) throw new Error('empty_report');
    task.waitingReason = null;
    task.evidence = evidenceFromReport(text);
    task.verification = verificationOf(task.evidence, { contract: task.contract?.criteria ?? null });
    // Product decision (T-86): an employee report completes the task directly unless evidence verification fails,
    // in which case the task stays in 'assigned' (in-progress) so the assignee can submit a corrected report.
    task.status = task.verification === 'failed' ? 'assigned' : 'completed';
    return this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId,
      body,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'report',
    });
  }

  /** The person who asked, or an owner, withdraws a task that has not been reported yet. */
  cancel(taskId: string, viewer: Viewer, clientMessageId: string): RoomMessage {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return prior;
    if (!OPEN.has(task.status)) throw new Error('task_closed');
    task.status = 'cancelled';
    task.waitingReason = null;
    return this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: 'super-agent',
      body: `已取消：${task.title}`,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'cancel',
    });
  }

  /**
   * Human review step is retired (T-86: report completes the task directly when evidence verifies).
   * Kept as a refusal endpoint so callers get 404/403/409 (evidence_failed / task_closed / not_reported).
   */
  review(taskId: string, viewer: Viewer, _clientMessageId: string): RoomMessage {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (task.verification === 'failed') throw new Error('evidence_failed');
    if (COMPLETED.has(task.status) || task.status === 'reported' || task.status === 'cancelled') throw new Error('task_closed');
    throw new Error('not_reported');
  }

  /**
   * Re-checks the evidence already stored on the task. The caller cannot supply a replacement body.
   * A linked run's read-back is passed in by the route, which reads it from the gateway.
   * If verification fails, a completed task drops back to 'assigned' so a failed report never counts as completed.
   */
  verifyEvidence(taskId: string, viewer: Viewer, check: { readbackMismatch?: boolean } = {}): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId && task.assigneeUserId !== viewer.userId) throw new Error('forbidden');
    if (task.status === 'cancelled') throw new Error('task_closed');
    task.verification = verificationOf(task.evidence, {
      contract: task.contract?.criteria ?? null,
      readbackMismatch: check.readbackMismatch === true,
    });
    if (task.verification === 'failed') {
      if (COMPLETED.has(task.status) || task.status === 'reported') task.status = 'assigned';
    } else if (task.verification === 'verified' && task.evidence?.fields.body) {
      task.status = 'completed';
    }
    return task;
  }

  /** Human text for the drawer. Evidence stays structured and is not printed. */
  overview(taskId: string, viewer: Viewer): string {
    const task = this.visibleTask(taskId, viewer);
    return resultOverview(task.title, task.evidence);
  }

  /** Marks the same task as waiting for a supplement. Does not open a second task. */
  askInput(taskId: string, viewer: Viewer): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (COMPLETED.has(task.status) || task.status === 'reported') throw new Error('task_reported');
    if (task.status === 'cancelled') throw new Error('task_closed');
    task.status = 'waiting';
    task.waitingReason = '等待补充';
    return task;
  }

  /**
   * Writes a supplement onto the task that asked for it. An empty note is refused.
   * The task id and the length of the task list stay the same.
   */
  supplement(taskId: string, viewer: Viewer, text: string, clientMessageId: string): { task: RoomTask; message: RoomMessage } {
    const task = this.editableTask(taskId, viewer);
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return { task, message: prior };
    const accepted = acceptSupplement(text);
    const id = task.id;
    const count = this.tasks.length;
    task.inputSupplement = accepted;
    if (task.waitingReason === '等待补充') {
      task.status = 'assigned';
      task.waitingReason = null;
    }
    if (task.id !== id || this.tasks.length !== count) throw new Error('task_replaced');
    const message = this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: viewer.userId,
      body: `已补充：${accepted}`,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'message',
    });
    return { task, message };
  }

  /** The task waits on one tool, named to the enterprise owner. The task itself is not replaced. */
  holdForPermission(taskId: string, viewer: Viewer, toolId: string): RoomTask {
    const id = toolId.trim();
    if (!id) throw new Error('missing_tool');
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (COMPLETED.has(task.status) || task.status === 'reported') throw new Error('task_reported');
    if (task.status === 'cancelled') throw new Error('task_closed');
    task.status = 'waiting';
    task.waitingReason = '等待企业负责人授权';
    task.hold = permissionHold(id);
    return task;
  }

  /**
   * Continues the same task only when the held tool is callable for that employee.
   * The route supplies that fact from the tool card. A request cannot set it.
   */
  releaseHold(taskId: string, viewer: Viewer, clientMessageId: string, gate: { toolUsable: boolean }): { task: RoomTask; message: RoomMessage } {
    const task = this.askedTask(taskId, viewer);
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return { task, message: prior };
    if (!task.hold) throw new Error('not_held');
    if (!gate.toolUsable) throw new Error('hold_not_satisfied');
    const id = task.id;
    task.hold = null;
    task.waitingReason = null;
    task.status = 'assigned';
    if (task.id !== id) throw new Error('task_replaced');
    const message = this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: viewer.userId,
      body: `已恢复：${task.title}`,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'message',
    });
    return { task, message };
  }

  /**
   * Work given to an employee that has since gone offline (paused, disconnected) waits for the connection.
   * The task is not cancelled, re-created or handed to someone else, and nothing starts the employee remotely.
   * Called before every room read and write, so the state the page shows is the state the server acts on.
   */
  holdDisconnected(): RoomMessage[] {
    const employees = this.employees();
    const held: RoomMessage[] = [];
    for (const task of this.tasks) {
      if (task.status !== 'assigned' && task.status !== 'running') continue;
      const employee = employees.find((item) => item.id === task.employeeId);
      if (ACTIVE(employee)) continue;
      task.status = 'waiting';
      task.waitingReason = WAITING_CONNECTION;
      held.push(this.push({
        roomId: task.roomId,
        tenantId: task.tenantId,
        authorUserId: 'super-agent',
        body: `@${employee?.name ?? '数字员工'} 已断开，任务「${task.title}」保留为等待连接，没有重建或转交。`,
        clientMessageId: `hold:${task.id}:${this.seq + 1}`,
        mentions: employee ? [employee.id] : [],
        taskIds: [task.id],
        kind: 'hold',
      }));
    }
    return held;
  }

  /**
   * The person who asked, or an owner, resumes the same task once its employee is connected again.
   * Still offline is refused; nothing is re-created, and the task keeps its id, source and history.
   */
  resume(taskId: string, viewer: Viewer, clientMessageId: string): RoomMessage {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return prior;
    if (task.status !== 'waiting' || task.waitingReason !== WAITING_CONNECTION) throw new Error('not_waiting');
    const employee = this.employees().find((item) => item.id === task.employeeId);
    if (!ACTIVE(employee)) throw new Error('employee_offline');
    task.status = 'assigned';
    task.waitingReason = null;
    return this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: 'super-agent',
      body: `@${employee!.name} 已重新连接，同一任务「${task.title}」继续进行，没有重建。`,
      clientMessageId,
      mentions: [employee!.id],
      taskIds: [task.id],
      kind: 'resume',
    });
  }

  /** Link the execution run that carries this task's external action. A task carries one run; it is never swapped. */
  linkRun(taskId: string, viewer: Viewer, runId: string): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (task.runId && task.runId !== runId) throw new Error('run_already_linked');
    task.runId = runId;
    return withDefaults(task);
  }

  /**
   * Set or revise what counts as done. Revising the contract (or setting a contract that existing evidence fails)
   * reopens a completed task to 'assigned' and the caller retires the linked run's action approval. Nothing here runs
   * or repeats an external action, and the task keeps its id, source, reports and run.
   */
  reviseContract(taskId: string, viewer: Viewer, criteria: string, clientMessageId: string): { message: RoomMessage; task: RoomTask; revised: boolean } {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return { message: prior, task: withDefaults(task), revised: false };
    const text = criteria.trim();
    if (!text || text.length > 2000) throw new Error('invalid_contract');
    if (task.status === 'cancelled') throw new Error('task_closed');
    if (task.contract?.criteria === text) throw new Error('contract_unchanged');
    const version = (task.contract?.version ?? 0) + 1;
    task.contract = { criteria: text, version, revisedByUserId: viewer.userId, at: this.now().toISOString() };
    const wasCompleted = COMPLETED.has(task.status) || task.status === 'reported';
    if (task.evidence?.fields.body) {
      task.verification = verificationOf(task.evidence, { contract: text });
    }
    if (wasCompleted && (version > 1 || task.verification === 'failed')) {
      task.status = 'assigned';
    }
    task.reviewedByUserId = null;
    const message = this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId: viewer.userId,
      body: version === 1
        ? `验收契约第 1 版：${text}`
        : `验收契约改为第 ${version} 版：${text}。之前的完成状态和动作批准作废；已有的外部提交和回读证据保留，不会自动重新执行。`,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
      kind: 'contract',
    });
    return { message, task: withDefaults(task), revised: version > 1 || (wasCompleted && task.status === 'assigned') };
  }

  /** Visible work only. An empty list is "暂无事项", never a made-up item. */
  summary(viewer: Viewer): { label: '暂无事项' | null; tasks: RoomTask[] } {
    const tasks = this.listTasks(viewer);
    return { label: summaryLabel(tasks.length), tasks };
  }

  /** A report may arrive while a workflow draft is open. The draft is returned untouched. */
  reportBesideDraft<T>(taskId: string, authorUserId: string, body: string, clientMessageId: string, draft: T): { message: RoomMessage; draft: T } {
    const message = this.report(taskId, authorUserId, body, clientMessageId);
    return { message, draft: applyAsyncReport(draft) };
  }

  /** One task as the caller may see it. */
  task(taskId: string, viewer: Viewer): RoomTask {
    return withDefaults(this.visibleTask(taskId, viewer));
  }

  /** Events with seq greater than lastSeq. Unknown rooms and non-members get nothing. */
  eventsAfter(roomId: string, lastSeq: number, viewer: Viewer): RoomMessage[] {
    if (!this.canSeeRoom(roomId, viewer)) return [];
    return this.messages.filter((message) => message.roomId === roomId && message.seq > lastSeq && this.canSeeMessage(message, viewer));
  }

  listTasks(viewer: Viewer, roomId?: string): RoomTask[] {
    return this.tasks.filter((task) => (roomId === undefined || task.roomId === roomId) && this.canSeeTask(task, viewer));
  }

  /** The asker, or an owner. Someone who cannot see the task gets task_not_found. */
  private askedTask(taskId: string, viewer: Viewer): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId) throw new Error('forbidden');
    if (task.status === 'cancelled' || COMPLETED.has(task.status)) throw new Error('task_closed');
    return task;
  }

  /** The asker, the assignee, or an owner. */
  private editableTask(taskId: string, viewer: Viewer): RoomTask {
    const task = this.visibleTask(taskId, viewer);
    if (!isOwner(viewer) && task.createdByUserId !== viewer.userId && task.assigneeUserId !== viewer.userId) throw new Error('forbidden');
    if (task.status === 'cancelled' || COMPLETED.has(task.status)) throw new Error('task_closed');
    return task;
  }

  private visibleTask(taskId: string, viewer: Viewer): RoomTask {
    const task = this.tasks.find((item) => item.id === taskId);
    // Someone who cannot see the task must not learn that it exists.
    if (!task || !this.canSeeTask(task, viewer)) throw new Error('task_not_found');
    return task;
  }

  private availability(viewer: Viewer): string {
    const online = this.roster(viewer).filter((employee) => employee.status === 'active');
    if (online.length === 0) return '当前没有在线的数字员工。';
    return `当前有 ${online.length} 名数字员工在线：${online.map((employee) => employee.name).join('、')}。`;
  }

  private canSeeRoom(roomId: string, viewer: Viewer): boolean {
    if (isOwner(viewer)) return true;
    if (this.members.get(roomId)?.has(viewer.userId)) return true;
    // Whoever answers for a digital employee follows that employee's work here.
    return roomId === 'room-1' && this.employees().some((employee) => employee.ownerUserId === viewer.userId);
  }

  private canSeeTask(task: RoomTask, viewer: Viewer): boolean {
    if (!isOwner(viewer) && task.assigneeUserId !== viewer.userId && task.createdByUserId !== viewer.userId) return false;
    if (viewer.projectScopes.length > 0 && task.projectId && !viewer.projectScopes.includes(task.projectId)) return false;
    return true;
  }

  /**
   * An owner reads the whole room. Anyone else reads what they wrote, the replies to it, and what is attached to a
   * task they can see. Other people's work stays out of view.
   */
  private canSeeMessage(message: RoomMessage, viewer: Viewer): boolean {
    if (isOwner(viewer)) return true;
    if (message.authorUserId === viewer.userId) return true;
    if (message.taskIds.length > 0) {
      return message.taskIds.some((id) => {
        const task = this.tasks.find((item) => item.id === id);
        return task !== undefined && this.canSeeTask(task, viewer);
      });
    }
    if (message.kind === 'reply' && message.clientMessageId.startsWith('reply:')) {
      const parent = this.messages.find((item) => item.id === message.clientMessageId.slice('reply:'.length));
      return parent !== undefined && this.canSeeMessage(parent, viewer);
    }
    // A mention that did not become a task (small talk, a refused request) stays between its author and the owner.
    return false;
  }

  private outsideProject(input: PostInput, original: RoomTask | null): boolean {
    const roles = input.authorRoles ?? [];
    if (roles.includes('owner') || roles.includes('admin') || roles.length === 0) return false;
    const projectId = input.projectId ?? original?.projectId ?? null;
    if (!projectId) return false;
    return !(input.authorProjectScopes ?? []).includes(projectId);
  }

  private resolveMentions(body: string): EmployeeRef[] {
    const names = [...body.matchAll(/@([^\s@]+)/gu)].map((match) => match[1] ?? '');
    const all = this.employees();
    const found: EmployeeRef[] = [];
    for (const name of names) {
      const employee = all.find((item) => item.name === name || item.id === name);
      if (employee && !found.some((item) => item.id === employee.id)) found.push(employee);
    }
    return found;
  }

  private push(input: Omit<RoomMessage, 'id' | 'seq'>): RoomMessage {
    const message: RoomMessage = { ...input, id: `msg_${this.seq + 1}`, seq: ++this.seq };
    this.messages.push(message);
    this.byClientId.set(`${message.roomId}:${message.clientMessageId}`, message);
    return message;
  }
}
