import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createNoirServer, type ServerContext } from './server.js';
import { openStoreForDaemon } from './store-seam.js';

export async function startStdioServer(ctx: ServerContext): Promise<void> {
  // The daemon is the single writer: open the store once for this stdio serve
  // lifecycle and hold it open for the life of the process (the transport
  // services requests after `connect` resolves, until stdin closes). If the
  // store can't be opened at all, omit it — `noir.store_status` isn't
  // registered and host_status still works. Process exit reclaims the handle.
  const daemonStore = await openStoreForDaemon(ctx.project.id, ctx.project.root).catch(
    () => undefined,
  );
  const server = createNoirServer({
    ...ctx,
    ...(daemonStore
      ? {
          store: daemonStore.store,
          dbPath: daemonStore.dbPath,
          storeDegraded: daemonStore.degraded,
        }
      : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
