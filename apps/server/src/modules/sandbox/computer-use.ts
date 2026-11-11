/**
 * Supervised computer use (T-43). The model looks at screenshots and proposes actions; this policy decides what may run.
 * - Default mode is read-only exploration: observe and navigate are allowed; typing and submitting are blocked.
 * - A state-changing action can run only with an exact approval bound to the hash of that action, and the approval is
 *   consumed on use. Anything ambiguous is treated as state-changing.
 * - Only models whose verified capabilities include computer use may be used (Setup allowlist).
 */
import { createHash } from 'node:crypto';

export interface ClickTarget {
  tagName?: string;
  role?: string | null;
  type?: string | null;
  inForm?: boolean;
  submits?: boolean;
  href?: string | null;
  text?: string | null;
}

export type CuAction =
  | { kind: 'screenshot' }
  | { kind: 'scroll'; dx: number; dy: number }
  | { kind: 'wait'; ms: number }
  | { kind: 'navigate'; url: string }
  | { kind: 'click'; x: number; y: number; label?: string; target?: ClickTarget | null }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string };

const WRITE_LABEL = /(submit|save|confirm|send|pay|delete|remove|approve|update|create|apply|提交|保存|确认|发送|付款|删除|批准|更新|创建)/i;
const WRITE_TAGS = new Set(['input', 'textarea', 'select', 'option', 'form']);
const WRITE_ROLES = new Set([
  'textbox',
  'checkbox',
  'radio',
  'switch',
  'combobox',
  'listbox',
  'menuitemcheckbox',
  'menuitemradio',
  'spinbutton',
  'searchbox',
  'slider',
]);
const NAV_ROLES = new Set(['link', 'tab', 'menuitem']);

function isSafeNavigateTarget(el: ClickTarget | null | undefined): boolean {
  if (!el) return false;
  const tag = (el.tagName ?? '').toLowerCase();
  const role = (el.role ?? '').toLowerCase();
  const type = (el.type ?? '').toLowerCase();
  if (el.submits || el.inForm) return false;
  if (type === 'submit' || type === 'image' || type === 'reset') return false;
  if (WRITE_TAGS.has(tag) || WRITE_ROLES.has(role)) return false;
  if (el.text && WRITE_LABEL.test(el.text)) return false;
  if (tag === 'a' || NAV_ROLES.has(role)) return true;
  if ((tag === 'button' || role === 'button') && type === 'button') return true;
  return false;
}

/**
 * Classifies a computer-use action.
 * For clicks, model-supplied `a.label` is never trusted to downgrade an action to `navigate`; classification inspects
 * the real DOM element at the coordinates (`role`, `type=submit`, `inForm`, `submits`) and falls back to `write` when
 * element metadata is unavailable.
 */
export function classify(a: CuAction, target?: ClickTarget | null): 'observe' | 'navigate' | 'write' {
  switch (a.kind) {
    case 'screenshot':
    case 'scroll':
    case 'wait':
      return 'observe';
    case 'navigate':
      return 'navigate';
    case 'click': {
      const el = target !== undefined ? target : a.target;
      return isSafeNavigateTarget(el) ? 'navigate' : 'write';
    }
    case 'type':
    case 'key':
      return 'write';
  }
}

export function actionHash(a: CuAction): string {
  const canonical: CuAction =
    a.kind === 'click'
      ? { kind: 'click', x: a.x, y: a.y, ...(a.label !== undefined ? { label: a.label } : {}) }
      : a;
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
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

  decide(a: CuAction, target?: ClickTarget | null): Decision {
    if (a.kind === 'navigate' && !this.isAllowedUrl(a.url)) return { allowed: false, reason: 'egress_blocked' };
    if (a.kind === 'click') {
      const el = target !== undefined ? target : a.target;
      if (el?.href && !el.href.startsWith('#') && !el.href.toLowerCase().startsWith('javascript:') && !this.isAllowedUrl(el.href)) {
        return { allowed: false, reason: 'egress_blocked' };
      }
    }
    const c = classify(a, target);
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
