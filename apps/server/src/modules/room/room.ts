import type { TaskStatus } from '@superagent/shared';

export interface Viewer {
  userId: string;
  roles: Array<'admin' | 'owner' | 'employee' | 'reviewer'>;
  projectScopes: string[];
}

export interface EmployeeRef {
  id: string;
  name: string;
  ownerUserId: string;
  status: 'active' | 'paused' | 'offline' | 'unconnected';
}

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
}

const GREETING = /^(你好|您好|hi|hello|hey)[!！。.\s]*$/iu;

function isOwner(viewer: Viewer): boolean {
  return viewer.roles.includes('owner') || viewer.roles.includes('admin');
}

/**
 * Command room (PRD §3.7). Messages and tasks stay in the store across reloads.
 * SSE clients pass the last seq they rendered; the same client message id posts once.
 */
export class CommandRoom {
  private seq = 0;
  private readonly messages: RoomMessage[] = [];
  private readonly tasks: RoomTask[] = [];
  private readonly byClientId = new Map<string, RoomMessage>();
  private readonly members = new Map<string, Set<string>>();
  private readonly employees: EmployeeRef[];

  constructor(employees: EmployeeRef[]) {
    this.employees = employees;
  }

  /** Enough state to rebuild the room after a process restart. */
  snapshot(): RoomSnapshot {
    return {
      seq: this.seq,
      messages: this.messages.map((message) => ({ ...message, mentions: [...message.mentions], taskIds: [...message.taskIds] })),
      tasks: this.tasks.map((task) => ({ ...task })),
      members: [...this.members.entries()].map(([roomId, userIds]) => ({ roomId, userIds: [...userIds] })),
    };
  }

  static restore(employees: EmployeeRef[], saved: RoomSnapshot): CommandRoom {
    const room = new CommandRoom(employees);
    room.seq = saved.seq;
    for (const message of saved.messages) {
      const copy = { ...message, mentions: [...message.mentions], taskIds: [...message.taskIds] };
      room.messages.push(copy);
      room.byClientId.set(`${copy.roomId}:${copy.clientMessageId}`, copy);
    }
    for (const task of saved.tasks) room.tasks.push({ ...task });
    for (const member of saved.members) room.members.set(member.roomId, new Set(member.userIds));
    return room;
  }

  addMember(roomId: string, userId: string): void {
    const set = this.members.get(roomId) ?? new Set<string>();
    set.add(userId);
    this.members.set(roomId, set);
  }

