export interface ReportGroup {
  key: string;
  label: string;
  client?: string | null;
  hours: number;
  billable_hours: number;
  billable_amount: number;
  unbilled_amount: number;
  entries: number;
  projects?: { project: string; client: string | null; hours: number }[];
}

export interface ReportData {
  view: 'week_grid' | 'report';
  range: { start: string; end: string };
  timezone: string;
  currency: string;
  total_hours: number;
  billable_hours: number;
  non_billable_hours: number;
  billable_amount: number;
  unbilled_amount: number;
  entry_count: number;
  group_by: 'day' | 'project' | 'client' | 'none';
  groups: ReportGroup[];
  filters?: { project?: string; client?: string };
}

export interface InvoiceLine {
  description: string;
  hours: number;
  rate: number;
  amount: number;
}

export interface InvoiceData {
  view: 'invoice';
  id: string;
  number: string;
  status: 'draft' | 'sent' | 'viewed' | 'paid' | 'void' | 'overdue';
  is_overdue: boolean;
  days_overdue: number;
  client: { id: string; name: string; billing_email: string | null; address: string | null };
  from: { name: string; address: string | null; logo_url: string | null };
  issue_date: string;
  due_date: string;
  currency: string;
  lines: InvoiceLine[];
  subtotal: number;
  tax_rate_percent: number;
  tax: number;
  total: number;
  total_formatted: string;
  notes: string | null;
  public_url: string;
  pdf_url: string;
  payment_url: string | null;
  paid_at: string | null;
  total_hours: number;
  paid_banner?: boolean;
}

export interface InvoicePreviewData {
  view: 'invoice_preview';
  client: { id: string; name: string; billing_email: string | null; net_terms_days: number };
  through_date: string;
  currency: string;
  entry_count: number;
  total_hours: number;
  lines: InvoiceLine[];
  subtotal: number;
  tax_rate_percent: number;
  tax: number;
  total: number;
  total_formatted: string;
  date_range: { start: string; end: string } | null;
  warnings: string[];
}

export type ToolData = ReportData | InvoiceData | InvoicePreviewData | { view?: string; [k: string]: unknown };

export function money(n: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

export function hours(n: number): string {
  if (!n) return '·';
  return n % 1 === 0 ? `${n}` : n.toFixed(2).replace(/0$/, '');
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayLabel(iso: string): { dow: string; long: string; dm: string } {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return { dow: DOW[dt.getUTCDay()], long: DOW_LONG[dt.getUTCDay()], dm: `${d}` };
}

export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  const [y, m, d] = start.split('-').map(Number);
  const cur = new Date(Date.UTC(y, m - 1, d));
  for (let i = 0; i < 62; i++) {
    const iso = cur.toISOString().slice(0, 10);
    if (iso > end) break;
    out.push(iso);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
