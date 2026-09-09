import { DateTime } from 'luxon';
import { parseCsv } from './csv.js';
import { parseDuration } from '../lib/duration.js';
import { query, one } from '../db/index.js';
import type { Ctx } from '../services/context.js';
import { createClient, createProject, listClients, listProjects } from '../services/workspace.js';
import { logEntry } from '../services/time.js';
import { config } from '../config.js';
import { ToolError } from '../lib/errors.js';
import { planLimits, upgradeUrl } from '../services/context.js';

export type ImportSource = 'toggl' | 'harvest' | 'clockify';

export interface NormalizedRow {
  client: string | null;
  project: string | null;
  description: string;
  date: string; // YYYY-MM-DD
  start?: string; // ISO local
  end?: string;
  duration_min: number;
  billable: boolean;
  tags: string[];
  row: number;
}

function idx(header: string[], ...names: string[]): number {
  const h = header.map((x) => x.trim().toLowerCase());
  for (const n of names) {
    const i = h.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

export function detectSource(header: string[]): ImportSource | null {
  const h = header.map((x) => x.trim().toLowerCase());
  if (h.includes('duration (h)') || h.includes('duration (decimal)') || (h.includes('start date') && h.includes('billable rate (usd)'))) return 'clockify';
  if (h.includes('hours') && h.includes('notes') && h.includes('date')) return 'harvest';
  if (h.includes('start date') && h.includes('start time') && h.includes('duration')) return 'toggl';
  if (h.includes('start date') && h.includes('start time')) return 'clockify';
  return null;
}

function parseDateLoose(s: string): string | null {
  const t = s.trim();
  for (const fmt of ['yyyy-MM-dd', 'MM/dd/yyyy', 'dd/MM/yyyy', 'M/d/yyyy', 'yyyy/MM/dd', 'dd.MM.yyyy']) {
    const d = DateTime.fromFormat(t, fmt);
    if (d.isValid) return d.toISODate();
  }
  const iso = DateTime.fromISO(t);
  return iso.isValid ? iso.toISODate() : null;
}

function parseTime(s: string): { h: number; m: number; s: number } | null {
  const t = s.trim();
  const m24 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m24) return { h: Number(m24[1]), m: Number(m24[2]), s: Number(m24[3] ?? 0) };
  const m12 = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)$/i);
  if (m12) {
    let h = Number(m12[1]) % 12;
    if (/pm/i.test(m12[4])) h += 12;
    return { h, m: Number(m12[2]), s: Number(m12[3] ?? 0) };
  }
  return null;
}

function truthy(s: string | undefined): boolean {
  return /^(yes|true|1|billable|y)$/i.test((s ?? '').trim());
}

export function normalizeRows(source: ImportSource, rows: string[][]): { rows: NormalizedRow[]; errors: { row: number; error: string }[] } {
  const header = rows[0];
  const out: NormalizedRow[] = [];
  const errors: { row: number; error: string }[] = [];
  const col = (...n: string[]) => idx(header, ...n);
  const c = {
    client: col('client'),
    project: col('project'),
    description: col('description', 'notes', 'task'),
    task: col('task'),
    date: col('date', 'start date', 'spent date'),
    startTime: col('start time'),
    endDate: col('end date'),
    endTime: col('end time'),
    duration: col('duration', 'duration (h)', 'hours', 'duration (decimal)'),
    billable: col('billable', 'billable?'),
    tags: col('tags'),
  };
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const get = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    try {
      const date = parseDateLoose(get(c.date));
      if (!date) throw new Error(`unparseable date "${get(c.date)}"`);
      let duration: number | null = null;
      const dur = get(c.duration);
      if (dur) {
        if (source === 'harvest' || /^\d+(\.\d+)?$/.test(dur)) duration = Math.round(Number(dur) * 60);
        else duration = parseDuration(dur)?.minutes ?? null;
      }
      let start: string | undefined;
      let end: string | undefined;
      const st = parseTime(get(c.startTime));
      const et = parseTime(get(c.endTime));
      if (st) {
        start = DateTime.fromISO(date).set({ hour: st.h, minute: st.m, second: st.s }).toISO({ includeOffset: false })!;
        if (et) {
          const endDate = parseDateLoose(get(c.endDate)) ?? date;
          end = DateTime.fromISO(endDate).set({ hour: et.h, minute: et.m, second: et.s }).toISO({ includeOffset: false })!;
          if (!duration) duration = Math.round(DateTime.fromISO(end).diff(DateTime.fromISO(start), 'minutes').minutes);
        }
      }
      if (!duration || duration <= 0) throw new Error('no duration');
      const description = [get(c.description), c.task >= 0 && c.task !== c.description ? get(c.task) : ''].filter(Boolean).join(' — ');
      out.push({
        client: get(c.client) || null,
        project: get(c.project) || null,
        description,
        date,
        start,
        end,
        duration_min: duration,
        billable: c.billable >= 0 ? truthy(get(c.billable)) : true,
        tags: get(c.tags) ? get(c.tags).split(/[,;]/).map((t) => t.trim()).filter(Boolean) : [],
        row: r + 1,
      });
    } catch (e) {
      errors.push({ row: r + 1, error: (e as Error).message });
    }
  }
  return { rows: out, errors };
}

