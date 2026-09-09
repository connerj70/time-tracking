import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_RESOURCE_URI = 'ui://tally/app.html';

let cached: string | null = null;

/** Pre-built single-file bundle (no external scripts — hosts sandbox the iframe). */
export function loadAppHtml(): string | null {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const c of [join(here, '../../app/dist/app.html'), join(here, '../../../app/dist/app.html'), join(process.cwd(), 'app/dist/app.html')]) {
    if (existsSync(c)) {
      cached = readFileSync(c, 'utf8');
      return cached;
    }
  }
  return null;
}
