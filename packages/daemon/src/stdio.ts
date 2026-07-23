import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createNoirServer, type ServerContext } from './server.js';

export async function startStdioServer(ctx: ServerContext): Promise<void> {
  const server = createNoirServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
