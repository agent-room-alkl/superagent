import { useEffect, useState } from 'react';
import './execution.css';

type Group = 'action' | 'waiting' | 'internal';

interface InboxItem {
  id: string;
  title: string;
  kind: string;
  renderer: string;
  group: Group;
  due: string;
  why: string;
  payloadVersion: number;
  fromServer: boolean;
  actionStatus: string | null;
}

/** An unknown write stays submitted once. The inbox does not offer another decide. */
export function canDecide(item: Pick<InboxItem, 'fromServer' | 'actionStatus'>): boolean {
  return item.fromServer && item.actionStatus !== 'outcome_unknown';
}

export function decisionWhy(reason: string | undefined, current: string): string {
  if (reason === 'version_conflict') return '版本已变，请按新版本再决定。';
  if (reason === 'no_resubmit') return '结果未知，不能再次提交。';
  if (reason === 'invalid_amount') return '金额无效，不能确认。';
  return current;
}

interface ServerWorkItem {
  id: string;
  kind: string;
  renderer: string;
  status: string;
  payloadVersion: number;
  actionStatus: string | null;
  payload: Record<string, unknown>;
}

/** A successful list replaces the offline sample. An empty list stays empty. */
export function inboxFromServer(items: ServerWorkItem[] | undefined): InboxItem[] | null {
  if (!items) return null;
  return items.map((item) => ({
    id: item.id,
    title: String(item.payload.title ?? KIND_LABEL[item.kind] ?? item.kind),
    kind: KIND_LABEL[item.kind] ?? item.kind,
    renderer: RENDERER_LABEL[item.renderer] ?? item.renderer,
    group: item.status === 'needs_info' ? 'internal' : item.status === 'open' ? 'action' : 'waiting',
    due: '由服务端给出',
    why: '这条来自服务端，只包含分给你的事项。',
    payloadVersion: item.payloadVersion,
    fromServer: true,
    actionStatus: item.actionStatus,
  }));
}

/** Labels and grouping from the v12 待我处理 prototype and PRD §3.8. */
const ITEMS: InboxItem[] = [
  { id: 'hw-1', title: '核对拟写入的报价金额', kind: '数据核对与修正', renderer: '字段差异卡', group: 'action', due: '今天 16:00', why: '金额和来源不一致，需要人确认。', payloadVersion: 1, fromServer: false, actionStatus: null },
  { id: 'hw-2', title: '批准这一次发信', kind: '精确动作批准', renderer: '邮件 / 文档预览', group: 'action', due: '今天 17:00', why: '外发前必须由有权的人批准这一份载荷。', payloadVersion: 1, fromServer: false, actionStatus: null },
  { id: 'hw-3', title: '只批准勾选的干净行', kind: '精确动作批准', renderer: '批量明细表', group: 'action', due: '明天 09:00', why: '例外行留在清单里，不会跟着被执行。', payloadVersion: 1, fromServer: false, actionStatus: null },
  { id: 'hw-4', title: '在客户系统里登记报价号', kind: '人工执行并回填', renderer: '问题清单', group: 'waiting', due: '周五', why: '外部系统还没有回读到凭证。', payloadVersion: 1, fromServer: false, actionStatus: null },
  { id: 'hw-5', title: '选择走标准报价还是例外', kind: '正常分支选择', renderer: '问题清单', group: 'internal', due: '明天 12:00', why: '规则要求负责人选定路径。', payloadVersion: 1, fromServer: false, actionStatus: null },
  { id: 'hw-6', title: '裁定没有依据的折扣', kind: '例外裁定', renderer: '问题清单', group: 'action', due: '今天 18:00', why: '资料里没有可引用的折扣规则。', payloadVersion: 1, fromServer: false, actionStatus: null },
  { id: 'hw-7', title: '补上客户的税号', kind: '补资料', renderer: '字段差异卡', group: 'internal', due: '明天 15:00', why: '缺这个字段就不能继续。', payloadVersion: 1, fromServer: false, actionStatus: null },
  { id: 'hw-8', title: '复核询价草稿', kind: '成果复核', renderer: '邮件 / 文档预览', group: 'action', due: '周五 11:00', why: '交付需要逐项接受，复核本身不能外发。', payloadVersion: 1, fromServer: false, actionStatus: null },
];

const GROUPS: { id: Group; label: string }[] = [
  { id: 'action', label: '需要我行动' },
  { id: 'waiting', label: '等待外部' },
  { id: 'internal', label: '内部未完' },
];

