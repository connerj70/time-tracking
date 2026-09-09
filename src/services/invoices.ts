import { one, query, withTx } from '../db/index.js';
import { config } from '../config.js';
import { ToolError } from '../lib/errors.js';
import { addDays, isISODate, todayIn } from '../lib/dates.js';
import { resolveRateCents } from '../lib/rates.js';
import { formatMoney, minutesToHours } from '../lib/money.js';
import { shortToken } from '../lib/ids.js';
import { assertInvoiceLimit, type Ctx } from './context.js';
import { resolveClient, type ClientRow } from './workspace.js';
import { publicEntry, type EntryView } from './time.js';
import { createPaymentLink } from '../stripe/index.js';
import { sendInvoiceEmail } from '../email/index.js';

export interface InvoiceRow {
  id: string;
  workspace_id: string;
  client_id: string;
  number: string;
  status: 'draft' | 'sent' | 'viewed' | 'paid' | 'void';
  issue_date: string;
  due_date: string;
  currency: string;
  subtotal_cents: number;
  tax_rate_bps: number;
  tax_cents: number;
  total_cents: number;
  notes: string | null;
  public_token: string;
  stripe_payment_link_url: string | null;
  stripe_payment_link_id: string | null;
  sent_at: Date | null;
  viewed_at: Date | null;
  paid_at: Date | null;
  paid_via: string | null;
  paid_note: string | null;
  created_at: Date;
}

export interface InvoiceLineRow {
  id: string;
  invoice_id: string;
  position: number;
  description: string;
  hours: number;
  rate_cents: number;
  amount_cents: number;
  time_entry_ids: string[];
}

export type GroupLinesBy = 'project' | 'day' | 'entry';

interface DraftLine {
  description: string;
  hours: number;
  rate_cents: number;
  amount_cents: number;
  time_entry_ids: string[];
}

const UNBILLED_ENTRIES = `
  SELECT t.*, p.name AS project_name, p.rate_cents AS project_rate_cents, c.name AS client_name, c.id AS client_id,
         c.default_rate_cents AS client_rate_cents, NULL::text AS invoice_number, NULL::text AS invoice_status
  FROM time_entries t
  JOIN projects p ON p.id = t.project_id
  JOIN clients c ON c.id = p.client_id
  LEFT JOIN invoices i ON i.id = t.invoice_id
  WHERE t.workspace_id = $1 AND c.id = $2 AND t.billable = true AND t.date <= $3
    AND (t.invoice_id IS NULL OR i.status = 'void')
  ORDER BY t.date, p.name, t.id`;

function buildLines(entries: EntryView[], ws: Ctx['workspace'], groupBy: GroupLinesBy): DraftLine[] {
  type Bucket = { key: string; description: string; minutes: number; rate: number; ids: string[] };
  const buckets = new Map<string, Bucket>();
  for (const e of entries) {
    const rate = resolveRateCents({ entryRateCents: e.rate_cents, projectRateCents: e.project_rate_cents, clientRateCents: e.client_rate_cents, workspaceDefaultCents: ws.default_rate_cents }).rateCents;
    let key: string;
    let description: string;
    if (groupBy === 'entry') {
      key = e.id;
      description = `${e.date} · ${e.project_name}${e.description ? ' — ' + e.description : ''}`;
    } else if (groupBy === 'day') {
      key = `${e.date}|${rate}`;
      description = `${e.date} · ${[...new Set(entries.filter((x) => x.date === e.date).map((x) => x.project_name))].join(', ')}`;
    } else {
      key = `${e.project_id}|${rate}`;
      description = e.project_name ?? 'Work';
    }
    const b = buckets.get(key) ?? { key, description, minutes: 0, rate, ids: [] };
    b.minutes += e.duration_min;
    b.ids.push(e.id);
    buckets.set(key, b);
  }
  return [...buckets.values()].map((b) => {
    const hours = minutesToHours(b.minutes);
    return { description: b.description, hours, rate_cents: b.rate, amount_cents: Math.round(hours * b.rate), time_entry_ids: b.ids };
  });
}

function totals(lines: { amount_cents: number }[], taxRateBps: number) {
  const subtotal = lines.reduce((s, l) => s + l.amount_cents, 0);
  const tax = Math.round((subtotal * taxRateBps) / 10000);
  return { subtotal_cents: subtotal, tax_cents: tax, total_cents: subtotal + tax };
}

