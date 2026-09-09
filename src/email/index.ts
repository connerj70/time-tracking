import { config } from '../config.js';
import type { WorkspaceRow } from '../services/context.js';
import type { SerializedInvoice } from '../services/invoices.js';
import { formatMoney } from '../lib/money.js';

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function sendMail(mail: Mail): Promise<void> {
  if (!config.email.resendApiKey) {
    if (config.isProd) throw new Error('RESEND_API_KEY is not set; cannot send email');
    console.log(`\n=== DEV EMAIL (not sent) ===\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n============================\n`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.email.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.email.from, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`Email send failed: ${res.status} ${await res.text()}`);
}

export async function sendInvoiceEmail(opts: { to: string; workspace: WorkspaceRow; invoice: SerializedInvoice & { payment_url: string | null }; message?: string }): Promise<void> {
  const { invoice, workspace } = opts;
  const total = formatMoney(Math.round(invoice.total * 100), invoice.currency);
  const subject = `Invoice ${invoice.number} from ${workspace.name} — ${total}`;
  const payLine = invoice.payment_url ? `Pay online: ${invoice.payment_url}` : '';
  const text = [
    opts.message?.trim(),
    `${workspace.name} has sent you invoice ${invoice.number} for ${total}, due ${invoice.due_date}.`,
    `View invoice: ${invoice.public_url}`,
    payLine,
    `PDF: ${invoice.pdf_url}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const html = `
  <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
    ${opts.message ? `<p style="white-space:pre-wrap">${escape(opts.message)}</p>` : ''}
    <p><strong>${escape(workspace.name)}</strong> has sent you invoice <strong>${escape(invoice.number)}</strong>.</p>
    <table style="border-collapse:collapse;margin:16px 0">
      <tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td><td style="padding:4px 0"><strong>${escape(total)}</strong></td></tr>
      <tr><td style="padding:4px 12px 4px 0;color:#666">Due</td><td style="padding:4px 0">${escape(invoice.due_date)}</td></tr>
    </table>
    ${invoice.payment_url ? `<p><a href="${escape(invoice.payment_url)}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Pay ${escape(total)}</a></p>` : ''}
    <p><a href="${escape(invoice.public_url)}">View invoice</a> · <a href="${escape(invoice.pdf_url)}">Download PDF</a></p>
  </div>`;
  await sendMail({ to: opts.to, subject, html, text });
}

export async function sendMagicLink(to: string, url: string): Promise<void> {
  await sendMail({
    to,
    subject: `Sign in to ${config.productName}`,
    text: `Click to sign in: ${url}\n\nThis link expires in 15 minutes.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px"><p>Click to sign in to ${escape(config.productName)}:</p><p><a href="${escape(url)}" style="display:inline-block;background:#111;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Sign in</a></p><p style="color:#666">This link expires in 15 minutes.</p></div>`,
  });
}
