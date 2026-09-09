import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from './index.js';

export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Works from both src/ (tsx) and dist/ (compiled) because schema.sql is copied alongside.
  const candidates = [join(here, 'schema.sql'), join(here, '../../src/db/schema.sql')];
  let sql: string | undefined;
  for (const c of candidates) {
    try {
      sql = readFileSync(c, 'utf8');
      break;
    } catch {
      /* try next */
    }
  }
  if (!sql) throw new Error('schema.sql not found');
  await pool.query('CREATE EXTENSION IF NOT EXISTS citext');
  await pool.query(sql);
}

if (process.argv[1] && process.argv[1].endsWith('migrate.ts')) {
  migrate()
    .then(() => {
      console.log('migrated');
      return pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
