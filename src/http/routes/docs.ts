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
  let inList = false;
  let inCode = false;
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  for (const l of lines) {
    if (l.startsWith('```')) {
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(esc(l));
      continue;
    }
    if (/^\s*[-*] /.test(l)) {
      if (!inList) out.push('<ul>');
      inList = true;
      out.push(`<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    const h = l.match(/^(#{1,3}) (.*)/);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (l.trim()) out.push(`<p>${inline(l)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('\n');
}

for (const [route, file, title] of [
  ['/privacy', 'privacy.md', 'Privacy policy'],
  ['/terms', 'terms.md', 'Terms of service'],
  ['/docs', 'docs.md', 'Documentation'],
  ['/support', 'support.md', 'Support'],
  ['/', 'landing.md', 'Log hours and invoice clients from your AI chat'],
] as const) {
  docsRoutes.get(route, (_req, res) => res.send(layout(title, md(doc(file)), { wide: true })));
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
