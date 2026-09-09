import { config } from '../../config.js';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function layout(title: string, body: string, opts: { nav?: boolean; wide?: boolean; user?: { email: string } | null } = {}): string {
  const P = esc(config.productName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${P}</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#1c1917;--accent-fg:#fff;--ok:#15803d;--warn:#b45309;--bad:#b91c1c}
@media(prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--line:#292524;--card:#1c1917;--accent:#f5f5f4;--accent-fg:#1c1917}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
a{color:inherit}main{max-width:${opts.wide ? '960px' : '480px'};margin:0 auto;padding:32px 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:24px;margin:16px 0}
h1{font-size:22px;margin:0 0 8px}h2{font-size:16px;margin:24px 0 8px}p{margin:8px 0}.muted{color:var(--muted);font-size:13px}
label{display:block;font-size:13px;color:var(--muted);margin:12px 0 4px}
input,select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.btn{display:inline-block;padding:11px 18px;border-radius:9px;border:1px solid var(--accent);background:var(--accent);color:var(--accent-fg);font:inherit;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}
.btn.secondary{background:transparent;color:var(--fg);border-color:var(--line)}.btn.block{display:block;width:100%}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1 1 140px}
nav{display:flex;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line);font-size:14px;align-items:center}nav b{margin-right:auto}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:500;font-size:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}
.err{color:var(--bad)}.ok{color:var(--ok)}.center{text-align:center}.scopes li{margin:4px 0}.scopes{padding-left:18px}
.brand{font-weight:700;letter-spacing:-.02em}
</style></head><body>
${opts.nav ? `<nav><b class="brand">${P}</b><a href="${esc(config.appUrl)}">Overview</a><a href="${esc(config.appUrl)}/settings">Settings</a><a href="${esc(config.appUrl)}/import">Import</a><a href="${esc(config.appUrl)}/billing">Billing</a>${opts.user ? `<a href="${esc(config.appUrl)}/logout" class="muted">${esc(opts.user.email)} · log out</a>` : ''}</nav>` : ''}
<main>${body}</main></body></html>`;
}
