import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { App, applyDocumentTheme, applyHostStyleVariables, applyHostFonts } from '@modelcontextprotocol/ext-apps';
import { WeekGrid } from './views/week-grid.js';
import { ReportTable } from './views/report.js';
import { Invoice } from './views/invoice.js';
import type { ToolData, ReportData, InvoiceData, InvoicePreviewData } from './types.js';

declare global {
  interface Window {
    __TALLY_DATA__?: ToolData;
  }
}

type Send = (text: string) => Promise<void>;

function Root() {
  const standalone = Boolean(window.__TALLY_DATA__);
  const [data, setData] = useState<ToolData | null>(window.__TALLY_DATA__ ?? null);
  const [send, setSend] = useState<Send | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (standalone) {
      document.documentElement.classList.add('standalone');
      return;
    }
    const app = new App({ name: 'tally', version: '0.1.0' }, {}, { autoResize: true });
    app.ontoolresult = (result) => {
      const sc = result.structuredContent as ToolData | undefined;
      if (sc) setData(sc);
      else if (result.isError) setError('The tool returned an error.');
    };
    app.onhostcontextchanged = (ctx) => {
      if (ctx.theme) applyDocumentTheme(ctx.theme);
      if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
    };
    app
      .connect()
      .then(() => {
        const ctx = app.getHostContext();
        if (ctx?.theme) applyDocumentTheme(ctx.theme);
        if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
        if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
        setSend(() => async (text: string) => {
          await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
        });
      })
      .catch((e) => setError(`Could not connect to host: ${(e as Error).message}`));
  }, []);

  if (error) return <div class="card empty">{error}</div>;
  if (!data) return <div class="card empty">Loading…</div>;
  const sendPrompt: Send = send ?? (async () => undefined);

  switch (data.view) {
    case 'week_grid':
      return <WeekGrid data={data as ReportData} sendPrompt={sendPrompt} canSend={Boolean(send)} />;
    case 'report':
      return <ReportTable data={data as ReportData} sendPrompt={sendPrompt} canSend={Boolean(send)} />;
    case 'invoice':
    case 'invoice_preview':
      return <Invoice data={data as InvoiceData | InvoicePreviewData} sendPrompt={sendPrompt} canSend={Boolean(send)} standalone={standalone} />;
    default:
      return (
        <div class="card">
          <pre style="white-space:pre-wrap;margin:0;font-size:12px">{JSON.stringify(data, null, 2)}</pre>
        </div>
      );
  }
}

render(<Root />, document.getElementById('root')!);
