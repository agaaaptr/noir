import { McpServer } from '@modelcontextprotocol/server';
import type { ProjectInfo } from '@noir-ai/core';
import { NOIR_VERSION } from '@noir-ai/core';
import type { Store } from '@noir-ai/store';
import { buildStatus, type Transport } from './status.js';

export interface ServerContext {
  project: ProjectInfo;
  transport: Transport;
  daemon: boolean;
  pid?: number;
  startedAt?: number;
  /**
   * Optional store handle. When present, the `store_status` tool is
   * registered. The daemon is the single writer; stdio/HTTP serve paths open
   * the store once per serve lifecycle and reuse the same handle.
   */
  store?: Store;
  /** Filesystem path to the store DB (reported by `store_status`). */
  dbPath?: string;
  /** True when the store was opened read-only (writable open failed). */
  storeDegraded?: boolean;
}

/** JSON returned by the `store_status` tool. */
export interface StoreStatus {
  ok: boolean;
  projectId: string;
  docCount: number;
  vecCount: number;
  dbPath: string | null;
  degraded: boolean;
}

/**
 * Build the `store_status` payload from a store handle.
 *
 * `docCount`/`vecCount` come straight from the live SQLite connection (the
 * daemon's single writer handle) via the Store's own `countDocs`/`countVecs`
 * methods, so they reflect indexed data immediately after `indexDoc`/
 * `upsertVec` — no caching, no stale reads, no `__db` coupling.
 */
export function buildStoreStatus(store: Store, dbPath?: string, degraded = false): StoreStatus {
  return {
    ok: true,
    projectId: store.projectId,
    docCount: store.countDocs(),
    vecCount: store.countVecs(),
    dbPath: dbPath ?? null,
    degraded,
  };
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

  // The store is optional: stdio/HTTP only inject it when openStoreForDaemon
  // succeeded. When present, surface counts/health via `store_status`.
  if (ctx.store) {
    const store = ctx.store;
    const dbPath = ctx.dbPath;
    const degraded = ctx.storeDegraded === true;
    server.registerTool(
      'store_status',
      {
        description:
          "Report the Noir embedded store's health: project id, document and vector counts, DB path, and degraded state.",
        inputSchema: {},
      },
      async () => {
        const payload = buildStoreStatus(store, dbPath, degraded);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        };
      },
    );
  }

  return server;
}