export async function importCsv(ctx: Ctx, opts: { text: string; filename?: string; source?: ImportSource; dryRun?: boolean }) {
  if (!planLimits(ctx.workspace).imports) {
    throw new ToolError('CSV import is a Pro feature.', 'plan_limit', { upgrade_url: upgradeUrl() });
  }
  const rows = parseCsv(opts.text);
  if (rows.length < 2) throw new ToolError('CSV has no data rows', 'invalid');
  const source = opts.source ?? detectSource(rows[0]);
  if (!source) throw new ToolError(`Could not detect the CSV format from headers: ${rows[0].join(', ')}`, 'invalid');
  const { rows: normalized, errors } = normalizeRows(source, rows);

  // Ensure clients/projects exist (imports are explicit user actions, so creating is fine).
  const clientNames = new Set(normalized.map((r) => r.client).filter(Boolean) as string[]);
  const projectKeys = new Map<string, { project: string; client: string | null }>();
  for (const r of normalized) if (r.project) projectKeys.set(r.project.toLowerCase(), { project: r.project, client: r.client });

  let created = { clients: 0, projects: 0 };
  if (!opts.dryRun) {
    const existingClients = new Set((await listClients(ctx, true)).map((c) => c.name.toLowerCase()));
    for (const name of clientNames) {
      if (!existingClients.has(name.toLowerCase())) {
        await createClient(ctx, { name });
        created.clients++;
      }
    }
    const existingProjects = new Set((await listProjects(ctx, true)).map((p) => p.name.toLowerCase()));
    for (const [key, p] of projectKeys) {
      if (!existingProjects.has(key)) {
        await createProject(ctx, { name: p.project, client: p.client ?? undefined });
        created.projects++;
      }
    }
  }

  let ok = 0;
  const failed: { row: number; error: string }[] = [...errors];
  let duplicates = 0;
  if (!opts.dryRun) {
    const projects = await listProjects(ctx, true);
    for (const r of normalized) {
      const projectName = r.project ?? null;
      if (!projectName) {
        failed.push({ row: r.row, error: 'no project' });
        continue;
      }
      const project = projects.find((p) => p.name.toLowerCase() === projectName.toLowerCase());
      const res = await logEntry(ctx, {
        description: r.description,
        duration: `${r.duration_min}m`,
        date: r.date,
        start: r.start,
        end: r.end,
        project: project?.id ?? projectName,
        billable: r.billable,
        tags: r.tags,
        source: 'import',
        source_ref: { source, file: opts.filename, row: r.row },
        idempotency_key: `import:${source}:${opts.filename ?? 'file'}:${r.row}:${r.date}:${r.duration_min}`,
      }, { projects });
      if (res.status === 'logged') ok++;
      else if (res.status === 'duplicate') duplicates++;
      else failed.push({ row: r.row, error: res.status === 'error' ? res.error : res.message });
    }
    await query(`INSERT INTO imports (workspace_id, source, filename, rows_ok, rows_failed, errors) VALUES ($1,$2,$3,$4,$5,$6)`, [
      ctx.workspaceId, source, opts.filename ?? null, ok, failed.length, JSON.stringify(failed.slice(0, 200)),
    ]);
  }
  return { source, dry_run: Boolean(opts.dryRun), rows_parsed: normalized.length, rows_ok: ok, rows_failed: failed.length, duplicates, created, errors: failed.slice(0, 50), preview: normalized.slice(0, 5) };
}

export async function listImports(ctx: Ctx) {
  return query(`SELECT id, source, filename, rows_ok, rows_failed, created_at FROM imports WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 20`, [ctx.workspaceId]);
}

export { config, one };
