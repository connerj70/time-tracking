import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

/**
 * Bundles the MCP App into ONE self-contained HTML file: inline CSS + inline JS, no external script sources
 * (Claude's iframe sandbox blocks them). Served as the ui://tally/app.html resource and as the public invoice page.
 */
async function main() {
  const result = await build({
    entryPoints: ['app/src/main.tsx'],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    jsx: 'automatic',
    jsxImportSource: 'preact',
    write: false,
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const js = result.outputFiles[0].text;
  const css = readFileSync('app/src/styles.css', 'utf8');
  const html = readFileSync('app/src/index.html', 'utf8')
    .replace('/*__CSS__*/', () => css)
    .replace('/*__JS__*/', () => js.replace(/<\/script/gi, '<\\/script'));
  mkdirSync('app/dist', { recursive: true });
  writeFileSync('app/dist/app.html', html);
  console.log(`app/dist/app.html: ${(html.length / 1024).toFixed(1)} KB`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
