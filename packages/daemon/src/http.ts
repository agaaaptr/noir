import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import type { ProjectInfo } from '@noir-ai/core';
import { clearDaemonRecord, type DaemonRecord, writeDaemonRecord } from './lifecycle.js';
import { createNoirServer } from './server.js';
import { openStoreForDaemon } from './store-seam.js';

export interface StartHttpOptions {
  project: ProjectInfo;
  port?: number;
  idleTimeoutSec: number;
}

export interface RunningDaemon {
  port: number;
  pid: number;
  startedAt: number;
  stop: () => Promise<void>;
}

export async function startHttpServer(opts: StartHttpOptions): Promise<RunningDaemon> {
  const startedAt = Date.now();
  const pid = process.pid;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  let lastActivity = Date.now();
  let idleTimer: NodeJS.Timeout | undefined = setInterval(() => {
    if (Date.now() - lastActivity > opts.idleTimeoutSec * 1000) void shutdown();
  }, 10_000);

  // The daemon is the single writer: open the store ONCE per serve lifecycle
  // and reuse the same handle across every HTTP request. The stateless
  // Streamable HTTP model builds a fresh McpServer per request, but they all
  // share this one store handle — no per-request re-open, no second writer.
  const daemonStore = await openStoreForDaemon(opts.project.id, opts.project.root).catch(
    () => undefined,
  );

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    lastActivity = Date.now();
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ ok: true, pid, uptimeSec: Math.floor((Date.now() - startedAt) / 1000) }),
      );
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    if (req.url === '/mcp') {
      const server = createNoirServer({
        project: opts.project,
        transport: 'streamable-http',
        daemon: true,
        pid,
        startedAt,
        ...(daemonStore
          ? {
              store: daemonStore.store,
              dbPath: daemonStore.dbPath,
              storeDegraded: daemonStore.degraded,
            }
          : {}),
      });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404).end('not found');
  });

  const port: number = await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = httpServer.address();
      httpServer.removeListener('error', reject);
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });

  const rec: DaemonRecord = { pid, port, startedAt };
  writeDaemonRecord(rec);

  async function shutdown(): Promise<void> {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
    await new Promise<void>((r) => httpServer.close(() => r()));
    await daemonStore?.store.close().catch(() => undefined);
    clearDaemonRecord();
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void shutdown().then(() => process.exit(0)));
  }

  return { port, pid, startedAt, stop: shutdown };
}
