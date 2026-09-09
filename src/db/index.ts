import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;

// Return DATE columns as 'YYYY-MM-DD' strings, not JS Dates (which shift with the process timezone).
types.setTypeParser(1082, (v: string) => v);
// NUMERIC as number (we only use numeric(8,2) for hours).
types.setTypeParser(1700, (v: string) => Number(v));
// BIGINT as number (cents are far below 2^53).
types.setTypeParser(20, (v: string) => Number(v));

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  q: Queryable = pool,
): Promise<T[]> {
  const res = await q.query<T>(text, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(
  text: string,
  params: unknown[] = [],
  q: Queryable = pool,
): Promise<T | null> {
  const rows = await query<T>(text, params, q);
  return rows[0] ?? null;
}

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
