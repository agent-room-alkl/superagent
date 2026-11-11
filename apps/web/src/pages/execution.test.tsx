import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  actorLabel, applyAsyncReport, approvalLine, attemptsLine, CommandRoomPage, draftStorageKey, insertMention, mergeRoomMessages, messageKindLabel, nextRoomCursor,
  resultOverview, roomDraftKey, roomEventsFromSse, supplementError, taskActions, taskLine, taskReports, taskStatusLabel,
  unsentDraftBoundary,
  type ApiMessage, type ApiTask, type RosterEmployee,
} from './CommandRoomPage';
import { canDecide, decisionWhy, GROUPS, inboxFromServer, KIND_LABEL, RENDERER_LABEL, WorkInboxPage } from './WorkInboxPage';
import { navFor } from '../App';

const EMPLOYEES: RosterEmployee[] = [
  { id: 'emp-1', name: '销售员工', duty: '询价与报价', status: 'active', ownerUserId: 'user-sales' },
  { id: 'emp-2', name: '运营员工', duty: '库存', status: 'offline', ownerUserId: 'user-ops' },
];
const task = (over: Partial<ApiTask>): ApiTask => ({
  id: 't1', title: '整理询价草稿', status: 'assigned', assigneeUserId: 'user-sales', waitingReason: null,
  employeeId: 'emp-1', messageId: 'm1', createdByUserId: 'user-owner', followupTo: null, promptSnapshot: null, approval: 'none', reviewedByUserId: null,
  ...over,
});
const OWNER = { userId: 'user-owner', roles: ['owner'], owner: true };
const SALES = { userId: 'user-sales', roles: ['employee'], owner: false };

