import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { resolveEmbedderConfig } from '@noir-ai/context';
import { buildContextEngine } from './context-seam.js';
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
  // One context engine per serve lifecycle, built from the same store handle +
  // the resolved embedder config (mirrors the workflow engine). The embedder
  // config comes from the project's parsed config (`NoirConfig.context`), which
  // defaults to local in-process embeddings when the block is absent (AC-7);
  // `resolveEmbedderConfig` is the core→context bridge (no cycle). The store's
  // `degraded` flag threads through so `context_status` is honest under a
  // read-only (daemon-down) handle and `context_index` short-circuits clearly.
  const context = daemonStore
    ? buildContextEngine(
        daemonStore.store,
        ctx.project.root,
        ctx.project.id,
        resolveEmbedderConfig(ctx.project.config.context),
        daemonStore.degraded,
      )
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
    ...(context ? { context } : {}),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
