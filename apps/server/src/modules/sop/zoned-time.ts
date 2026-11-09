export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

interface ResolvedInstant {
  utcMs: number;
  exists: boolean;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export function formatInTimeZone(utcMs: number, timeZone: string): LocalDateTime {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function sameLocal(got: LocalDateTime, want: LocalDateTime): boolean {
  return got.year === want.year && got.month === want.month && got.day === want.day && got.hour === want.hour && got.minute === want.minute;
}

function asUtcMs(local: LocalDateTime): number {
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
}

const SEARCH_MS = 16 * 3_600_000;

/** Earliest UTC instant whose wall clock in `timeZone` matches `local`. A DST gap returns the next valid minute. */
export function zonedTimeToUtc(local: LocalDateTime, timeZone: string): ResolvedInstant {
  const hits = instantsMatching(local, timeZone);
  if (hits.length > 0) return { utcMs: hits[0]!, exists: hits.length === 1 };

  const origin = asUtcMs(local);
  for (let probe = origin - SEARCH_MS; probe <= origin + SEARCH_MS; probe += 60_000) {
    const got = formatInTimeZone(probe, timeZone);
    if (compareLocal(got, local) >= 0) return { utcMs: probe - (got.second ?? 0) * 1000, exists: false };
  }
  return { utcMs: origin, exists: false };
}

function instantsMatching(local: LocalDateTime, timeZone: string): number[] {
  const hits: number[] = [];
  const origin = asUtcMs(local);
  for (let probe = origin - SEARCH_MS; probe <= origin + SEARCH_MS; probe += 60_000) {
    const got = formatInTimeZone(probe, timeZone);
    if (sameLocal(got, local)) hits.push(probe - (got.second ?? 0) * 1000);
  }
  return [...new Set(hits)].sort((a, b) => a - b);
}

function compareLocal(got: LocalDateTime, want: LocalDateTime): number {
  const keys: Array<keyof LocalDateTime> = ['year', 'month', 'day', 'hour', 'minute'];
  for (const key of keys) {
    const diff = (got[key] ?? 0) - (want[key] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function localStamp(local: Pick<LocalDateTime, 'year' | 'month' | 'day' | 'hour' | 'minute'>): string {
  return `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}`;
}
