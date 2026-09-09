import { DateTime } from 'luxon';
import { query } from '../db/index.js';
import { ToolError } from '../lib/errors.js';
import { eachDay, isISODate, localDateOf, todayIn } from '../lib/dates.js';
import { matchProject } from '../lib/match.js';
import { minutesToHours } from '../lib/money.js';
import type { Ctx } from './context.js';
import { listProjects, toMatchable } from './workspace.js';

export interface ActivityItem {
  source: 'calendar' | 'git' | 'issue_tracker' | 'note' | 'other';
  title: string;
  start?: string;
  end?: string;
  duration_min?: number;
  url?: string;
  participants?: string[];
  description?: string;
}

export interface ProposeInput {
  date_range?: { start?: string; end?: string };
  activity: ActivityItem[];
  already_logged_handling?: 'skip' | 'flag';
  /** Hours per weekday considered "a full day" when computing gaps. Default 8. */
  target_hours_per_day?: number;
  /** Default minutes for commits / tickets with no duration. Default 30. */
  default_duration_min?: number;
}

const DEFAULT_DURATIONS: Record<ActivityItem['source'], number> = { calendar: 60, git: 30, issue_tracker: 45, note: 30, other: 30 };

export async function proposeEntries(ctx: Ctx, input: ProposeInput) {
  const ws = ctx.workspace;
  const tz = ws.timezone;
  const projects = await listProjects(ctx, false);
  const matchable = projects.map(toMatchable);
  const today = todayIn(tz);

  // Normalise activity into (date, start, end, minutes)
  type Norm = { item: ActivityItem; date: string; start: DateTime | null; end: DateTime | null; minutes: number; assumedDuration: boolean };
  const normalised: Norm[] = [];
  const skipped: { title: string; reason: string }[] = [];
  for (const raw of input.activity ?? []) {
    if (!raw?.title) {
      skipped.push({ title: '(untitled)', reason: 'no title' });
      continue;
    }
    let start = raw.start ? DateTime.fromISO(raw.start, { zone: tz, setZone: true }) : null;
    let end = raw.end ? DateTime.fromISO(raw.end, { zone: tz, setZone: true }) : null;
    if (start && !start.isValid) start = null;
    if (end && !end.isValid) end = null;
    let minutes = raw.duration_min && raw.duration_min > 0 ? Math.round(raw.duration_min) : 0;
    let assumed = false;
    if (start && end) {
      const d = Math.round(end.diff(start, 'minutes').minutes);
      if (d > 0 && d <= 24 * 60) minutes = d;
      // All-day calendar events (00:00 → 00:00 next day) are not work.
      if (d >= 24 * 60 && raw.source === 'calendar') {
        skipped.push({ title: raw.title, reason: 'all-day event' });
        continue;
      }
    }
    if (!minutes) {
      minutes = input.default_duration_min ?? DEFAULT_DURATIONS[raw.source] ?? 30;
      assumed = true;
      if (start && !end) end = start.plus({ minutes });
    }
    const date = start ? localDateOf(start, tz) : end ? localDateOf(end, tz) : null;
    if (!date) {
      skipped.push({ title: raw.title, reason: 'no start/end time; cannot place on a day' });
      continue;
    }
    normalised.push({ item: raw, date, start, end, minutes, assumedDuration: assumed });
  }

  // Range: explicit, else span of the activity.
  let rangeStart = input.date_range?.start;
  let rangeEnd = input.date_range?.end;
  if (rangeStart && !isISODate(rangeStart)) throw new ToolError('Invalid date_range.start', 'invalid');
  if (rangeEnd && !isISODate(rangeEnd)) throw new ToolError('Invalid date_range.end', 'invalid');
  const dates = normalised.map((n) => n.date).sort();
  rangeStart = rangeStart ?? dates[0] ?? today;
  rangeEnd = rangeEnd ?? dates[dates.length - 1] ?? today;
  const inRange = normalised.filter((n) => n.date >= rangeStart! && n.date <= rangeEnd!);

  // Existing entries in the range (for duplicate detection + gap calc)
  const existing = await query<{ id: string; date: string; description: string; duration_min: number; project_id: string | null; started_at: Date | null; ended_at: Date | null; source_ref: { url?: string } | null }>(
    `SELECT id, date, description, duration_min, project_id, started_at, ended_at, source_ref FROM time_entries WHERE workspace_id = $1 AND user_id = $2 AND date BETWEEN $3 AND $4`,
    [ctx.workspaceId, ctx.userId, rangeStart, rangeEnd],
  );
  const handling = input.already_logged_handling ?? 'flag';

  // Merge git commits on the same day into one block per matched project (commits are markers, not durations).
  const proposed: {
    entry: { description: string; date: string; duration: string; start?: string; end?: string; project: string | null; billable: boolean; tags: string[]; source: 'proposal'; source_ref: unknown };
    matched_project: { id: string; name: string; client: string | null } | null;
    confidence: number;
    reason: string;
    already_logged?: { entry_id: string; description: string; duration_min: number };
    assumed_duration?: boolean;
  }[] = [];
  const unmatched: { activity: ActivityItem; date: string; duration_min: number; candidates: unknown[] }[] = [];

  const gitBuckets = new Map<string, Norm[]>();
  for (const n of inRange) {
    if (n.item.source === 'git') {
      const decision = matchProject(`${n.item.title} ${n.item.description ?? ''} ${n.item.url ?? ''}`, matchable, { threshold: 0.6, gap: 0.1 });
      const key = `${n.date}|${decision.kind === 'match' ? decision.project.id : 'none'}`;
      gitBuckets.set(key, [...(gitBuckets.get(key) ?? []), n]);
      continue;
    }
    handleOne(n);
  }
  for (const [key, group] of gitBuckets) {
    const [date, pid] = key.split('|');
    const titles = group.map((g) => g.item.title);
    const minutes = group.reduce((s, g) => s + g.minutes, 0);
    const first = group[0];
    const merged: Norm = {
      item: { source: 'git', title: `Commits: ${titles.slice(0, 3).join('; ')}${titles.length > 3 ? ` (+${titles.length - 3} more)` : ''}`, url: first.item.url, participants: [] },
      date,
      start: null,
      end: null,
      minutes: Math.min(minutes, 8 * 60),
      assumedDuration: group.some((g) => g.assumedDuration),
    };
    handleOne(merged, pid === 'none' ? null : pid, group.map((g) => g.item.url).filter(Boolean) as string[]);
  }

  function handleOne(n: Norm, forcedProjectId: string | null = null, urls: string[] = []) {
    const text = [n.item.title, n.item.description ?? ''].join(' ');
    const decision = forcedProjectId
      ? { kind: 'match' as const, project: matchable.find((m) => m.id === forcedProjectId)!, confidence: 0.7, reason: 'commit text', candidates: [] }
      : matchProject(text, matchable, { participantEmails: n.item.participants, threshold: 0.6, gap: 0.1 });
    // Already-logged detection: same day and overlapping time, or same URL, or same title.
    const dup = existing.find((e) => {
      if (e.date !== n.date) return false;
      if (n.item.url && e.source_ref?.url && e.source_ref.url === n.item.url) return true;
      if (urls.length && e.source_ref?.url && urls.includes(e.source_ref.url)) return true;
      if (e.description.trim().toLowerCase() === n.item.title.trim().toLowerCase()) return true;
      if (n.start && n.end && e.started_at && e.ended_at) {
        const es = DateTime.fromJSDate(e.started_at);
        const ee = DateTime.fromJSDate(e.ended_at);
        return n.start < ee && n.end > es;
      }
      return false;
    });
    if (dup && handling === 'skip') {
      skipped.push({ title: n.item.title, reason: `already logged (entry ${dup.id})` });
      return;
    }
    if (decision.kind !== 'match') {
      unmatched.push({ activity: n.item, date: n.date, duration_min: n.minutes, candidates: decision.candidates });
      return;
    }
    const proj = projects.find((p) => p.id === decision.project.id)!;
    proposed.push({
      entry: {
        description: n.item.title,
        date: n.date,
        duration: `${n.minutes}m`,
        ...(n.start ? { start: n.start.toISO()! } : {}),
        ...(n.end ? { end: n.end.toISO()! } : {}),
        project: proj.id,
        billable: proj.billable_default,
        tags: [n.item.source],
        source: 'proposal',
        source_ref: { source: n.item.source, url: n.item.url ?? urls[0] ?? null, urls: urls.length ? urls : undefined },
      },
      matched_project: { id: proj.id, name: proj.name, client: proj.client_name },
      confidence: decision.confidence,
      reason: decision.reason,
      ...(dup ? { already_logged: { entry_id: dup.id, description: dup.description, duration_min: dup.duration_min } } : {}),
      ...(n.assumedDuration ? { assumed_duration: true } : {}),
    });
  }

  // Overlaps among proposals with times
  const timed = proposed.filter((p) => p.entry.start && p.entry.end);
  const overlaps: { a: string; b: string; date: string }[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (a.entry.date !== b.entry.date) continue;
      if (a.entry.start! < b.entry.end! && b.entry.start! < a.entry.end!) overlaps.push({ a: a.entry.description, b: b.entry.description, date: a.entry.date });
    }
  }

  // Gaps: weekdays under target after adding proposals to what's already logged.
  const target = (input.target_hours_per_day ?? 8) * 60;
  const gaps: { date: string; hours_logged: number; hours_proposed: number; hours_uncovered: number }[] = [];
  for (const d of eachDay(rangeStart, rangeEnd)) {
    if (d > today) continue;
    const dow = DateTime.fromISO(d).weekday;
    if (dow >= 6) continue;
    const logged = existing.filter((e) => e.date === d).reduce((s, e) => s + e.duration_min, 0);
    const prop = proposed.filter((p) => p.entry.date === d && !p.already_logged).reduce((s, p) => s + parseInt(p.entry.duration), 0);
    const uncovered = target - logged - prop;
    if (uncovered >= 60) gaps.push({ date: d, hours_logged: minutesToHours(logged), hours_proposed: minutesToHours(prop), hours_uncovered: minutesToHours(uncovered) });
  }

  proposed.sort((a, b) => a.entry.date.localeCompare(b.entry.date) || (a.entry.start ?? '').localeCompare(b.entry.start ?? ''));
  return {
    date_range: { start: rangeStart, end: rangeEnd },
    timezone: tz,
    proposed,
    unmatched,
    gaps,
    overlaps,
    skipped,
    summary: {
      proposed_count: proposed.length,
      proposed_hours: minutesToHours(proposed.reduce((s, p) => s + parseInt(p.entry.duration), 0)),
      unmatched_count: unmatched.length,
      already_logged_count: proposed.filter((p) => p.already_logged).length,
    },
    next_step: 'Present the proposal grouped by day. After the user confirms (and resolves unmatched items), call time.log_entries_batch with the confirmed `entry` objects.',
  };
}