const KIND_LABEL: Record<string, string> = {
  data_check: '数据核对与修正',
  action_approval: '精确动作批准',
  manual_execution: '人工执行并回填',
  branch_choice: '正常分支选择',
  exception_ruling: '例外裁定',
  supply_info: '补资料',
  deliverable_review: '成果复核',
};

const RENDERER_LABEL: Record<string, string> = {
  field_diff: '字段差异卡',
  batch_table: '批量明细表',
  document_preview: '邮件 / 文档预览',
  issue_list: '问题清单',
};

export function WorkInboxPage() {
  const [items, setItems] = useState(ITEMS);
  const [group, setGroup] = useState<Group | 'all'>('all');
  const [openId, setOpenId] = useState<string | null>(ITEMS[0]?.id ?? null);

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const response = await fetch('/api/v1/work-items', { headers: { 'x-user-id': 'user-sales', 'x-roles': 'employee' } });
        if (!response.ok) return;
        const data = (await response.json()) as { items?: ServerWorkItem[] };
        const next = inboxFromServer(data.items);
        if (stop || next === null) return;
        setItems(next);
        setOpenId(next[0]?.id ?? null);
      } catch {
        // Keep the prototype list when the API is not running.
      }
    }
    void load();
    return () => {
      stop = true;
    };
  }, []);

  const visible = items.filter((item) => group === 'all' || item.group === group);
  const open = items.find((item) => item.id === openId) ?? null;

  async function decideOpen() {
    if (!open || !canDecide(open)) return;
    const response = await fetch(`/api/v1/work-items/${open.id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user-sales', 'x-roles': 'employee' },
      body: JSON.stringify({ expectedVersion: open.payloadVersion }),
    });
    if (!response.ok) return;
    const data = (await response.json()) as { ok: boolean; reason?: string; item?: { payloadVersion: number; actionStatus: string | null } };
    setItems((current) => current.map((item) => {
      if (item.id !== open.id || !data.item) return item;
      return {
        ...item,
        payloadVersion: data.item.payloadVersion,
        actionStatus: data.reason === 'no_resubmit' ? 'outcome_unknown' : data.item.actionStatus,
        why: decisionWhy(data.reason, item.why),
      };
    }));
  }

  return (
    <section className="exec-inbox" aria-label="待我处理">
      <div className="page-head">
        <h1>待我处理</h1>
        <p>核对数据、作决定、亲自完成工作；每一步都有证据和下一位责任人。</p>
      </div>
      <div className="exec-toolbar">
        <label>
          工作状态
          <select value={group} onChange={(event) => setGroup(event.target.value as Group | 'all')}>
            <option value="all">在办事项（分组）</option>
            <option value="action">需要我行动</option>
            <option value="waiting">等待外部</option>
            <option value="internal">内部未完</option>
          </select>
        </label>
        <p>当前身份只能看到分给自己的事项。名单由服务端按角色过滤。</p>
      </div>
      <div className="exec-grid">
        <div className="panel exec-pane">
          <div className="exec-scroll">
            {visible.length === 0 ? <p>当前没有分给你的事项。</p> : null}
            {GROUPS.map((section) => {
              const rows = visible.filter((item) => item.group === section.id);
              if (rows.length === 0) return null;
              return (
                <section key={section.id} aria-label={section.label}>
                  <h2 className="exec-group">{section.label}</h2>
                  {rows.map((item) => (
                    <button key={item.id} type="button" className="exec-task" onClick={() => setOpenId(item.id)} aria-current={item.id === openId ? 'true' : undefined}>
                      <strong>{item.title}</strong>
                      <span>{item.kind} · {item.renderer} · 截止 {item.due}</span>
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        </div>
        {open ? (
          <aside className="panel exec-drawer" aria-label="工作项">
            <div className="exec-pane-head">
              <h2>{open.renderer}</h2>
              <span>{open.kind}</span>
            </div>
            <p>{open.why}</p>
            {canDecide(open) ? <button type="button" onClick={() => void decideOpen()}>按版本 {open.payloadVersion} 决定</button> : null}
            {open.actionStatus === 'outcome_unknown' ? <p>结果未知，不能再次提交。</p> : null}
            <dl>
              <div><dt>为什么需要人</dt><dd>{open.why}</dd></div>
              <div><dt>截止</dt><dd>{open.due}</dd></div>
              <div><dt>完成之后</dt><dd>批准只改变决定，执行前会重新鉴权并回读。</dd></div>
            </dl>
          </aside>
        ) : null}
      </div>
    </section>
  );
}