describe('execution pages reuse the v12 copy', () => {
  it('keeps the command room title and subtitle on one head, and shows no invented conversation or task', () => {
    const html = renderToStaticMarkup(<CommandRoomPage />);
    expect(html).toContain('Agent Room 指挥室');
    expect(html).toContain('同一件工作里，企业负责人、超级智能体和数字员工共享目标、上下文、任务与回报。');
    expect(html).toContain('共享协作记录');
    expect(html).toContain('不展示隐藏思维链');
    expect(html).toContain('同事的新消息不会清掉这里的草稿');
    expect(html).toContain('当前没有由对话产生的任务。');
    expect(html).toContain('暂无事项');
    expect(html).not.toContain('销售员工'); // nothing is written into the page; people and work come from the server
    expect(html).not.toContain('询价草稿');
    expect(html).not.toContain('模拟同事回报');
    expect(html).not.toContain('href="#brain"'); // only shown once the server says the viewer is an owner
  });

  it('reads a one-shot SSE gap-fill and ignores a frame whose sequence is not a number', () => {
    const events = roomEventsFromSse(
      [
        'id: 4',
        'data: {"id":"m4","seq":4,"authorUserId":"super-agent","body":"已交给 @销售员工","taskIds":["t1"]}',
        '',
        'data: {"id":"bad"}',
        '',
        'id: nope',
        'data: {"id":"m5","seq":"5","authorUserId":"user-sales","body":"询价草稿已放在对话里","taskIds":[]}',
        '',
        'data: not-json',
        '',
      ].join('\n'),
    );
    expect(events.map((message) => message.id)).toEqual(['m4', 'm5']);
    expect(nextRoomCursor(events, 0)).toBe(4);
    expect(roomEventsFromSse('')).toEqual([]);
    expect(roomDraftKey('Enter', false)).toBe('send');
    expect(roomDraftKey('Enter', true)).toBe('newline');
  });

  it('merges new messages in room order without replacing or repeating what is already shown', () => {
    const m = (id: string, seq: number): ApiMessage => ({ id, seq, authorUserId: 'user-owner', body: id, taskIds: [] });
    const shown = [m('m1', 1), m('m4', 4)];
    expect(mergeRoomMessages(shown, [])).toBe(shown);
    expect(mergeRoomMessages(shown, [m('m4', 4)])).toBe(shown);
    // the reply to my own send (seq 5, 6) is shown before the poll brings an earlier line from a colleague (seq 3)
    const afterSend = mergeRoomMessages(shown, [m('m5', 5), m('m6', 6)]);
    expect(mergeRoomMessages(afterSend, [m('m3', 3), m('m5', 5)]).map((message) => message.id)).toEqual(['m1', 'm3', 'm4', 'm5', 'm6']);
  });

  it('inserts a mention and keeps drafts apart per person', () => {
    expect(insertMention('', '销售员工')).toBe('@销售员工 ');
    expect(insertMention('@', '销售员工')).toBe('@销售员工 ');
    expect(insertMention('请看一下', '销售员工')).toBe('请看一下 @销售员工 ');
    expect(insertMention('请看一下 @', '销售员工')).toBe('请看一下 @销售员工 ');
    expect(draftStorageKey('user-owner')).not.toBe(draftStorageKey('user-sales'));
  });

  it('labels a server task by status and the employee it was given to', () => {
    expect(taskLine(task({ status: 'reported' }), EMPLOYEES)).toBe('已回报，待复核 · 销售员工');
    expect(taskLine(task({ status: 'waiting', waitingReason: '等待连接', employeeId: 'emp-2' }), EMPLOYEES)).toBe('等待连接 · 运营员工');
    expect(taskLine(task({ employeeId: 'emp-gone' }), EMPLOYEES)).toBe('进行中 · 数字员工');
    expect(taskStatusLabel({ status: 'reviewed', waitingReason: null })).toBe('已复核');
    expect(taskStatusLabel({ status: 'cancelled', waitingReason: null })).toBe('已取消');
  });

  it('names speakers and message kinds from the server data', () => {
    const tasks = [task({})];
    const source: ApiMessage = { id: 'm1', seq: 1, authorUserId: 'user-owner', body: '@销售员工 整理询价草稿', taskIds: ['t1'], kind: 'message' };
    const handover: ApiMessage = { id: 'm2', seq: 2, authorUserId: 'super-agent', body: '已交给 @销售员工', taskIds: ['t1'], kind: 'reply' };
    const report: ApiMessage = { id: 'm3', seq: 3, authorUserId: 'user-sales', body: '草稿已放在对话里', taskIds: ['t1'], kind: 'report' };
    const followup: ApiMessage = { id: 'm4', seq: 4, authorUserId: 'user-sales', body: '请补充交期', taskIds: ['t1'], kind: 'message' };
    expect([source, handover, report].map((message) => messageKindLabel(message, tasks))).toEqual(['派活', '任务', '回报']);
    expect(messageKindLabel({ ...handover, taskIds: [] }, tasks)).toBe('回复');
    expect(actorLabel(source, OWNER, tasks, EMPLOYEES)).toBe('我');
    expect(actorLabel(source, SALES, tasks, EMPLOYEES)).toBe('同事');
    expect(actorLabel(handover, OWNER, tasks, EMPLOYEES)).toBe('超级智能体');
    expect(actorLabel(report, OWNER, tasks, EMPLOYEES)).toBe('销售员工');
    // a follow-up written by the assignee is not evidence for the task
    expect(taskReports(tasks[0]!, [source, handover, report, followup]).map((message) => message.id)).toEqual(['m3']);
  });

  it('offers only the task actions this person may take', () => {
    expect(taskActions(task({}), null)).toEqual({ report: false, review: false, cancel: false, followup: false, resume: false, contract: false });
    expect(taskActions(task({}), OWNER)).toEqual({ report: false, review: false, cancel: true, followup: true, resume: false, contract: true });
    expect(taskActions(task({}), SALES)).toEqual({ report: true, review: false, cancel: false, followup: true, resume: false, contract: false });
    expect(taskActions(task({ status: 'reported' }), OWNER)).toEqual({ report: false, review: true, cancel: false, followup: true, resume: false, contract: true });
    expect(taskActions(task({ status: 'reported', createdByUserId: 'user-sales', assigneeUserId: 'user-sales' }), SALES).review).toBe(false);
    expect(taskActions(task({ status: 'reported', createdByUserId: 'user-owner', assigneeUserId: 'user-owner' }), OWNER).review).toBe(false);
    expect(taskActions(task({ status: 'reported', createdByUserId: 'user-owner', assigneeUserId: 'user-owner' }), { userId: 'user-reviewer', roles: ['reviewer'], owner: false }).review).toBe(true);
    expect(taskActions(task({ status: 'reviewed' }), SALES).report).toBe(false);
    expect(taskActions(task({ status: 'cancelled' }), OWNER)).toEqual({ report: false, review: false, cancel: false, followup: false, resume: false, contract: false });
    const draft = task({
      title: '整理询价草稿',
      evidence: { fields: { subject: '内部字段', body: '请核对报价' }, sent: false },
    });
    expect(unsentDraftBoundary(draft)).toBe('尚未发送');
    expect(resultOverview(draft)).toBe('整理询价草稿。尚未发送');
    expect(resultOverview(draft)).not.toContain('subject');
    expect(resultOverview(draft)).not.toContain('"subject"');
    expect(supplementError('  ')).toBe('请填写');
    expect(supplementError('客户ID C-DEMO-002')).toBeNull();
    const editing = { steps: [{ task: '保持正在编辑的业务步骤' }] };
    expect(applyAsyncReport(editing)).toBe(editing);
    // what counts as done is changed by whoever asked for the work
    expect(taskActions(task({ status: 'reviewed' }), OWNER).contract).toBe(true);
    expect(approvalLine({ id: 'a', status: 'decided', standing: true, actionStatus: null })).toBe('批准有效');
    expect(approvalLine({ id: 'a', status: 'closed', standing: false, actionStatus: null })).toBe('批准已作废');
    expect(approvalLine({ id: 'a', status: 'open', standing: false, actionStatus: null })).toBe('尚未批准');
    expect(attemptsLine({ attempts: 1, actions: [{ stepId: 'w', status: 'confirmed', calls: 1, externalRef: 'ERP-1', readback: {} }] })).toBe('外部提交 1 次，回读一致。修改验收契约不会重新提交。');
    expect(attemptsLine({ attempts: 0, actions: [] })).toBe('外部提交 0 次。修改验收契约不会重新提交。');
    // a task held for its disconnected employee is resumed by whoever asked for it, not by the assignee
    const held = task({ status: 'waiting', waitingReason: '等待连接' });
    expect(taskActions(held, OWNER).resume).toBe(true);
    expect(taskActions(held, SALES).resume).toBe(false);
    expect(taskActions(task({ status: 'waiting', waitingReason: '等待模型' }), OWNER).resume).toBe(false);
  });

  it('gives an employee-only sign-in the two daily pages and everyone else the full menu', () => {
    const ids = (roles: string[] | null) => navFor(roles).flatMap((group) => group.items.map((item) => item.id));
    expect(ids(['employee'])).toEqual(['room', 'work']);
    expect(ids(['owner'])).toHaveLength(7);
    expect(ids(['employee', 'reviewer'])).toHaveLength(7);
    expect(ids(null)).toHaveLength(7);
  });

  it('replaces the offline sample with the server list, including an empty inbox', () => {
    expect(inboxFromServer(undefined)).toBeNull();
    expect(inboxFromServer([])).toEqual([]);
    const [row] = inboxFromServer([{
      id: 'srv-1',
      kind: 'data_check',
      renderer: 'field_diff',
      status: 'open',
      payloadVersion: 3,
      actionStatus: null,
      payload: { title: '核对金额' },
    }]) ?? [];
    expect(row?.title).toBe('核对金额');
    expect(row?.fromServer).toBe(true);
    expect(row?.kind).toBe('数据核对与修正');
  });

  it('does not offer another decision after an unknown outcome', () => {
    expect(canDecide({ fromServer: true, actionStatus: 'outcome_unknown' })).toBe(false);
    expect(canDecide({ fromServer: true, actionStatus: null })).toBe(true);
    expect(canDecide({ fromServer: false, actionStatus: null })).toBe(false);
    expect(canDecide({ fromServer: true, actionStatus: 'confirmed' })).toBe(false);
    expect(decisionWhy('already_executed', '')).toContain('新的动作需要新的批准');
    expect(decisionWhy('no_resubmit', '原来的说明')).toBe('结果未知，不能再次提交。');
    expect(decisionWhy('invalid_amount', '原来的说明')).toBe('金额无效，不能确认。');
    expect(decisionWhy('version_conflict', '原来的说明')).toBe('版本已变，请按新版本再决定。');
    expect(decisionWhy(undefined, '原来的说明')).toBe('原来的说明');
  });

  it('starts with no sample items, and keeps the seven kinds, four renderers and three groups', () => {
    const html = renderToStaticMarkup(<WorkInboxPage />);
    expect(html).toContain('待我处理');
    expect(html).toContain('核对数据、作决定、亲自完成工作；每一步都有证据和下一位责任人。');
    expect(html).toContain('正在读取');
    expect(html).not.toContain('核对拟写入的报价金额'); // the old prototype sample is gone
    for (const label of ['需要我行动', '等待外部', '内部未完']) expect(html).toContain(label);
    expect(Object.values(KIND_LABEL)).toEqual(['数据核对与修正', '精确动作批准', '人工执行并回填', '正常分支选择', '例外裁定', '补资料', '成果复核']);
    expect(Object.values(RENDERER_LABEL)).toEqual(['字段差异卡', '批量明细表', '邮件 / 文档预览', '问题清单']);
    expect(GROUPS.map((g) => g.label)).toEqual(['需要我行动', '等待外部', '内部未完']);
  });
});
