/**
 * The original business request from the enablement prototype.
 * A tool becoming available does not create one, and resuming one never calls a tool.
 */

export type OriginalRequestStatus = 'needs_tool' | 'ready' | 'paused' | 'cancelled';

export interface OriginalRequest {
  id: string;
  toolId: string;
  target: string;
  title: string;
  status: OriginalRequestStatus;
  note: string;
  /** Resume never flips this. The request is waiting, not executed. */
  executed: false;
}

export type SopNodeMode = 'tool' | 'manual' | 'blocked';

const KEPT = '保留原请求ID、工具占位ID和目标员工；还未执行外部动作。';
const SOP_WAITING = '流程尚未按当前知识确认发布，原请求继续等待。';
const TOOL_WAITING = '仍缺当前目标员工的有效工具/连接/来源；保留原请求，不能借另一员工的账号。';
const RESUMED = '从同一REQ恢复为待执行；保留原对象与工具版本，没有重复创建任务或执行外部调用。';

/** An unusable node stays blocked unless the owner has explicitly chosen a manual fallback. */
export function sopNodeMode(node: { usable: boolean; manualFallback: boolean }): SopNodeMode {
  if (node.usable) return 'tool';
  if (node.manualFallback) return 'manual';
  return 'blocked';
}

export class OriginalRequests {
  private serial = 0;
  private items: OriginalRequest[] = [];

  list(): OriginalRequest[] {
    return this.items.map((item) => ({ ...item }));
  }

  /** One request per tool. A second call returns the existing one and does not run anything. */
  create(input: { toolId: string; target: string; title: string }): OriginalRequest {
    const existing = this.items.find((item) => item.toolId === input.toolId);
    if (existing) return { ...existing };
    const created: OriginalRequest = {
      id: `REQ-${++this.serial}`,
      toolId: input.toolId,
      target: input.target,
      title: input.title,
      status: 'needs_tool',
      note: KEPT,
      executed: false,
    };
    this.items.push(created);
    return { ...created };
  }

  /**
   * Check the same request. A paused or cancelled request stays put.
   * A missing SOP confirmation or an unusable tool leaves the status waiting.
   * A pass marks it ready and does not create another request or an execution.
   */
  resume(id: string, gate: { sopConfirmed: boolean; toolUsable: boolean }): OriginalRequest | null {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || item.status === 'paused' || item.status === 'cancelled') return item ? { ...item } : null;
    if (!gate.sopConfirmed) {
      item.note = SOP_WAITING;
      return { ...item };
    }
    if (!gate.toolUsable) {
      item.note = TOOL_WAITING;
      return { ...item };
    }
    item.status = 'ready';
    item.note = RESUMED;
    return { ...item };
  }

  /** Pause, or lift a pause back to waiting. A cancelled request is left alone. */
  pause(id: string): OriginalRequest | null {
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item || item.status === 'cancelled') return item ? { ...item } : null;
    item.status = item.status === 'paused' ? 'needs_tool' : 'paused';
    return { ...item };
  }
}
