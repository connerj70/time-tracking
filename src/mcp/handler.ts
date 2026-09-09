import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadContext } from '../services/context.js';
import { buildServer } from './server.js';

/**
 * Stateless Streamable HTTP: one McpServer + transport per request.
 * No session map to lose on redeploys, works behind any load balancer.
 */
export async function handleMcp(req: Request, res: Response): Promise<void> {
  const auth = req.auth;
  const userId = auth?.extra?.userId as string | undefined;
  const workspaceId = auth?.extra?.workspaceId as string | undefined;
  if (!auth || !userId || !workspaceId) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  if (req.method === 'GET' || req.method === 'DELETE') {
    // Stateless mode: no server-initiated streams, no sessions to delete.
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
    return;
  }
  let ctx;
  try {
    ctx = await loadContext(userId, workspaceId);
  } catch (e) {
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32003, message: (e as Error).message }, id: null });
    return;
  }
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => undefined);
    server.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
