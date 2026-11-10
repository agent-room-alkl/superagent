import { formatInTimeZone, zonedTimeToUtc } from '../sop/zoned-time.js';
import type { State } from './store.js';
export type DateRule = State['rules'][number];

function dateOnly(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw Error('invalid_date_field');
  const d = new Date(`${raw}T00:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== raw) throw Error('invalid_date_field');
  return d;
}
export function validateRule(rule: DateRule): void {
  if (!rule.id || !rule.field || !Number.isInteger(rule.version) || rule.version < 1 || !Number.isInteger(rule.offsetDays) || Math.abs(rule.offsetDays) > 3660 ||
    !Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23 || !Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59 ||
    !Array.isArray(rule.weekend) || rule.weekend.length === 7 || rule.weekend.some(x => !Number.isInteger(x) || x < 0 || x > 6) ||
    !Array.isArray(rule.holidays)) throw Error('invalid_date_rule');
  new Intl.DateTimeFormat('en', { timeZone: rule.timeZone });
  rule.holidays.forEach(dateOnly);
}

/** Calendar arithmetic happens on local dates, never by adding 24h to a zoned instant. */
export function objectDue(rule: DateRule, fields: Record<string, unknown>) {
  validateRule(rule);
  const d = dateOnly(fields[rule.field]);
  const direction = Math.sign(rule.offsetDays);
  let remaining = Math.abs(rule.offsetDays);
  const business = () => !rule.weekend.includes(d.getUTCDay()) && !rule.holidays.includes(d.toISOString().slice(0, 10));
  let steps = 0;
  while (remaining > 0) {
    if (++steps > 20000) throw Error('calendar_exhausted');
    d.setUTCDate(d.getUTCDate() + direction);
    if (!rule.businessDays || business()) remaining--;
  }
  const local = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: rule.hour, minute: rule.minute };
  const result = zonedTimeToUtc(local, rule.timeZone);
  const actual = formatInTimeZone(result.utcMs, rule.timeZone);
  return { ruleId: rule.id, ruleVersion: rule.version, dueAt: new Date(result.utcMs).toISOString(), local: actual,
    resolution: result.exists ? 'exact' : 'earliest_overlap_or_next_valid_minute' };
}
