/**
 * Supervised computer use (T-43). The model looks at screenshots and proposes actions; this policy decides what may run.
 * - Default mode is read-only exploration: observe and navigate are allowed; typing and submitting are blocked.
 * - A state-changing action can run only with an exact approval bound to the hash of that action, and the approval is
 *   consumed on use. Anything ambiguous is treated as state-changing.
 * - Only models whose verified capabilities include computer use may be used (Setup allowlist).
 */
import { createHash } from 'node:crypto';

export type CuAction =
  | { kind: 'screenshot' }
  | { kind: 'scroll'; dx: number; dy: number }
  | { kind: 'wait'; ms: number }
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; x: number; y: number; label?: string }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string };

const WRITE_LABEL = /(submit|save|confirm|send|pay|delete|remove|approve|update|create|apply|提交|保存|确认|发送|付款|删除|批准|更新|创建)/i;

export function classify(a: CuAction): 'observe' | 'navigate' | 'write' {
  switch (a.kind) {
    case 'screenshot':
    case 'scroll':
    case 'wait':
      return 'observe';
    case 'navigate':
      return 'navigate';
    case 'click':
      return a.label && !WRITE_LABEL.test(a.label) ? 'navigate' : 'write'; // unlabeled clicks are treated as writes
    case 'type':
    case 'key':
      return 'write';
  }
}

export function actionHash(a: CuAction): string {
  return createHash('sha256').update(JSON.stringify(a)).digest('hex');
}

export interface Decision {
  allowed: boolean;
  reason: 'observe' | 'navigate' | 'approved_write' | 'needs_approval' | 'egress_blocked';
  workItem?: { kind: 'action_approval'; actionHash: string; action: CuAction };
}

export class ComputerUsePolicy {
  private approvals = new Set<string>();
  constructor(private isAllowedUrl: (url: string) => boolean) {}

  /** Called by the human work-item flow when an approver approves this exact action. */
  approve(hash: string): void {
    this.approvals.add(hash);
  }

  decide(a: CuAction): Decision {
    if (a.kind === 'navigate' && !this.isAllowedUrl(a.url)) return { allowed: false, reason: 'egress_blocked' };
    const c = classify(a);
    if (c === 'observe') return { allowed: true, reason: 'observe' };
    if (c === 'navigate') return { allowed: true, reason: 'navigate' };
    const h = actionHash(a);
    if (this.approvals.delete(h)) return { allowed: true, reason: 'approved_write' }; // single use
    return { allowed: false, reason: 'needs_approval', workItem: { kind: 'action_approval', actionHash: h, action: a } };
  }
}

/** Gate on the Setup allowlist: the selected model must have passed the computer-use capability test. */
export function assertComputerUseCapable(verified: { computerUse?: boolean } | null | undefined): void {
  if (!verified?.computerUse) throw new Error('selected model has not passed the computer-use capability test');
}
