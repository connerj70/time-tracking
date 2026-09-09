import { money, type InvoiceData, type InvoicePreviewData } from '../types.js';

interface Props {
  data: InvoiceData | InvoicePreviewData;
  sendPrompt: (t: string) => Promise<void>;
  canSend: boolean;
  standalone: boolean;
}

/** One component renders the MCP App preview, the draft, and the public client-facing page. */
export function Invoice({ data, sendPrompt, canSend, standalone }: Props) {
  const preview = data.view === 'invoice_preview';
  const inv = data as InvoiceData;
  const pv = data as InvoicePreviewData;
  const status = preview ? 'preview' : inv.status;
  const pillClass = status === 'paid' ? 'ok' : status === 'overdue' ? 'bad' : status === 'sent' || status === 'viewed' ? 'info' : status === 'void' ? 'bad' : '';
  const cur = data.currency;

  return (
    <div class="card inv">
      {!preview && inv.paid_banner && <div class="banner ok">Thank you, your payment was received.</div>}
      <div class="letter">
        <div class="from">
          {!preview && inv.from.logo_url && <img class="logo" src={inv.from.logo_url} alt="" />}
          <b>{preview ? 'Invoice preview' : inv.from.name}</b>
          {!preview && inv.from.address && <div class="muted" style="white-space:pre-line">{inv.from.address}</div>}
        </div>
        <div class="meta">
          <div class="n">{preview ? `Through ${pv.through_date}` : inv.number}</div>
          <span class={`pill ${pillClass}`}>{status}{!preview && inv.status === 'overdue' ? ` · ${inv.days_overdue}d` : ''}</span>
        </div>
      </div>

      <div class="parties">
        <div>
          <div class="k">Bill to</div>
          <div><b>{data.client.name}</b></div>
          {!preview && inv.client.address && <div class="muted" style="white-space:pre-line">{inv.client.address}</div>}
          {data.client.billing_email && <div class="muted">{data.client.billing_email}</div>}
        </div>
        {!preview ? (
          <div>
            <div class="k">Dates</div>
            <div>Issued {inv.issue_date}</div>
            <div>Due {inv.due_date}</div>
            {inv.paid_at && <div class="muted">Paid {inv.paid_at.slice(0, 10)}</div>}
          </div>
        ) : (
          <div>
            <div class="k">Work</div>
            <div>{pv.entry_count} entries · {pv.total_hours}h</div>
            {pv.date_range && <div class="muted">{pv.date_range.start} → {pv.date_range.end}</div>}
          </div>
        )}
      </div>

      {data.lines.length === 0 ? (
        <div class="empty">Nothing to invoice yet.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Description</th><th class="r">Hours</th><th class="r hide-sm">Rate</th><th class="r">Amount</th></tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr>
                <td>{l.description}</td>
                <td class="r num">{l.hours.toFixed(2)}</td>
                <td class="r num hide-sm">{money(l.rate, cur)}</td>
                <td class="r num">{money(l.amount, cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div class="totals">
        <div><span class="muted">Subtotal</span><span class="num">{money(data.subtotal, cur)}</span></div>
        {data.tax_rate_percent > 0 && <div><span class="muted">Tax {data.tax_rate_percent}%</span><span class="num">{money(data.tax, cur)}</span></div>}
        <div class="grand"><span>Total</span><span class="num">{money(data.total, cur)}</span></div>
      </div>

      {!preview && inv.notes && <div class="notes">{inv.notes}</div>}
      {preview && pv.warnings.length > 0 && <div class="notes">{pv.warnings.join('\n')}</div>}

      <div class="actions">
        {standalone && !preview && inv.payment_url && inv.status !== 'paid' && inv.status !== 'void' && (
          <a class="btn" href={inv.payment_url}>Pay {inv.total_formatted}</a>
        )}
        {!preview && inv.pdf_url && <a class="btn secondary" href={inv.pdf_url} target="_blank" rel="noreferrer">PDF</a>}
        {!standalone && preview && (
          <button class="btn" disabled={!canSend || data.lines.length === 0} onClick={() => sendPrompt(`Create the draft invoice for ${data.client.name} through ${pv.through_date}`)}>Create draft</button>
        )}
        {!standalone && !preview && inv.status === 'draft' && (
          <>
            <button class="btn" disabled={!canSend} onClick={() => sendPrompt(`Send invoice ${inv.number} to ${inv.client.name}`)}>Send this invoice</button>
            <button class="btn secondary" disabled={!canSend} onClick={() => sendPrompt(`Change the due date on invoice ${inv.number}`)}>Change the due date</button>
          </>
        )}
        {!standalone && !preview && (inv.status === 'sent' || inv.status === 'viewed' || inv.status === 'overdue') && (
          <button class="btn secondary" disabled={!canSend} onClick={() => sendPrompt(`Record a payment for invoice ${inv.number}`)}>Record payment</button>
        )}
      </div>
    </div>
  );
}
