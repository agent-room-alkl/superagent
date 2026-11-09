import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { assigneeForReport, CommandRoomPage, nextRoomCursor, roomEventsFromSse, taskLine } from './CommandRoomPage';
import { canDecide, decisionWhy, inboxFromServer, WorkInboxPage } from './WorkInboxPage';

describe('execution pages reuse the v12 copy', () => {
  it('keeps the command room title and subtitle on one head, with the shared transcript', () => {
    const html = renderToStaticMarkup(<CommandRoomPage />);
    expect(html).toContain('Agent Room 指挥室');
    expect(html).toContain('同一件工作里，企业负责人、超级智能体和数字员工共享目标、上下文、任务与回报。');
    expect(html).toContain('共享协作记录');
    expect(html).toContain('不展示隐藏思维链');
    expect(html).toContain('@销售员工 整理询价草稿');
    expect(html).toContain('同事的新消息不会清掉这里的草稿');
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
  });

  it('labels a server task by status and assignee', () => {
    expect(taskLine({ id: 't1', title: '整理询价草稿', status: 'reported', assigneeUserId: 'user-sales', waitingReason: null })).toBe('已回报 · 销售员工');
    expect(taskLine({ id: 't2', title: '核对库存', status: 'waiting', assigneeUserId: 'user-ops', waitingReason: '等待连接' })).toBe('等待连接 · 运营员工');
    expect(taskLine({ id: 't3', title: '整理询价草稿', status: 'assigned', assigneeUserId: 'user-owner', waitingReason: null })).toBe('进行中 · 负责人');
  });

  it('reports as the assignee of the current task, and keeps that user when the payload lags', () => {
    const tasks = [
      { id: 'sales', assigneeUserId: 'user-sales' },
      { id: 'ops', assigneeUserId: 'user-ops' },
    ];
    expect(assigneeForReport(tasks, null)).toEqual({ taskId: 'sales', userId: 'user-sales' });
    expect(assigneeForReport(tasks, 'ops')).toEqual({ taskId: 'ops', userId: 'user-ops' });
    expect(assigneeForReport([], 'ops', 'user-ops')).toEqual({ taskId: 'ops', userId: 'user-ops' });
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
    expect(decisionWhy('no_resubmit', '原来的说明')).toBe('结果未知，不能再次提交。');
    expect(decisionWhy('invalid_amount', '原来的说明')).toBe('金额无效，不能确认。');
    expect(decisionWhy('version_conflict', '原来的说明')).toBe('版本已变，请按新版本再决定。');
    expect(decisionWhy(undefined, '原来的说明')).toBe('原来的说明');
  });

  it('lists the seven work-item kinds, four renderers, and the three inbox groups', () => {
    const html = renderToStaticMarkup(<WorkInboxPage />);
    expect(html).toContain('待我处理');
    expect(html).toContain('核对数据、作决定、亲自完成工作；每一步都有证据和下一位责任人。');
    for (const label of ['需要我行动', '等待外部', '内部未完']) expect(html).toContain(label);
    for (const kind of ['数据核对与修正', '精确动作批准', '人工执行并回填', '正常分支选择', '例外裁定', '补资料', '成果复核']) {
      expect(html).toContain(kind);
    }
    for (const renderer of ['字段差异卡', '批量明细表', '邮件 / 文档预览', '问题清单']) expect(html).toContain(renderer);
  });
});
