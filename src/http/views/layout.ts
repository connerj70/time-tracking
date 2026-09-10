import { config } from '../../config.js';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The tally mark: four strokes and the fifth laid across them. Ink adapts; the slash is always brand lime. */
export function mark(size = 22): string {
  return `<svg class="mark" width="${size}" height="${Math.round((size * 24) / 28)}" viewBox="0 0 28 24" fill="none" aria-hidden="true" focusable="false">
    <g fill="currentColor"><rect x="3" y="3" width="3.5" height="18" rx=".6"/><rect x="8.7" y="3" width="3.5" height="18" rx=".6"/><rect x="14.4" y="3" width="3.5" height="18" rx=".6"/><rect x="20.1" y="3" width="3.5" height="18" rx=".6"/></g>
    <path d="M2.6 18.6 24.4 6.4" stroke="var(--lime)" stroke-width="3.6" stroke-linecap="round"/>
  </svg>`;
}

export type LayoutWidth = 'app' | 'focus' | 'prose';

export interface LayoutOpts {
  nav?: boolean;
  /** Public pages (landing, docs, policies) get a light header and footer instead of the app nav. */
  publicChrome?: boolean;
  /** Legacy alias for width: 'app'. */
  wide?: boolean;
  width?: LayoutWidth;
  user?: { email: string } | null;
  /** Path of the current app page, used to mark the active nav item. */
  active?: string;
}

const NAV = [
  ['', 'Overview'],
  ['/settings', 'Settings'],
  ['/import', 'Import'],
  ['/billing', 'Billing'],
] as const;

