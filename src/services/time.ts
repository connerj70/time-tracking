import { one, query } from '../db/index.js';
import { ToolError } from '../lib/errors.js';
import { parseDuration } from '../lib/duration.js';
import { addDays, isISODate, resolveRange, resolveTiming, todayIn } from '../lib/dates.js';
import { resolveRateCents } from '../lib/rates.js';
import { minutesToHours } from '../lib/money.js';
import { sha256 } from '../lib/ids.js';
import { type Ctx } from './context.js';
import { listProjects, resolveProject, type ProjectWithClient } from './workspace.js';

export interface EntryRow {
  id: string;
  workspace_id: string;
  user_id: string;
  project_id: string | null;
  description: string;
  date: string;
  started_at: Date | null;
  ended_at: Date | null;
  duration_min: number;
  billable: boolean;
  rate_cents: number | null;
  tags: string[];
  invoice_id: string | null;
  source: string;
  source_ref: unknown;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EntryView extends EntryRow {
  project_name: string | null;
  client_name: string | null;
  client_id: string | null;
  project_rate_cents: number | null;
  client_rate_cents: number | null;
  invoice_number: string | null;
  invoice_status: string | null;
}

export interface LogEntryInput {
  description?: string;
  duration?: string | number;
  start?: string;
  end?: string;
  date?: string;
  project?: string;
  billable?: boolean;
  tags?: string[];
  rate?: number;
  idempotency_key?: string;
  source?: 'chat' | 'proposal' | 'import' | 'timer';
  source_ref?: unknown;
}

export type LogEntryResult =
  | { status: 'logged'; entry: ReturnType<typeof publicEntry>; matched_project: { id: string; name: string; client: string | null } | null; confidence: number | null; duration_parsed: string }
  | { status: 'duplicate'; possible_duplicate: true; entry: ReturnType<typeof publicEntry>; message: string }
  | { status: 'ambiguous'; ambiguous: true; candidates: unknown[]; message: string }
  | { status: 'no_project'; candidates: unknown[]; message: string }
  | { status: 'error'; error: string };

const ENTRY_SELECT = `
  SELECT t.*, p.name AS project_name, p.rate_cents AS project_rate_cents, c.name AS client_name, c.id AS client_id,
         c.default_rate_cents AS client_rate_cents, i.number AS invoice_number, i.status AS invoice_status
  FROM time_entries t
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN clients c ON c.id = p.client_id
  LEFT JOIN invoices i ON i.id = t.invoice_id`;

export function publicEntry(e: EntryView, ws: Ctx['workspace']) {
  const rate = resolveRateCents({
    entryRateCents: e.rate_cents,
    projectRateCents: e.project_rate_cents,
    clientRateCents: e.client_rate_cents,
    workspaceDefaultCents: ws.default_rate_cents,
  });
  const hours = minutesToHours(e.duration_min);
  return {
    id: e.id,
    date: e.date,
    description: e.description,
    project: e.project_name,
    project_id: e.project_id,
    client: e.client_name,
    duration_min: e.duration_min,
    hours,
    start: e.started_at ? e.started_at.toISOString() : null,
    end: e.ended_at ? e.ended_at.toISOString() : null,
    billable: e.billable,
    rate: rate.rateCents / 100,
    rate_source: rate.source,
    amount: e.billable ? Math.round(hours * rate.rateCents) / 100 : 0,
    tags: e.tags,
    invoice: e.invoice_id ? { id: e.invoice_id, number: e.invoice_number, status: e.invoice_status } : null,
    locked: Boolean(e.invoice_id && e.invoice_status && e.invoice_status !== 'draft'),
    source: e.source,
  };
}

export async function getEntry(ctx: Ctx, id: string): Promise<EntryView | null> {
  return one<EntryView>(`${ENTRY_SELECT} WHERE t.id = $1 AND t.workspace_id = $2`, [id, ctx.workspaceId]);
}

function idempotencyKeyFor(ctx: Ctx, input: { date: string; projectId: string | null; description: string; durationMin: number }, salt = ''): string {
  return 'auto:' + sha256([ctx.userId, input.date, input.projectId ?? '', input.description.trim().toLowerCase(), input.durationMin, salt].join('|')).slice(0, 32);
}

export async function logEntry(ctx: Ctx, input: LogEntryInput, opts: { projects?: ProjectWithClient[]; rowIndex?: number } = {}): Promise<LogEntryResult> {
  const ws = ctx.workspace;
  const description = (input.description ?? '').trim();

  // Idempotent replay: return the existing row untouched.
  if (input.idempotency_key) {
    const existing = await one<EntryView>(`${ENTRY_SELECT} WHERE t.workspace_id = $1 AND t.idempotency_key = $2`, [ctx.workspaceId, input.idempotency_key]);
    if (existing) {
      return { status: 'logged', entry: publicEntry(existing, ws), matched_project: existing.project_id ? { id: existing.project_id, name: existing.project_name!, client: existing.client_name } : null, confidence: null, duration_parsed: 'idempotent replay' };
    }
  }

  // Duration / timing
  const parsed = input.duration != null && input.duration !== '' ? parseDuration(input.duration) : null;
  if (input.duration != null && input.duration !== '' && !parsed) {
    return { status: 'error', error: `Could not understand duration "${input.duration}". Try "2h30m", "2.5", "150", or "1:45".` };
  }
  const timing = resolveTiming({ tz: ws.timezone, date: input.date, start: input.start, end: input.end, durationMin: parsed?.minutes ?? null });
  if ('error' in timing) return { status: 'error', error: timing.error };
  const today = todayIn(ws.timezone);
  if (timing.date > addDays(today, 1)) return { status: 'error', error: `Date ${timing.date} is in the future (workspace today is ${today}). Time entries are for work already done.` };

  // Project resolution — never guesses.
  const projects = opts.projects ?? (await listProjects(ctx, true));
  let project: ProjectWithClient | null = null;
  let confidence: number | null = null;
  if (input.project) {
    const { decision, project: p } = await resolveProject(ctx, input.project, {}, projects);
    if (decision.kind === 'match') {
      project = p;
      confidence = decision.confidence;
    } else if (decision.kind === 'ambiguous') {
      return { status: 'ambiguous', ambiguous: true, candidates: decision.candidates, message: `"${input.project}" could be several projects. Ask the user which one, then retry with the project id or exact name.` };
    } else {
      return { status: 'no_project', candidates: decision.candidates, message: `No project matches "${input.project}". Ask the user whether to create it (workspace.create_project) or pick an existing one (workspace.list_projects).` };
    }
  } else if (projects.filter((p) => !p.archived).length === 1) {
    project = projects.find((p) => !p.archived)!;
    confidence = 1;
  } else if (projects.length > 0) {
    // Try matching the description against project names/aliases before asking.
    const { decision, project: p } = await resolveProject(ctx, description, { threshold: 0.85, gap: 0.2 }, projects);
    if (decision.kind === 'match') {
      project = p;
      confidence = decision.confidence;
    } else {
      return { status: 'ambiguous', ambiguous: true, candidates: decision.candidates, message: 'No project was specified. Ask the user which project this belongs to.' };
    }
  }

  const billable = input.billable ?? project?.billable_default ?? true;
  const durationMin = timing.durationMin;

  // Duplicate guard: same date + project + description within ±10% duration.
  const dup = await one<EntryView>(
    `${ENTRY_SELECT} WHERE t.workspace_id = $1 AND t.user_id = $2 AND t.date = $3
       AND t.project_id IS NOT DISTINCT FROM $4 AND lower(trim(t.description)) = lower($5)
       AND t.duration_min BETWEEN $6 AND $7 ORDER BY t.created_at DESC LIMIT 1`,
    [ctx.workspaceId, ctx.userId, timing.date, project?.id ?? null, description, Math.floor(durationMin * 0.9), Math.ceil(durationMin * 1.1)],
  );
  if (dup) {
    return { status: 'duplicate', possible_duplicate: true, entry: publicEntry(dup, ws), message: `An entry like this already exists for ${timing.date} (${dup.duration_min} min). Not creating another. If the user really did this twice, retry with a distinct description or idempotency_key.` };
  }

  const key = input.idempotency_key ?? idempotencyKeyFor(ctx, { date: timing.date, projectId: project?.id ?? null, description, durationMin }, opts.rowIndex != null ? String(opts.rowIndex) : '');
  const rateCents = input.rate != null ? Math.round(input.rate * 100) : null;
  const row = await one<{ id: string }>(
    `INSERT INTO time_entries (workspace_id, user_id, project_id, description, date, started_at, ended_at, duration_min, billable, rate_cents, tags, source, source_ref, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (workspace_id, idempotency_key) DO UPDATE SET updated_at = time_entries.updated_at
     RETURNING id`,
    [ctx.workspaceId, ctx.userId, project?.id ?? null, description, timing.date, timing.startedAt, timing.endedAt, durationMin, billable, rateCents, input.tags ?? [], input.source ?? 'chat', input.source_ref ? JSON.stringify(input.source_ref) : null, key],
  );
  const entry = (await getEntry(ctx, row!.id))!;
  return {
    status: 'logged',
    entry: publicEntry(entry, ws),
    matched_project: project ? { id: project.id, name: project.name, client: project.client_name } : null,
    confidence,
    duration_parsed: parsed?.interpretation ?? `${durationMin} min from start/end`,
  };
}

export async function logBatch(ctx: Ctx, entries: LogEntryInput[]): Promise<{ results: (LogEntryResult & { index: number })[]; summary: { logged: number; duplicates: number; needs_input: number; errors: number; total_hours: number } }> {
  const projects = await listProjects(ctx, true);
  const results: (LogEntryResult & { index: number })[] = [];
  let totalMin = 0;
  for (let i = 0; i < entries.length; i++) {
    const r = await logEntry(ctx, entries[i], { projects, rowIndex: i });
    results.push({ ...r, index: i });
    if (r.status === 'logged') totalMin += r.entry.duration_min;
  }
  return {
    results,
    summary: {
      logged: results.filter((r) => r.status === 'logged').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      needs_input: results.filter((r) => r.status === 'ambiguous' || r.status === 'no_project').length,
      errors: results.filter((r) => r.status === 'error').length,
      total_hours: minutesToHours(totalMin),
    },
  };
}

export interface ListFilters {
  start_date?: string;
  end_date?: string;
  project?: string;
  client?: string;
  billable_only?: boolean;
  unbilled_only?: boolean;
  limit?: number;
  cursor?: string;
}

export async function listEntries(ctx: Ctx, f: ListFilters) {
  const ws = ctx.workspace;
  const range = resolveRange(ws.timezone, f.start_date, f.end_date);
  if ('error' in range) throw new ToolError(range.error, 'invalid');
  const where: string[] = ['t.workspace_id = $1', 't.date BETWEEN $2 AND $3'];
  const params: unknown[] = [ctx.workspaceId, range.start, range.end];
  const scope = await scopeFilters(ctx, f, where, params);
  if (f.billable_only) where.push('t.billable = true');
  if (f.unbilled_only) where.push("t.billable = true AND (t.invoice_id IS NULL OR i.status = 'void')");
  const limit = Math.min(Math.max(f.limit ?? 100, 1), 200);
  if (f.cursor) {
    const [d, id] = decodeCursor(f.cursor);
    where.push(`(t.date, t.id) < ($${params.length + 1}, $${params.length + 2})`);
    params.push(d, id);
  }
  const rows = await query<EntryView>(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.date DESC, t.id DESC LIMIT ${limit + 1}`, params);
  const page = rows.slice(0, limit);
  const next = rows.length > limit ? encodeCursor(page[page.length - 1]) : null;
  const totalMin = page.reduce((s, r) => s + r.duration_min, 0);
  return {
    range,
    filters: scope,
    entries: page.map((e) => publicEntry(e, ws)),
    page: { count: page.length, next_cursor: next, total_hours_on_page: minutesToHours(totalMin) },
  };
}

function encodeCursor(e: EntryView): string {
  return Buffer.from(`${e.date}|${e.id}`).toString('base64url');
}
function decodeCursor(c: string): [string, string] {
  const [d, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!isISODate(d) || !id) throw new ToolError('Invalid cursor', 'invalid');
  return [d, id];
}

async function scopeFilters(ctx: Ctx, f: { project?: string; client?: string }, where: string[], params: unknown[]) {
  const out: { project?: string; client?: string } = {};
  if (f.project) {
    const { decision, project } = await resolveProject(ctx, f.project);
    if (!project) {
      throw new ToolError(`Could not resolve project "${f.project}"`, decision.kind === 'ambiguous' ? 'ambiguous' : 'not_found', { candidates: decision.candidates });
    }
    where.push(`t.project_id = $${params.length + 1}`);
    params.push(project.id);
    out.project = project.name;
  }
  if (f.client) {
    const { resolveClient } = await import('./workspace.js');
    const client = await resolveClient(ctx, f.client);
    where.push(`c.id = $${params.length + 1}`);
    params.push(client.id);
    out.client = client.name;
  }
  return out;
}

export interface ReportFilters {
  start_date?: string;
  end_date?: string;
  group_by?: 'day' | 'project' | 'client' | 'none';
  client?: string;
  project?: string;
}

export async function report(ctx: Ctx, f: ReportFilters) {
  const ws = ctx.workspace;
  const range = resolveRange(ws.timezone, f.start_date, f.end_date);
  if ('error' in range) throw new ToolError(range.error, 'invalid');
  const where: string[] = ['t.workspace_id = $1', 't.date BETWEEN $2 AND $3'];
  const params: unknown[] = [ctx.workspaceId, range.start, range.end];
  const scope = await scopeFilters(ctx, f, where, params);
  const rows = await query<EntryView>(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.date, t.id`, params);
  const groupBy = f.group_by ?? 'none';

  const totals = { total_min: 0, billable_min: 0, nonbillable_min: 0, unbilled_cents: 0, billable_cents: 0 };
  type Agg = { key: string; label: string; client?: string | null; project?: string | null; total_min: number; billable_min: number; unbilled_cents: number; billable_cents: number; entries: number; by_project?: Map<string, { project: string; client: string | null; total_min: number }> };
  const groups = new Map<string, Agg>();
  for (const e of rows) {
    const pe = publicEntry(e, ws);
    const cents = Math.round(pe.amount * 100);
    const unbilled = e.billable && (!e.invoice_id || e.invoice_status === 'void') ? cents : 0;
    totals.total_min += e.duration_min;
    if (e.billable) {
      totals.billable_min += e.duration_min;
      totals.billable_cents += cents;
    } else totals.nonbillable_min += e.duration_min;
    totals.unbilled_cents += unbilled;
    if (groupBy === 'none') continue;
    const key = groupBy === 'day' ? e.date : groupBy === 'project' ? e.project_id ?? 'none' : e.client_id ?? 'none';
    const label = groupBy === 'day' ? e.date : groupBy === 'project' ? e.project_name ?? '(no project)' : e.client_name ?? '(no client)';
    let g = groups.get(key);
    if (!g) {
      g = { key, label, client: e.client_name, project: e.project_name, total_min: 0, billable_min: 0, unbilled_cents: 0, billable_cents: 0, entries: 0, by_project: new Map() };
      groups.set(key, g);
    }
    g.total_min += e.duration_min;
    if (e.billable) {
      g.billable_min += e.duration_min;
      g.billable_cents += cents;
    }
    g.unbilled_cents += unbilled;
    g.entries += 1;
    const pk = e.project_id ?? 'none';
    const bp = g.by_project!.get(pk) ?? { project: e.project_name ?? '(no project)', client: e.client_name, total_min: 0 };
    bp.total_min += e.duration_min;
    g.by_project!.set(pk, bp);
  }
  const groupList = [...groups.values()]
    .sort((a, b) => (groupBy === 'day' ? a.key.localeCompare(b.key) : b.total_min - a.total_min))
    .slice(0, 100)
    .map((g) => ({
      key: g.key,
      label: g.label,
      ...(groupBy === 'project' ? { client: g.client } : {}),
      hours: minutesToHours(g.total_min),
      billable_hours: minutesToHours(g.billable_min),
      billable_amount: g.billable_cents / 100,
      unbilled_amount: g.unbilled_cents / 100,
      entries: g.entries,
      ...(groupBy === 'day' ? { projects: [...g.by_project!.values()].map((p) => ({ project: p.project, client: p.client, hours: minutesToHours(p.total_min) })) } : {}),
    }));

  return {
    range,
    filters: scope,
    timezone: ws.timezone,
    currency: ws.currency,
    total_hours: minutesToHours(totals.total_min),
    billable_hours: minutesToHours(totals.billable_min),
    non_billable_hours: minutesToHours(totals.nonbillable_min),
    billable_amount: totals.billable_cents / 100,
    unbilled_amount: totals.unbilled_cents / 100,
    unbilled_amount_cents: totals.unbilled_cents,
    entry_count: rows.length,
    group_by: groupBy,
    groups: groupList,
  };
}

export interface UpdateInput {
  entry_id: string;
  description?: string;
  duration?: string | number;
  start?: string;
  end?: string;
  date?: string;
  project?: string;
  billable?: boolean;
  tags?: string[];
  rate?: number | null;
}

export async function updateEntry(ctx: Ctx, input: UpdateInput) {
  const ws = ctx.workspace;
  const existing = await getEntry(ctx, input.entry_id);
  if (!existing) throw new ToolError(`No time entry with id ${input.entry_id}`, 'not_found');
  if (existing.invoice_id && existing.invoice_status && existing.invoice_status !== 'draft') {
    throw new ToolError(
      `This entry is on invoice ${existing.invoice_number} (${existing.invoice_status}) and is locked. Void the invoice first (invoice.void) or record the correction on a new entry.`,
      'locked',
      { invoice_id: existing.invoice_id, invoice_number: existing.invoice_number },
    );
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  let matched: { id: string; name: string; client: string | null } | null = null;
  if (input.description !== undefined) set('description', input.description.trim());
  if (input.billable !== undefined) set('billable', input.billable);
  if (input.tags !== undefined) set('tags', input.tags);
  if (input.rate !== undefined) set('rate_cents', input.rate == null ? null : Math.round(input.rate * 100));
  if (input.project !== undefined) {
    const { decision, project } = await resolveProject(ctx, input.project);
    if (!project) {
      return { ambiguous: true, candidates: decision.candidates, message: `Could not resolve project "${input.project}".` };
    }
    set('project_id', project.id);
    matched = { id: project.id, name: project.name, client: project.client_name };
  }
  if (input.duration !== undefined || input.start !== undefined || input.end !== undefined || input.date !== undefined) {
    const parsed = input.duration != null ? parseDuration(input.duration) : null;
    if (input.duration != null && !parsed) throw new ToolError(`Could not understand duration "${input.duration}"`, 'invalid');
    const keepDuration = input.duration == null && input.start == null && input.end == null;
    const timing = resolveTiming({
      tz: ws.timezone,
      date: input.date ?? existing.date,
      start: input.start ?? (input.end && existing.started_at ? existing.started_at.toISOString() : undefined),
      end: input.end,
      durationMin: parsed?.minutes ?? (keepDuration ? existing.duration_min : null),
    });
    if ('error' in timing) throw new ToolError(timing.error, 'invalid');
    set('date', timing.date);
    set('duration_min', timing.durationMin);
    if (input.start !== undefined || input.end !== undefined) {
      set('started_at', timing.startedAt);
      set('ended_at', timing.endedAt);
    } else if (input.date !== undefined && existing.started_at) {
      // Date moved without new times: drop instants rather than lie about them.
      set('started_at', null);
      set('ended_at', null);
    }
  }
  if (!sets.length) throw new ToolError('Nothing to update', 'invalid');
  set('updated_at', new Date());
  // An edited entry is no longer the same logged fact; drop the auto-generated replay key so a fresh log of the original doesn't collide.
  sets.push("idempotency_key = CASE WHEN idempotency_key LIKE 'auto:%' THEN NULL ELSE idempotency_key END");
  params.push(input.entry_id, ctx.workspaceId);
  await query(`UPDATE time_entries SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`, params);
  const updated = (await getEntry(ctx, input.entry_id))!;
  return { entry: publicEntry(updated, ws), matched_project: matched, previous: publicEntry(existing, ws) };
}

export async function deleteEntry(ctx: Ctx, id: string, confirm: boolean) {
  const existing = await getEntry(ctx, id);
  if (!existing) throw new ToolError(`No time entry with id ${id}`, 'not_found');
  if (existing.invoice_id && existing.invoice_status && existing.invoice_status !== 'draft') {
    throw new ToolError(`This entry is on invoice ${existing.invoice_number} (${existing.invoice_status}) and cannot be deleted.`, 'locked', { invoice_id: existing.invoice_id });
  }
  if (!confirm) {
    return { deleted: false, needs_confirmation: true, entry: publicEntry(existing, ctx.workspace), message: 'Show this entry to the user and call again with confirm: true to delete it.' };
  }
  await query(`DELETE FROM time_entries WHERE id = $1 AND workspace_id = $2`, [id, ctx.workspaceId]);
  return { deleted: true, entry: publicEntry(existing, ctx.workspace) };
}