export async function previewDraft(ctx: Ctx, input: { client: string; through_date?: string; group_lines_by?: GroupLinesBy; tax_rate_percent?: number }) {
  const ws = ctx.workspace;
  const client = await resolveClient(ctx, input.client);
  const through = input.through_date ?? todayIn(ws.timezone);
  if (!isISODate(through)) throw new ToolError(`Invalid through_date "${input.through_date}"`, 'invalid');
  const entries = await query<EntryView>(UNBILLED_ENTRIES, [ctx.workspaceId, client.id, through]);
  const lines = buildLines(entries, ws, input.group_lines_by ?? 'project');
  const taxBps = Math.round((input.tax_rate_percent ?? 0) * 100);
  const t = totals(lines, taxBps);
  return {
    client: { id: client.id, name: client.name, billing_email: client.billing_email, net_terms_days: client.net_terms_days },
    through_date: through,
    currency: ws.currency,
    entry_count: entries.length,
    total_hours: minutesToHours(entries.reduce((s, e) => s + e.duration_min, 0)),
    lines: lines.map(publicLine),
    subtotal: t.subtotal_cents / 100,
    tax_rate_percent: taxBps / 100,
    tax: t.tax_cents / 100,
    total: t.total_cents / 100,
    total_formatted: formatMoney(t.total_cents, ws.currency),
    date_range: entries.length ? { start: entries[0].date, end: entries[entries.length - 1].date } : null,
    entries: entries.slice(0, 200).map((e) => publicEntry(e, ws)),
    warnings: [
      ...(!client.billing_email ? ['Client has no billing email; invoice.send will need to_email.'] : []),
      ...(entries.length === 0 ? ['No unbilled billable entries for this client through that date.'] : []),
    ],
  };
}

function publicLine(l: DraftLine | InvoiceLineRow) {
  return { description: l.description, hours: Number(l.hours), rate: l.rate_cents / 100, amount: l.amount_cents / 100, time_entry_ids: l.time_entry_ids };
}

export async function createDraft(
  ctx: Ctx,
  input: { client: string; through_date?: string; group_lines_by?: GroupLinesBy; due_in_days?: number; notes?: string; tax_rate_percent?: number; issue_date?: string },
) {
  const ws = ctx.workspace;
  await assertInvoiceLimit(ctx);
  const client = await resolveClient(ctx, input.client);
  const through = input.through_date ?? todayIn(ws.timezone);
  if (!isISODate(through)) throw new ToolError(`Invalid through_date "${input.through_date}"`, 'invalid');
  const issue = input.issue_date ?? todayIn(ws.timezone);
  if (!isISODate(issue)) throw new ToolError(`Invalid issue_date "${input.issue_date}"`, 'invalid');
  const dueDays = input.due_in_days ?? client.net_terms_days ?? 30;
  const taxBps = Math.round((input.tax_rate_percent ?? 0) * 100);

  const invoiceId = await withTx(async (tx) => {
    const entries = await query<EntryView>(UNBILLED_ENTRIES + ' FOR UPDATE OF t', [ctx.workspaceId, client.id, through], tx);
    if (!entries.length) throw new ToolError(`No unbilled billable entries for ${client.name} through ${through}.`, 'invalid');
    const lines = buildLines(entries, ws, input.group_lines_by ?? 'project');
    const t = totals(lines, taxBps);
    const wsRow = await one<{ invoice_prefix: string; next_invoice_number: number }>(
      `UPDATE workspaces SET next_invoice_number = next_invoice_number + 1 WHERE id = $1 RETURNING invoice_prefix, next_invoice_number - 1 AS next_invoice_number`,
      [ctx.workspaceId],
      tx,
    );
    const number = `${wsRow!.invoice_prefix}${String(wsRow!.next_invoice_number).padStart(4, '0')}`;
    const inv = await one<{ id: string }>(
      `INSERT INTO invoices (workspace_id, client_id, number, status, issue_date, due_date, currency, subtotal_cents, tax_rate_bps, tax_cents, total_cents, notes, public_token)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [ctx.workspaceId, client.id, number, issue, addDays(issue, dueDays), ws.currency, t.subtotal_cents, taxBps, t.tax_cents, t.total_cents, input.notes ?? null, shortToken()],
      tx,
    );
    let pos = 0;
    for (const l of lines) {
      await query(
        `INSERT INTO invoice_lines (invoice_id, position, description, hours, rate_cents, amount_cents, time_entry_ids) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [inv!.id, pos++, l.description, l.hours, l.rate_cents, l.amount_cents, l.time_entry_ids],
        tx,
      );
    }
    await query(`UPDATE time_entries SET invoice_id = $1 WHERE id = ANY($2::uuid[])`, [inv!.id, entries.map((e) => e.id)], tx);
    return inv!.id;
  });
  return getInvoice(ctx, invoiceId);
}