export function layout(title: string, body: string, opts: LayoutOpts = {}): string {
  const P = esc(config.productName);
  const width = opts.width ?? (opts.wide ? 'app' : 'focus');
  const app = esc(config.appUrl);
  const nav = opts.nav
    ? `<header class="topbar"><div class="topbar-in">
        <a class="wordmark" href="${app}">${mark(20)}<span>${P}</span></a>
        <nav aria-label="Sections">${NAV.map(([href, label]) => {
          const on = (opts.active ?? '') === href;
          return `<a href="${app}${href}"${on ? ' aria-current="page"' : ''}>${label}</a>`;
        }).join('')}</nav>
        ${opts.user ? `<div class="account"><span title="${esc(opts.user.email)}">${esc(opts.user.email)}</span><a href="${app}/logout">Log out</a></div>` : ''}
      </div></header>`
    : '';

  const publicHeader = opts.publicChrome
    ? `<header class="topbar"><div class="topbar-in public">
        <a class="wordmark" href="${esc(config.baseUrl)}">${mark(20)}<span>${P}</span></a>
        <nav aria-label="Site"><a href="${esc(config.baseUrl)}/docs">Docs</a><a href="${esc(config.baseUrl)}/support">Support</a></nav>
        <a class="btn secondary signin" href="${esc(config.baseUrl)}/oauth/login">Sign in</a>
      </div></header>`
    : '';
  const publicFooter = opts.publicChrome
    ? `<footer class="sitefoot"><div class="sitefoot-in">
        <span>${P}</span>
        <nav><a href="${esc(config.baseUrl)}/docs">Docs</a><a href="${esc(config.baseUrl)}/support">Support</a><a href="${esc(config.baseUrl)}/privacy">Privacy</a><a href="${esc(config.baseUrl)}/terms">Terms</a></nav>
      </div></footer>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · ${P}</title>
<meta name="color-scheme" content="light dark">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&display=swap">
<style>
:root{
  --ground:#f6f5f2; --paper:#fff; --sunk:#efeee9;
  --ink:#14120e; --ink-2:#6f6b62; --ink-3:#95908a;
  --rule:#e6e3dc; --rule-2:#d6d2c8;
  --lime:#c6f726; --on-lime:#14120e;
  --paid:#12734a; --paid-bg:#e3f3e9; --due:#8a5d00; --due-bg:#fbf0d8; --late:#ac2318; --late-bg:#fbe6e3;
  --r:10px; --r-sm:7px;
  --sans:"Instrument Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#100f0c; --paper:#191713; --sunk:#100f0c;
  --ink:#f4f1e8; --ink-2:#a49e92; --ink-3:#7d776c;
  --rule:#2b2822; --rule-2:#3a362e;
  --paid:#5fd39a; --paid-bg:#12301f; --due:#e0b45c; --due-bg:#33260c; --late:#f08a7f; --late-bg:#3a1613;
}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);
  font:400 15px/1.55 var(--sans);font-variant-numeric:tabular-nums;
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
a{color:inherit;text-underline-offset:.18em;text-decoration-color:var(--rule-2)}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px;border-radius:3px}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}

/* ---------- shell ---------- */
.topbar{background:var(--paper);border-bottom:1px solid var(--rule);position:sticky;top:0;z-index:20}
.topbar-in{max-width:1040px;margin:0 auto;padding:0 24px;display:flex;align-items:stretch;gap:28px;min-height:56px}
.wordmark{display:flex;align-items:center;gap:9px;font-weight:600;letter-spacing:-.021em;font-size:16px;text-decoration:none;flex:none}
.wordmark .mark{display:block}
.topbar nav{display:flex;gap:22px;align-items:stretch;overflow-x:auto;scrollbar-width:none}
.topbar nav::-webkit-scrollbar{display:none}
.topbar nav a{display:flex;align-items:center;position:relative;color:var(--ink-2);text-decoration:none;font-size:14px;white-space:nowrap}
.topbar nav a:hover{color:var(--ink)}
.topbar nav a[aria-current]{color:var(--ink);font-weight:500}
.topbar nav a[aria-current]::after{content:"";position:absolute;left:-2px;right:-2px;bottom:0;height:3px;background:var(--lime)}
.account{margin-left:auto;display:flex;align-items:center;gap:14px;font-size:13px;color:var(--ink-2);flex:none}
.account span{max-width:22ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.account a{text-decoration:none}.account a:hover{color:var(--ink);text-decoration:underline}
.topbar-in.public{max-width:660px;align-items:center}
.topbar-in.public nav{margin-left:22px}
.topbar-in.public .signin{margin-left:auto;padding:7px 14px;font-size:14px;flex:none}
.sitefoot{border-top:1px solid var(--rule);margin-top:40px}
.sitefoot-in{max-width:660px;margin:0 auto;padding:22px 24px 40px;display:flex;gap:18px;flex-wrap:wrap;align-items:center;font-size:13px;color:var(--ink-2)}
.sitefoot-in nav{display:flex;gap:18px;margin-left:auto;flex-wrap:wrap}
.sitefoot-in a{text-decoration:none}.sitefoot-in a:hover{color:var(--ink);text-decoration:underline}
main{margin:0 auto;padding:40px 24px 88px}
main.app{max-width:1040px}
main.focus{max-width:452px;padding-top:64px}
main.prose{max-width:660px}

/* ---------- type ---------- */
h1{font-size:26px;line-height:1.2;letter-spacing:-.024em;font-weight:600;margin:0 0 6px}
h2{font-size:17px;line-height:1.3;letter-spacing:-.014em;font-weight:600;margin:0 0 10px}
h3{font-size:15px;font-weight:600;margin:22px 0 6px}
p{margin:0 0 12px}
.lede{color:var(--ink-2);font-size:15px;margin:0 0 20px}
.card .lede,.panel .lede{margin-bottom:18px}
.muted{color:var(--ink-2);font-size:13.5px}
small{font-size:12.5px}
.num{font-variant-numeric:tabular-nums}

/* Facts: label over value. Replaces dot-joined meta strings. */
.facts{display:flex;flex-wrap:wrap;gap:4px 30px;margin:14px 0 0;padding:0;list-style:none}
.facts div{display:flex;flex-direction:column;gap:1px}
.facts dt,.facts .k{font-size:12px;color:var(--ink-3);font-weight:400}
.facts dd,.facts .v{margin:0;font-size:13.5px;font-weight:500}

/* ---------- panels: rules, not shadows ---------- */
.panel{background:var(--paper);border:1px solid var(--rule);border-radius:var(--r);padding:22px 24px;margin:0 0 18px}
.panel > :last-child{margin-bottom:0}
.panel-hd{display:flex;align-items:baseline;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}
.panel-hd h2{margin:0}
.card{background:var(--paper);border:1px solid var(--rule);border-radius:var(--r);padding:22px 24px;margin:0 0 18px}
.card > :last-child{margin-bottom:0}
.grid{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));margin-bottom:18px}
.row{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end}
.row > *{flex:1 1 180px;min-width:0}

/* ---------- figures ---------- */
.figures{display:flex;flex-wrap:wrap;gap:0;border-top:1px solid var(--rule);margin:0 0 4px}
.figures > div{flex:1 1 150px;padding:14px 22px 14px 0;border-bottom:1px solid var(--rule)}
.figures .k{display:block;font-size:12.5px;color:var(--ink-2);margin-bottom:3px}
.figures .v{display:block;font-size:27px;line-height:1.1;letter-spacing:-.028em;font-weight:600}
/* The tally slash, reused as a marker under the one number that matters. */
.marker{display:inline;padding:0 .1em;background-image:linear-gradient(var(--lime),var(--lime));
  background-repeat:no-repeat;background-size:100% .26em;background-position:0 96%}
.figures .marked .v{display:inline;padding:0 .1em;background-image:linear-gradient(var(--lime),var(--lime));
  background-repeat:no-repeat;background-size:100% .24em;background-position:0 94%}

/* ---------- ledger tables ---------- */
table{width:100%;border-collapse:collapse;font-size:14px}
caption{text-align:left;font-size:12.5px;color:var(--ink-2);padding-bottom:8px}
th{text-align:left;font-weight:500;font-size:12.5px;color:var(--ink-2);padding:0 12px 8px 0;border-bottom:1px solid var(--rule-2)}
td{padding:11px 12px 11px 0;border-bottom:1px solid var(--rule);vertical-align:baseline}
tr:last-child td{border-bottom:0}
th:last-child,td:last-child{padding-right:0}
th.r,td.r,.r{text-align:right;white-space:nowrap}
tbody tr.link:hover{background:var(--sunk)}
td .sub{display:block;color:var(--ink-2);font-size:12.5px;margin-top:2px}
.empty{padding:26px 0;color:var(--ink-2)}

/* ---------- forms ---------- */
label{display:block;font-size:13px;color:var(--ink-2);margin:0 0 5px}
.field{margin:0 0 16px}
input,select,textarea{width:100%;padding:9px 11px;border:1px solid var(--rule-2);border-radius:var(--r-sm);
  background:var(--paper);color:var(--ink);font:inherit;font-size:14.5px}
textarea{resize:vertical;line-height:1.5}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--lime) 45%,transparent)}
input[type=checkbox]{width:auto;margin-right:7px;accent-color:var(--ink)}
input:disabled,select:disabled{background:var(--sunk);color:var(--ink-3)}
.hint{font-size:12.5px;color:var(--ink-2);margin:5px 0 0}
.field input:not([type=file]),.field select{max-width:520px}
.field textarea{max-width:720px}

/* ---------- buttons ---------- */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:10px 17px;border-radius:var(--r-sm);
  border:1px solid transparent;background:var(--ink);color:var(--paper);font:inherit;font-size:14.5px;font-weight:500;
  cursor:pointer;text-decoration:none;transition:background .12s ease,border-color .12s ease}
.btn:hover{background:#000}
@media (prefers-color-scheme:dark){.btn:hover{background:#fff}}
.btn.primary{background:var(--lime);color:var(--on-lime);border-color:color-mix(in srgb,var(--lime) 70%,#000)}
.btn.primary:hover{background:color-mix(in srgb,var(--lime) 86%,#000)}
.btn.secondary{background:var(--paper);color:var(--ink);border-color:var(--rule-2)}
.btn.secondary:hover{background:var(--sunk)}
.btn.block{display:flex;width:100%}
.btn:disabled,.btn[disabled]{opacity:.45;cursor:not-allowed}
.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:18px}

/* ---------- status ---------- */
.pill{display:inline-block;padding:2.5px 9px;border-radius:999px;font-size:12px;font-weight:500;
  background:var(--sunk);color:var(--ink-2);border:0;letter-spacing:0}
.pill.ok{background:var(--paid-bg);color:var(--paid)}
.pill.warn{background:var(--due-bg);color:var(--due)}
.pill.bad{background:var(--late-bg);color:var(--late)}
.notice{padding:11px 14px;border-radius:var(--r-sm);font-size:14px;margin:0 0 18px;border:1px solid var(--rule-2);background:var(--paper)}
.notice.ok{background:var(--paid-bg);color:var(--paid);border-color:transparent}
.notice.err{background:var(--late-bg);color:var(--late);border-color:transparent}
.ok{color:var(--paid)}.err{color:var(--late)}.warn{color:var(--due)}
.center{text-align:center}

/* ---------- sign-in ---------- */
.signin-mark{display:flex;justify-content:center;margin:0 0 26px}
.signin-mark svg{width:82px;height:70px;color:var(--ink)}
.legal{text-align:center;font-size:12.5px;color:var(--ink-2);margin:20px 0 0}
.scopes{list-style:none;padding:0;margin:14px 0 0;border-top:1px solid var(--rule)}
.scopes li{padding:10px 0 10px 28px;border-bottom:1px solid var(--rule);font-size:14px;position:relative}
.scopes li::before{content:"";position:absolute;left:3px;top:calc(50% - 1.5px);width:14px;height:3px;border-radius:2px;background:var(--lime);transform:rotate(-24deg)}
details.reviewer{margin-top:18px;border-top:1px solid var(--rule);padding-top:14px}
details.reviewer summary{cursor:pointer;font-size:13px;color:var(--ink-2)}
details.reviewer summary:hover{color:var(--ink)}
.sep{display:flex;align-items:center;gap:12px;color:var(--ink-3);font-size:12.5px;margin:16px 0}
.sep::before,.sep::after{content:"";flex:1;height:1px;background:var(--rule)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:var(--sunk);padding:.12em .38em;border-radius:4px}

/* ---------- prose (docs, policies) ---------- */
.prose h1{margin-bottom:18px}
.prose h2{font-size:19px;margin:34px 0 10px;padding-top:14px;border-top:1px solid var(--rule)}
.prose h3{margin:22px 0 6px}
.prose p,.prose li{font-size:15.5px;line-height:1.65}
.prose ul{padding-left:19px;margin:0 0 14px}
.prose li{margin:5px 0}
.prose pre{background:var(--paper);border:1px solid var(--rule);border-radius:var(--r-sm);padding:14px 16px;overflow-x:auto;font-size:13.5px}
.prose a{text-decoration-color:var(--lime);text-decoration-thickness:2px}

@media (max-width:640px){
  main{padding:26px 18px 64px}
  /* Two rows: identity and account above, sections below, so nav never truncates. */
  .topbar-in{padding:8px 18px 0;gap:14px;flex-wrap:wrap;min-height:0;align-items:center}
  .wordmark{order:1}
  .account{order:2}
  .topbar nav{order:3;flex:0 0 100%;gap:20px;margin-top:8px}
  .topbar nav a{padding-bottom:10px;align-items:flex-start}
  .account span{display:none}
  h1{font-size:22px}
  .figures > div{flex-basis:50%;padding-right:16px}
  .figures .v{font-size:23px}
}
</style></head><body>
${nav}${publicHeader}
<main class="${width}${width === 'prose' ? ' prose' : ''}">${body}</main>${publicFooter}</body></html>`;
}
