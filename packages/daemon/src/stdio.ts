import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createNoirServer, type ServerContext } from './server.js';
import { openStoreForDaemon } from './store-seam.js';
import { buildWorkflowEngine } from './workflow-seam.js';

export async function startStdioServer(ctx: ServerContext): Promise<void> {
  // The daemon is the single writer: open the store once for this stdio serve
  // lifecycle and hold it open for the life of the process (the transport
  // services requests after `connect` resolves, until stdin closes). If the
  // store can't be opened at all, omit it — `store_status` isn't
  // registered and host_status still works. Process exit reclaims the handle.
  const daemonStore = await openStoreForDaemon(ctx.project.id, ctx.project.root).catch(
    () => undefined,
  );
  // One engine per serve lifecycle, built from the same store handle.
  const engine = daemonStore
    ? buildWorkflowEngine(daemonStore.store, ctx.project.root, ctx.project.id)
    : undefined;
  const server = createNoirServer({
    ...ctx,
    ...(daemonStore
      ? {
          store: daemonStore.store,
          dbPath: daemonStore.dbPath,
          storeDegraded: daemonStore.degraded,
        }
      : {}),
    ...(engine ? { engine } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