export async function findInvoice(ctx: Ctx, ref: string): Promise<InvoiceRow> {
  const inv = await one<InvoiceRow>(
    `SELECT * FROM invoices WHERE workspace_id = $1 AND (id::text = $2 OR number = $2 OR lower(number) = lower($2))`,
    [ctx.workspaceId, ref],
  );
  if (!inv) throw new ToolError(`No invoice "${ref}". Use invoice.list to find the id or number.`, 'not_found');
  return inv;
}

export function publicUrl(inv: InvoiceRow): string {
  return `${config.baseUrl}/i/${inv.public_token}`;
}

export function effectiveStatus(inv: InvoiceRow, today: string): InvoiceRow['status'] | 'overdue' {
  if ((inv.status === 'sent' || inv.status === 'viewed') && inv.due_date < today) return 'overdue';
  return inv.status;
}

export async function getInvoice(ctx: Ctx, ref: string) {
  const inv = await findInvoice(ctx, ref);
  const [lines, client] = await Promise.all([
    query<InvoiceLineRow>(`SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY position`, [inv.id]),
    one<ClientRow>(`SELECT * FROM clients WHERE id = $1`, [inv.client_id]),
  ]);
  return serializeInvoice(ctx.workspace, inv, lines, client!);
}

export function serializeInvoice(ws: Ctx['workspace'], inv: InvoiceRow, lines: InvoiceLineRow[], client: ClientRow) {
  const today = todayIn(ws.timezone);
  const status = effectiveStatus(inv, today);
  return {
    view: 'invoice' as const,
    id: inv.id,
    number: inv.number,
    status,
    is_overdue: status === 'overdue',
    days_overdue: status === 'overdue' ? Math.max(0, Math.round((Date.parse(today) - Date.parse(inv.due_date)) / 86400000)) : 0,
    client: { id: client.id, name: client.name, billing_email: client.billing_email, address: client.address },
    from: { name: ws.name, address: ws.business_address, logo_url: ws.logo_url },
    issue_date: inv.issue_date,
    due_date: inv.due_date,
    currency: inv.currency,
    lines: lines.map(publicLine),
    subtotal: inv.subtotal_cents / 100,
    tax_rate_percent: inv.tax_rate_bps / 100,
    tax: inv.tax_cents / 100,
    total: inv.total_cents / 100,
    total_formatted: formatMoney(inv.total_cents, inv.currency),
    notes: inv.notes,
    public_url: publicUrl(inv),
    pdf_url: `${publicUrl(inv)}.pdf`,
    payment_url: inv.stripe_payment_link_url,
    sent_at: inv.sent_at?.toISOString() ?? null,
    viewed_at: inv.viewed_at?.toISOString() ?? null,
    paid_at: inv.paid_at?.toISOString() ?? null,
    paid_via: inv.paid_via,
    entry_count: lines.reduce((s, l) => s + l.time_entry_ids.length, 0),
    total_hours: Math.round(lines.reduce((s, l) => s + Number(l.hours), 0) * 100) / 100,
  };
}

