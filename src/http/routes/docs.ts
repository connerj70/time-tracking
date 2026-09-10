import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../../config.js';
import { esc, layout } from '../views/layout.js';

/** Marketing-site surfaces that live on the same origin: privacy, terms, docs, llms.txt, /.well-known/mcp. */
export const docsRoutes = Router();

function doc(name: string): string {
  const p = join(process.cwd(), 'docs', name);
  return existsSync(p) ? readFileSync(p, 'utf8') : `# ${name}\n\nMissing docs/${name}.`;
}

/** Tiny markdown → HTML: headings, paragraphs, lists, bold, links, code. Enough for policy pages. */
function md(src: string): string {
  const lines = src.replace(/\{\{PRODUCT\}\}/g, config.productName).replace(/\{\{SUPPORT_EMAIL\}\}/g, config.supportEmail).replace(/\{\{BASE_URL\}\}/g, config.baseUrl).split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let inCode = false;
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const openList = (kind: 'ul' | 'ol') => {
    if (list !== kind) {
      closeList();
      out.push(`<${kind}>`);
      list = kind;
    }
  };
  const cells = (row: string) =>
    row
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((c) => c.trim());
  const isDivider = (row: string) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(row) && row.includes('-');

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('```')) {
      closeList();
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(l));
      continue;
    }

    // Tables: a header row followed by a |---|---| divider, then body rows.
    if (/^\s*\|/.test(l) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      closeList();
      const head = cells(l);
      const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? ' class="c"' : /-+:$/.test(c) ? ' class="r"' : ''));
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(cells(lines[i++]));
      i--;
      out.push(
        `<div class="tablewrap"><table><thead><tr>${head.map((h, n) => `<th${align[n] ?? ''}>${inline(h)}</th>`).join('')}</tr></thead><tbody>` +
          body.map((r) => `<tr>${r.map((c, n) => `<td${align[n] ?? ''}>${inline(c)}</td>`).join('')}</tr>`).join('') +
          `</tbody></table></div>`,
      );
      continue;
    }

    if (/^\s*[-*] /.test(l)) {
      openList('ul');
      out.push(`<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`);
      continue;
    }
    if (/^\s*\d+\. /.test(l)) {
      openList('ol');
      out.push(`<li>${inline(l.replace(/^\s*\d+\. /, ''))}</li>`);
      continue;
    }
    closeList();

    if (/^\s*(---|\*\*\*|___)\s*$/.test(l)) {
      out.push('<hr>');
      continue;
    }
    const h = l.match(/^(#{1,4}) (.*)/);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  closeList();
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

for (const [route, file, title] of [
  ['/privacy', 'privacy.md', 'Privacy policy'],
  ['/terms', 'terms.md', 'Terms of service'],
  ['/docs', 'docs.md', 'Documentation'],
  ['/support', 'support.md', 'Support'],
  ['/', 'landing.md', 'Log hours and invoice clients from your AI chat'],
] as const) {
  docsRoutes.get(route, (_req, res) => res.send(layout(title, md(doc(file)), { width: 'prose', publicChrome: true })));
}

docsRoutes.get('/llms.txt', (_req, res) => {
  res.type('text/plain').send(doc('llms.txt').replace(/\{\{BASE_URL\}\}/g, config.baseUrl).replace(/\{\{MCP_URL\}\}/g, config.mcpUrl).replace(/\{\{PRODUCT\}\}/g, config.productName));
});

docsRoutes.get('/.well-known/mcp', (_req, res) => {
  res.json({
    name: config.productName,
    description: 'Tell it what you worked on and it logs the hours to the right client. Ask what is unbilled and it drafts the invoice.',
    servers: [{ url: config.mcpUrl, transport: 'streamable-http', auth: 'oauth2' }],
    documentation: `${config.baseUrl}/docs`,
    privacy_policy: `${config.baseUrl}/privacy`,
    terms_of_service: `${config.baseUrl}/terms`,
    support: config.supportEmail,
    support_url: `${config.baseUrl}/support`,
  });
});

// OpenAI plugin directory domain verification: must return ONLY the token, no JSON, no whitespace wrapper.
docsRoutes.get('/.well-known/openai-apps-challenge', (_req, res) => {
  if (!config.openaiAppsChallenge) return res.status(404).type('text/plain').send('Not configured');
  res.type('text/plain').send(config.openaiAppsChallenge);
});

docsRoutes.get('/healthz', (_req, res) => res.json({ ok: true }));
