import { McpServer } from '@modelcontextprotocol/server';
import type { ProjectInfo } from '@noir-ai/core';
import { NOIR_VERSION } from '@noir-ai/core';
import { buildStatus, type Transport } from './status.js';

export interface ServerContext {
  project: ProjectInfo;
  transport: Transport;
  daemon: boolean;
  pid?: number;
  startedAt?: number;
}

export function createNoirServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: 'noir', version: NOIR_VERSION });
  server.registerTool(
    'host_status',
    {
      description:
        "Report Noir's runtime status: project id/name, host CLI, transport, and daemon state.",
      // Empty ZodRawShape => no input parameters (MCP SDK v2 registerTool overload 2).
      inputSchema: {},
    },
    async () => {
      const status = buildStatus(ctx.project, ctx);
      return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] };
    },
  );
  return server;
}
