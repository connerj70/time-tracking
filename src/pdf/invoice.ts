import PDFDocument from 'pdfkit';
import type { SerializedInvoice } from '../services/invoices.js';
import { formatMoney } from '../lib/money.js';

export function renderInvoicePdf(inv: SerializedInvoice): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const money = (n: number) => formatMoney(Math.round(n * 100), inv.currency);

    doc.fontSize(22).font('Helvetica-Bold').text(inv.from.name);
    if (inv.from.address) doc.fontSize(10).font('Helvetica').fillColor('#555').text(inv.from.address);
    doc.moveDown(1.5);
    doc.fillColor('#000').fontSize(18).font('Helvetica-Bold').text(`Invoice ${inv.number}`);
    const statusLabel = inv.status.toUpperCase();
    doc.fontSize(10).font('Helvetica').fillColor(inv.status === 'paid' ? '#0a7' : inv.is_overdue ? '#c33' : '#555').text(statusLabel);
    doc.fillColor('#000').moveDown();

    const top = doc.y;
    doc.fontSize(10).font('Helvetica-Bold').text('Bill to', 54, top);
    doc.font('Helvetica').text(inv.client.name);
    if (inv.client.address) doc.text(inv.client.address);
    if (inv.client.billing_email) doc.text(inv.client.billing_email);
    doc.font('Helvetica-Bold').text('Issued', 380, top, { continued: true }).font('Helvetica').text(`  ${inv.issue_date}`);
    doc.font('Helvetica-Bold').text('Due', 380, doc.y, { continued: true }).font('Helvetica').text(`  ${inv.due_date}`);
    doc.moveDown(2);

    // Table
    const cols = { desc: 54, hours: 350, rate: 420, amount: 490 };
    let y = doc.y;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Description', cols.desc, y).text('Hours', cols.hours, y, { width: 60, align: 'right' }).text('Rate', cols.rate, y, { width: 60, align: 'right' }).text('Amount', cols.amount, y, { width: 68, align: 'right' });
    y = doc.y + 4;
    doc.moveTo(54, y).lineTo(558, y).strokeColor('#ccc').stroke();
    y += 8;
    doc.font('Helvetica');
    for (const l of inv.lines) {
      if (y > 700) {
        doc.addPage();
        y = 54;
      }
      doc.text(l.description, cols.desc, y, { width: 280 });
      const h = doc.y;
      doc.text(l.hours.toFixed(2), cols.hours, y, { width: 60, align: 'right' });
      doc.text(money(l.rate), cols.rate, y, { width: 60, align: 'right' });
      doc.text(money(l.amount), cols.amount, y, { width: 68, align: 'right' });
      y = Math.max(h, doc.y) + 6;
    }
    doc.moveTo(54, y).lineTo(558, y).strokeColor('#ccc').stroke();
    y += 10;
    const totalRow = (label: string, val: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').text(label, 380, y, { width: 100, align: 'right' }).text(val, cols.amount, y, { width: 68, align: 'right' });
      y = doc.y + 4;
    };
    totalRow('Subtotal', money(inv.subtotal));
    if (inv.tax_rate_percent > 0) totalRow(`Tax (${inv.tax_rate_percent}%)`, money(inv.tax));
    totalRow('Total', money(inv.total), true);
    if (inv.status === 'paid') totalRow('Paid', money(inv.total));

    if (inv.notes) {
      doc.moveDown(2);
      doc.font('Helvetica-Bold').text('Notes', 54, y + 20);
      doc.font('Helvetica').text(inv.notes, { width: 500 });
    }
    if (inv.payment_url && inv.status !== 'paid') {
      doc.moveDown(2);
      doc.fillColor('#06c').text(`Pay online: ${inv.payment_url}`, 54, doc.y, { link: inv.payment_url, underline: true });
    }
    doc.end();
  });
}
