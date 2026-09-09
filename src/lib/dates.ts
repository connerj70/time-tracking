import { DateTime, Interval } from 'luxon';

/**
 * Every date default is resolved server-side in the workspace timezone.
 * Never trust the model's idea of "today".
 */
export function isValidZone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

export function todayIn(tz: string): string {
  return DateTime.now().setZone(tz).toISODate()!;
}

export function nowIn(tz: string): DateTime {
  return DateTime.now().setZone(tz);
}

export function isISODate(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && DateTime.fromISO(s).isValid;
}

/** Parse an ISO datetime supplied by the model. If it has no offset, assume the workspace zone. */
export function parseDateTime(s: string, tz: string): DateTime | null {
  const dt = DateTime.fromISO(s, { zone: tz, setZone: true });
  return dt.isValid ? dt : null;
}

/** Workspace-local date for a UTC instant. */
export function localDateOf(instant: DateTime | Date, tz: string): string {
  const dt = instant instanceof Date ? DateTime.fromJSDate(instant) : instant;
  return dt.setZone(tz).toISODate()!;
}

/** Monday..Sunday containing `date` (ISO week). */
export function weekBounds(date: string): { start: string; end: string } {
  const d = DateTime.fromISO(date);
  return { start: d.startOf('week').toISODate()!, end: d.endOf('week').toISODate()! };
}

export function monthBounds(date: string): { start: string; end: string } {
  const d = DateTime.fromISO(date);
  return { start: d.startOf('month').toISODate()!, end: d.endOf('month').toISODate()! };
}

export function addDays(date: string, n: number): string {
  return DateTime.fromISO(date).plus({ days: n }).toISODate()!;
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(start);
  const e = DateTime.fromISO(end);
  while (d <= e) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
    if (out.length > 400) break;
  }
  return out;
}

export function daysBetween(start: string, end: string): number {
  return Math.round(Interval.fromDateTimes(DateTime.fromISO(start), DateTime.fromISO(end)).length('days'));
}

/**
 * Resolve a start/end/date/duration combination into a canonical entry timing.
 * - If start+end: duration derived, date = local date of start.
 * - If start+duration: end derived.
 * - If date only: no instants, date as given (or workspace today).
 */
export function resolveTiming(opts: {
  tz: string;
  date?: string | null;
  start?: string | null;
  end?: string | null;
  durationMin?: number | null;
}): { date: string; startedAt: Date | null; endedAt: Date | null; durationMin: number } | { error: string } {
  const { tz } = opts;
  let start = opts.start ? parseDateTime(opts.start, tz) : null;
  let end = opts.end ? parseDateTime(opts.end, tz) : null;
  if (opts.start && !start) return { error: `Could not parse start time "${opts.start}"` };
  if (opts.end && !end) return { error: `Could not parse end time "${opts.end}"` };

  // Time-only starts like "09:00" come through as today in the zone; if a date was given, pin to it.
  if (start && opts.date && isISODate(opts.date) && /^\d{1,2}:\d{2}/.test(opts.start!)) {
    const d = DateTime.fromISO(opts.date, { zone: tz });
    start = start.set({ year: d.year, month: d.month, day: d.day });
  }
  if (end && opts.date && isISODate(opts.date) && /^\d{1,2}:\d{2}/.test(opts.end!)) {
    const d = DateTime.fromISO(opts.date, { zone: tz });
    end = end.set({ year: d.year, month: d.month, day: d.day });
  }

  let durationMin = opts.durationMin ?? null;
  if (start && end) {
    if (end <= start) {
      // Assume the model omitted a day rollover (e.g. 22:00 → 01:00)
      end = end.plus({ days: 1 });
    }
    const derived = Math.round(end.diff(start, 'minutes').minutes);
    if (durationMin && Math.abs(derived - durationMin) > 1) {
      return { error: `start/end imply ${derived} minutes but duration says ${durationMin}; provide one or the other` };
    }
    durationMin = derived;
  } else if (start && durationMin) {
    end = start.plus({ minutes: durationMin });
  } else if (end && durationMin) {
    start = end.minus({ minutes: durationMin });
  }
  if (!durationMin || durationMin <= 0) return { error: 'A duration or a start and end time is required' };

  let date: string;
  if (start) date = localDateOf(start, tz);
  else if (opts.date && isISODate(opts.date)) date = opts.date;
  else if (opts.date) return { error: `Invalid date "${opts.date}", expected YYYY-MM-DD` };
  else date = todayIn(tz);

  return {
    date,
    startedAt: start ? start.toUTC().toJSDate() : null,
    endedAt: end ? end.toUTC().toJSDate() : null,
    durationMin,
  };
}

/** Resolve a report range with sensible defaults: this week in the workspace zone. */
export function resolveRange(tz: string, start?: string | null, end?: string | null): { start: string; end: string } | { error: string } {
  const today = todayIn(tz);
  if (start && !isISODate(start)) return { error: `Invalid start_date "${start}"` };
  if (end && !isISODate(end)) return { error: `Invalid end_date "${end}"` };
  if (start && end) return start <= end ? { start, end } : { error: 'start_date is after end_date' };
  if (start) return { start, end: today >= start ? today : start };
  if (end) return { start: addDays(end, -6), end };
  return weekBounds(today);
}
