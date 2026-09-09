import { query } from '../db/index.js';

const REDACT = new Set(['to_email', 'billing_email', 'message']);

function redact(args: unknown): unknown {
  if (!args || typeof args !== 'object') return args;
  if (Array.isArray(args)) return args.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = REDACT.has(k) ? '[redacted]' : redact(v);
  }
  return out;
}

export async function audit(opts: {
  workspaceId: string | null;
  userId: string | null;
  tool: string;
  args: unknown;
  summary: string;
  ok: boolean;
  durationMs: number;
}): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (workspace_id, user_id, tool_name, args, result_summary, ok, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [opts.workspaceId, opts.userId, opts.tool, JSON.stringify(redact(opts.args) ?? {}), opts.summary.slice(0, 500), opts.ok, opts.durationMs],
    );
  } catch (e) {
    console.error('audit failed', e);
  }
}

export async function recentAudit(workspaceId: string, limit = 50) {
  return query(
    `SELECT id, user_id, tool_name, args, result_summary, ok, duration_ms, created_at
     FROM audit_log WHERE workspace_id = $1 ORDER BY id DESC LIMIT $2`,
    [workspaceId, limit],
  );
}