export async function listInvoices(ctx: Ctx, f: { status?: string; client?: string; start_date?: string; end_date?: string; limit?: number }) {
  const ws = ctx.workspace;
  const today = todayIn(ws.timezone);
  const where = ['i.workspace_id = $1'];
  const params: unknown[] = [ctx.workspaceId];
  const status = f.status ?? 'all';
  if (status === 'overdue') {
    where.push(`i.status IN ('sent','viewed') AND i.due_date < $${params.length + 1}`);
    params.push(today);
  } else if (status === 'outstanding') {
    where.push(`i.status IN ('sent','viewed')`);
  } else if (status !== 'all') {
    if (!['draft', 'sent', 'viewed', 'paid', 'void'].includes(status)) throw new ToolError(`Unknown status "${status}"`, 'invalid');
    where.push(`i.status = $${params.length + 1}`);
    params.push(status);
  }
  if (f.client) {
    const c = await resolveClient(ctx, f.client);
    where.push(`i.client_id = $${params.length + 1}`);
    params.push(c.id);
  }
  if (f.start_date) {
    if (!isISODate(f.start_date)) throw new ToolError('Invalid start_date', 'invalid');
    where.push(`i.issue_date >= $${params.length + 1}`);
    params.push(f.start_date);
  }
  if (f.end_date) {
    if (!isISODate(f.end_date)) throw new ToolError('Invalid end_date', 'invalid');
    where.push(`i.issue_date <= $${params.length + 1}`);
    params.push(f.end_date);
  }
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const rows = await query<InvoiceRow & { client_name: string }>(
    `SELECT i.*, c.name AS client_name FROM invoices i JOIN clients c ON c.id = i.client_id
     WHERE ${where.join(' AND ')} ORDER BY i.issue_date DESC, i.number DESC LIMIT ${limit}`,
    params,
  );
  const invoices = rows.map((inv) => {
    const st = effectiveStatus(inv, today);
    return {
      id: inv.id,
      number: inv.number,
      client: inv.client_name,
      status: st,
      issue_date: inv.issue_date,
      due_date: inv.due_date,
      total: inv.total_cents / 100,
      total_formatted: formatMoney(inv.total_cents, inv.currency),
      currency: inv.currency,
      public_url: publicUrl(inv),
      paid_at: inv.paid_at?.toISOString() ?? null,
    };
  });
  const outstanding = rows.filter((r) => r.status === 'sent' || r.status === 'viewed');
  return {
    status_filter: status,
    today,
    count: invoices.length,
    outstanding_total: outstanding.reduce((s, r) => s + r.total_cents, 0) / 100,
    overdue_total: outstanding.filter((r) => r.due_date < today).reduce((s, r) => s + r.total_cents, 0) / 100,
    currency: ws.currency,
    invoices,
  };
}

export async function sendInvoice(ctx: Ctx, input: { invoice_id: string; to_email?: string; message?: string }) {
  const inv = await findInvoice(ctx, input.invoice_id);
  if (inv.status === 'void') throw new ToolError(`Invoice ${inv.number} is void and cannot be sent.`, 'invalid');
  if (inv.status === 'paid') throw new ToolError(`Invoice ${inv.number} is already paid.`, 'invalid');
  const client = (await one<ClientRow>(`SELECT * FROM clients WHERE id = $1`, [inv.client_id]))!;
  const to = (input.to_email ?? client.billing_email ?? '').trim();
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    throw new ToolError(`${client.name} has no billing email on file. Ask the user for one and pass to_email.`, 'invalid');
  }
  // Payment link: created once, reused on re-send.
  let paymentUrl = inv.stripe_payment_link_url;
  if (!paymentUrl && config.stripe.enabled) {
    const link = await createPaymentLink({ workspace: ctx.workspace, invoice: inv, clientName: client.name });
    if (link) {
      paymentUrl = link.url;
      await query(`UPDATE invoices SET stripe_payment_link_url = $2, stripe_payment_link_id = $3 WHERE id = $1`, [inv.id, link.url, link.id]);
    }
  }
  if (!client.billing_email && input.to_email) {
    await query(`UPDATE clients SET billing_email = $2 WHERE id = $1`, [client.id, to]);
  }
  const full = await getInvoice(ctx, inv.id);
  await sendInvoiceEmail({ to, workspace: ctx.workspace, invoice: { ...full, payment_url: paymentUrl }, message: input.message });
  const wasDraft = inv.status === 'draft';
  await query(`UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = COALESCE(sent_at, now()) WHERE id = $1`, [inv.id]);
  return { sent: true, to, resent: !wasDraft, payment_link: paymentUrl ?? null, invoice: await getInvoice(ctx, inv.id) };
}