  post(input: PostInput): { message: RoomMessage; reply: RoomMessage | null; task: RoomTask | null; duplicate: boolean } {
    const key = `${input.roomId}:${input.clientMessageId}`;
    const prior = this.byClientId.get(key);
    if (prior) {
      const task = this.tasks.find((item) => item.messageId === prior.id) ?? null;
      return { message: prior, reply: null, task, duplicate: true };
    }

    const mentions = this.resolveMentions(input.body);
    const message = this.push({
      roomId: input.roomId,
      tenantId: input.tenantId,
      authorUserId: input.authorUserId,
      body: input.body,
      clientMessageId: input.clientMessageId,
      mentions: mentions.map((employee) => employee.id),
      taskIds: [],
    });
    this.byClientId.set(key, message);

    if (mentions.length > 0 && this.outsideProject(input)) {
      const reply = this.push({
        roomId: input.roomId,
        tenantId: input.tenantId,
        authorUserId: 'super-agent',
        body: '这超出了你的项目范围，我不会创建这个任务。',
        clientMessageId: `reply:${message.id}`,
        mentions: [],
        taskIds: [],
      });
      return { message, reply, task: null, duplicate: false };
    }

    if (GREETING.test(input.body.trim()) || mentions.length === 0) {
      const reply = this.push({
        roomId: input.roomId,
        tenantId: input.tenantId,
        authorUserId: 'super-agent',
        body: mentions.length === 0
          ? '你好。需要派活时直接 @数字员工，并说清楚要做的事。'
          : `已看到 @${mentions.map((employee) => employee.name).join(' @')}，这条还不是明确的工作请求。`,
        clientMessageId: `reply:${message.id}`,
        mentions: [],
        taskIds: [],
      });
      return { message, reply, task: null, duplicate: false };
    }

    const employee = mentions[0]!;
    const offline = employee.status === 'paused' || employee.status === 'offline' || employee.status === 'unconnected';
    const modelDown = input.modelAvailable === false;
    const waiting = offline || modelDown;
    const task: RoomTask = {
      id: `task_${message.seq}`,
      tenantId: input.tenantId,
      roomId: input.roomId,
      projectId: input.projectId ?? null,
      messageId: message.id,
      assigneeUserId: employee.ownerUserId,
      employeeId: employee.id,
      title: input.body.trim(),
      status: waiting ? 'waiting' : 'assigned',
      waitingReason: modelDown ? '等待模型' : offline ? '等待连接' : null,
    };
    this.tasks.push(task);
    message.taskIds = [task.id];
    const reply = this.push({
      roomId: input.roomId,
      tenantId: input.tenantId,
      authorUserId: 'super-agent',
      body: modelDown
        ? '暂时无法处理。任务已保留，状态是等待模型。'
        : waiting
          ? `已把这件事交给 @${employee.name}，对方当前${employee.status === 'paused' ? '已暂停' : '不在线'}，任务标为等待连接。`
          : `已交给 @${employee.name}：${task.title}`,
      clientMessageId: `reply:${message.id}`,
      mentions: [employee.id],
      taskIds: [task.id],
    });
    return { message, reply, task, duplicate: false };
  }

  report(taskId: string, authorUserId: string, body: string, clientMessageId: string): RoomMessage {
    const task = this.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error('task_not_found');
    if (task.assigneeUserId !== authorUserId) throw new Error('not_assignee');
    const prior = this.byClientId.get(`${task.roomId}:${clientMessageId}`);
    if (prior) return prior;
    task.status = 'reported';
    return this.push({
      roomId: task.roomId,
      tenantId: task.tenantId,
      authorUserId,
      body,
      clientMessageId,
      mentions: [],
      taskIds: [task.id],
    });
  }

  /** Events with seq greater than lastSeq. Unknown rooms and non-members get nothing. */
  eventsAfter(roomId: string, lastSeq: number, viewer: Viewer): RoomMessage[] {
    if (!this.canSeeRoom(roomId, viewer)) return [];
    return this.messages.filter((message) => message.roomId === roomId && message.seq > lastSeq);
  }

  listTasks(viewer: Viewer): RoomTask[] {
    return this.tasks.filter((task) => this.canSeeTask(task, viewer));
  }

  private canSeeRoom(roomId: string, viewer: Viewer): boolean {
    if (isOwner(viewer)) return true;
    return this.members.get(roomId)?.has(viewer.userId) ?? false;
  }

  private canSeeTask(task: RoomTask, viewer: Viewer): boolean {
    if (!isOwner(viewer) && task.assigneeUserId !== viewer.userId) return false;
    if (viewer.projectScopes.length > 0 && task.projectId && !viewer.projectScopes.includes(task.projectId)) return false;
    return true;
  }

  private outsideProject(input: PostInput): boolean {
    const roles = input.authorRoles ?? [];
    if (roles.includes('owner') || roles.includes('admin') || roles.length === 0) return false;
    if (!input.projectId) return false;
    return !(input.authorProjectScopes ?? []).includes(input.projectId);
  }

  private resolveMentions(body: string): EmployeeRef[] {
    const names = [...body.matchAll(/@([^\s@]+)/gu)].map((match) => match[1] ?? '');
    const found: EmployeeRef[] = [];
    for (const name of names) {
      const employee = this.employees.find((item) => item.name === name || item.id === name);
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
