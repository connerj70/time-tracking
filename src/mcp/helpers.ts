import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ToolError } from '../lib/errors.js';
import { audit } from '../services/audit.js';
import type { Ctx } from '../services/context.js';

/** Keep tool results well under the ~150k-character host limit. */
const MAX_CHARS = 100_000;

export function ok(data: unknown, summary?: string): CallToolResult {
  let text = JSON.stringify(data, null, 1);
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS) + '\n…(truncated; narrow the date range or paginate with cursor)';
  }
  return {
    content: [{ type: 'text', text: summary ? `${summary}\n\n${text}` : text }],
    structuredContent: (data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data }) as Record<string, unknown>,
  };
}

export function fail(err: ToolError | Error): CallToolResult {
  const body = err instanceof ToolError ? err.toJSON() : { error: 'internal', message: err.message };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body, null, 1) }], structuredContent: body as Record<string, unknown> };
}

/** Wraps a tool handler with error mapping + audit logging. */
export function guarded<A>(ctx: Ctx, tool: string, fn: (args: A) => Promise<{ data: unknown; summary: string }>) {
  return async (args: A): Promise<CallToolResult> => {
    const t0 = Date.now();
    try {
      const { data, summary } = await fn(args);
      await audit({ workspaceId: ctx.workspaceId, userId: ctx.userId, tool, args, summary, ok: true, durationMs: Date.now() - t0 });
      return ok(data, summary);
    } catch (e) {
      const err = e as Error;
      const isTool = err instanceof ToolError;
      if (!isTool) console.error(`[${tool}]`, err);
      await audit({ workspaceId: ctx.workspaceId, userId: ctx.userId, tool, args, summary: `error: ${err.message}`, ok: false, durationMs: Date.now() - t0 });
      return fail(isTool ? err : new Error(err.message || 'Internal error'));
    }
  };
}

export const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
export const WRITE_IDEMPOTENT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
export const MODIFY = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } as const;
export const EXTERNAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
export const EXTERNAL_DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;
