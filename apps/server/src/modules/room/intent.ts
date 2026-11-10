/**
 * What a command-room message is asking for. These are fixed wording rules, not a model call: they decide only
 * whether a message may become a task. Anything they do not recognise is treated as discussion and gets a question
 * back, so a wrong guess costs one more message and never an unwanted task.
 */

const GREETING = /^(你好|您好|早上好|下午好|晚上好|在吗|hi|hello|hey)[!！。.?？~\s]*$/iu;

const AVAILABILITY = /(哪些|有没有|多少|几[个名位]).*(数字员工|员工|同事)|(数字员工|员工|同事).*(在线|有空|能用|可用|能不能用)|能不能用|可以用吗|谁在线/u;

/** Verbs that change something outside the platform: sending, paying, ordering. */
const EXTERNAL = /(发送|发出|发给|发邮件|寄给|寄出|付款|支付|转账|汇款|下单|退款|开票)/u;

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/u;
const QUOTED = /[「『“"][^」』”"]+[」』”"]/u;
/** A document or record number such as Q-1001, INV2024-07 or C-DEMO-002. */
const RECORD = /[A-Za-z]+(?:-[A-Za-z0-9]+)*-?\d{2,}/u;

export function isGreeting(body: string): boolean {
  return GREETING.test(body.trim());
}

export function asksAvailability(body: string): boolean {
  return AVAILABILITY.test(body);
}

export function isExternalAction(body: string): boolean {
  return EXTERNAL.test(body);
}

/** The message with its @mentions removed: what is left is the work being asked for. */
export function workText(body: string): string {
  return body.replace(/@[^\s@]+/gu, ' ').replace(/[ \t]+/gu, ' ').trim();
}

/**
 * An outward action with nobody and nothing named ("发送邮件给客户"). A recipient address, a quoted name or a
 * record number counts as a concrete object; without one the room asks before it hands the work over.
 */
export function needsParameters(body: string): boolean {
  if (!isExternalAction(body)) return false;
  const text = workText(body);
  return !(EMAIL.test(text) || QUOTED.test(text) || RECORD.test(text));
}
