import { Router } from 'express';
import { invoiceForOwner, publicInvoiceByToken, type SerializedInvoice } from '../../services/invoices.js';
import { renderInvoicePdf } from '../../pdf/invoice.js';
import { loadAppHtml } from '../../mcp/app-resource.js';
import { readSession } from '../../auth/session.js';
import { esc, layout } from '../views/layout.js';
import { formatMoney } from '../../lib/money.js';

export const invoicePublicRoutes = Router();

async function load(token: string, req: Parameters<Parameters<Router['get']>[1]>[0]) {
  // Owners can preview drafts; clients only see sent+ invoices.
  const session = readSession(req);
  if (session) {
    const own = await invoiceForOwner(token, session.workspaceId);
    if (own) return own;
  }
  return publicInvoiceByToken(token);
}

invoicePublicRoutes.get('/i/:token.pdf', async (req, res) => {
  const inv = await load(req.params.token, req);
  if (!inv) return res.status(404).send('Not found');
  const pdf = await renderInvoicePdf(inv);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inv.number}.pdf"`);
  res.send(pdf);
});

invoicePublicRoutes.get('/i/:token', async (req, res) => {
  const inv = await load(req.params.token, req);
  if (!inv) return res.status(404).send(layout('Not found', `<div class="card"><h1>Invoice not found</h1><p class="muted">The link may be wrong, or the invoice hasn't been sent yet.</p></div>`));
  const app = loadAppHtml();
  if (app) {
    // Same bundle as the MCP App view; data is injected instead of arriving via ui/notifications/tool-result.
    const inject = `<script>window.__TALLY_DATA__=${JSON.stringify({ ...inv, paid_banner: req.query.paid === '1' }).replace(/</g, '\\u003c')};</script>`;
    return res.send(app.replace('<head>', `<head><title>Invoice ${esc(inv.number)}</title>${inject}`));
  }
  res.send(fallbackHtml(inv));
});

function fallbackHtml(inv: SerializedInvoice): string {
  const money = (n: number) => formatMoney(Math.round(n * 100), inv.currency);
  return layout(
    `Invoice ${inv.number}`,
    `<div class="card">
      <h1>${esc(inv.from.name)}</h1><p class="muted">Invoice ${esc(inv.number)} · <span class="pill ${inv.status === 'paid' ? 'ok' : inv.is_overdue ? 'bad' : ''}">${esc(inv.status)}</span></p>
      <p><b>Bill to</b><br>${esc(inv.client.name)}</p><p>Issued ${esc(inv.issue_date)} · Due ${esc(inv.due_date)}</p>
      <table><tr><th>Description</th><th>Hours</th><th>Rate</th><th>Amount</th></tr>
      ${inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td>${l.hours.toFixed(2)}</td><td>${esc(money(l.rate))}</td><td>${esc(money(l.amount))}</td></tr>`).join('')}
      <tr><td colspan="3" style="text-align:right"><b>Total</b></td><td><b>${esc(inv.total_formatted)}</b></td></tr></table>
      ${inv.payment_url && inv.status !== 'paid' ? `<p><a class="btn" href="${esc(inv.payment_url)}">Pay ${esc(inv.total_formatted)}</a></p>` : ''}
      <p><a href="${esc(inv.pdf_url)}">Download PDF</a></p>
    </div>`,
  );
}