export async function recordPayment(ctx: Ctx, input: { invoice_id: string; paid_on?: string; method?: string; note?: string }) {
  const inv = await findInvoice(ctx, input.invoice_id);
  if (inv.status === 'void') throw new ToolError(`Invoice ${inv.number} is void.`, 'invalid');
  if (inv.status === 'paid') return { already_paid: true, invoice: await getInvoice(ctx, inv.id) };
  const paidOn = input.paid_on ?? todayIn(ctx.workspace.timezone);
  if (!isISODate(paidOn)) throw new ToolError('Invalid paid_on date', 'invalid');
  await query(`UPDATE invoices SET status = 'paid', paid_at = $2::date, paid_via = 'manual', paid_note = $3 WHERE id = $1`, [inv.id, paidOn, [input.method, input.note].filter(Boolean).join(': ') || null]);
  return { recorded: true, invoice: await getInvoice(ctx, inv.id) };
}

export async function markPaidByStripe(invoiceId: string, ref: string): Promise<void> {
  await query(`UPDATE invoices SET status = 'paid', paid_at = now(), paid_via = 'stripe', paid_note = $2 WHERE id = $1 AND status <> 'paid'`, [invoiceId, ref]);
}

export async function voidInvoice(ctx: Ctx, input: { invoice_id: string; reason?: string; confirm?: boolean }) {
  const inv = await findInvoice(ctx, input.invoice_id);
  if (inv.status === 'void') return { already_void: true, invoice: await getInvoice(ctx, inv.id) };
  if (inv.status === 'paid') throw new ToolError(`Invoice ${inv.number} is paid; voiding a paid invoice is not supported. Record a credit on the next invoice instead.`, 'invalid');
  if (!input.confirm) {
    return { voided: false, needs_confirmation: true, invoice: await getInvoice(ctx, inv.id), message: 'Show this invoice to the user and call again with confirm: true. Voiding releases its time entries so they can be invoiced again.' };
  }
  await withTx(async (tx) => {
    await query(`UPDATE invoices SET status = 'void', notes = COALESCE(notes || E'\n', '') || $2 WHERE id = $1`, [inv.id, `Voided${input.reason ? ': ' + input.reason : ''}`], tx);
    await query(`UPDATE time_entries SET invoice_id = NULL WHERE invoice_id = $1`, [inv.id], tx);
  });
  return { voided: true, invoice: await getInvoice(ctx, inv.id) };
}

/** Public page view: flips sent → viewed once. Returns null when the token is unknown. */
export async function publicInvoiceByToken(token: string) {
  const inv = await one<InvoiceRow>(`SELECT * FROM invoices WHERE public_token = $1`, [token]);
  if (!inv) return null;
  if (inv.status === 'draft') return null; // drafts aren't viewable by clients
  if (inv.status === 'sent') {
    await query(`UPDATE invoices SET status = 'viewed', viewed_at = COALESCE(viewed_at, now()) WHERE id = $1 AND status = 'sent'`, [inv.id]);
    inv.status = 'viewed';
  }
  const [ws, lines, client] = await Promise.all([
    one<Ctx['workspace']>(`SELECT * FROM workspaces WHERE id = $1`, [inv.workspace_id]),
    query<InvoiceLineRow>(`SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY position`, [inv.id]),
    one<ClientRow>(`SELECT * FROM clients WHERE id = $1`, [inv.client_id]),
  ]);
  return serializeInvoice(ws!, inv, lines, client!);
}

export async function invoiceForOwner(token: string, workspaceId: string) {
  const inv = await one<InvoiceRow>(`SELECT * FROM invoices WHERE public_token = $1 AND workspace_id = $2`, [token, workspaceId]);
  if (!inv) return null;
  const [ws, lines, client] = await Promise.all([
    one<Ctx['workspace']>(`SELECT * FROM workspaces WHERE id = $1`, [inv.workspace_id]),
    query<InvoiceLineRow>(`SELECT * FROM invoice_lines WHERE invoice_id = $1 ORDER BY position`, [inv.id]),
    one<ClientRow>(`SELECT * FROM clients WHERE id = $1`, [inv.client_id]),
  ]);
  return serializeInvoice(ws!, inv, lines, client!);
}

export type SerializedInvoice = ReturnType<typeof serializeInvoice>;
