import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool, schemaName } from './index.js';

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
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  // Guard against sharing a schema with another app: if a `users` table already exists here and isn't ours,
  // CREATE TABLE IF NOT EXISTS would silently skip it and every foreign key after it would fail.
  const foreign = await pool.query(
    `SELECT data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'id'`,
    [schemaName],
  );
  if (foreign.rowCount && foreign.rows[0].data_type !== 'uuid') {
    throw new Error(
      `Schema "${schemaName}" already contains a users table that is not Tallied's (id is ${foreign.rows[0].data_type}). ` +
        `Set DATABASE_SCHEMA to a dedicated schema name (e.g. "tallied") so the app does not collide with other tables in this database.`,
    );
  }
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${schemaName}, public`);
    await client.query(sql);
  } finally {
    client.release();
  }
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
