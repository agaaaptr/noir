import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { createEmbedFn, resolveEmbedderConfig } from '@noir-ai/context';
import type { ProjectInfo } from '@noir-ai/core';
import { resolveMemoryConfig } from '@noir-ai/memory';
import { resolveModelConfig } from '@noir-ai/model';
import { buildContextEngine } from './context-seam.js';
import { clearDaemonRecord, type DaemonRecord, writeDaemonRecord } from './lifecycle.js';
import { buildMemoryEngine, resolveConsolidationCapability } from './memory-seam.js';
import { createNoirServer } from './server.js';
import { openStoreForDaemon } from './store-seam.js';
import { buildWorkflowEngine } from './workflow-seam.js';

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
  // One engine per lifecycle, built from the shared store handle — reused
  // across every request, exactly like the store.
  const engine = daemonStore
    ? buildWorkflowEngine(daemonStore.store, opts.project.root, opts.project.id)
    : undefined;
  // One context engine per lifecycle, built from the same shared store handle +
  // the resolved embedder config — reused across every request, exactly like the
  // store + engine. The daemon owns ONE embedder: the config is resolved once
  // (`resolveEmbedderConfig`) and the `EmbedFn` materialized once
  // (`createEmbedFn`); the same `EmbedFn` is handed to the memory engine below.
  // The context engine still takes the `EmbedderConfig` (its own contract) and
  // resolves its embedder internally from the SAME config — for `kind:'local'`
  // the ONNX pipeline is module-cached, so the two resolutions share one loaded
  // model. The store's `degraded` flag threads through so `context_status`/
  // `memory_save` are honest under a read-only handle and writes short-circuit.
  const embedderCfg = resolveEmbedderConfig(opts.project.config.context);
  const embed = createEmbedFn(embedderCfg).embed;
  const context = daemonStore
    ? buildContextEngine(
        daemonStore.store,
        opts.project.root,
        opts.project.id,
        embedderCfg,
        daemonStore.degraded,
      )
    : undefined;
  // One memory engine per lifecycle, built from the same shared store handle +
  // the SAME `EmbedFn` already materialized for S6 (the daemon owns one
  // embedder; memory takes `{store, embed, ...}` — no embedder duplication).
  // Consolidation is OPT-IN + provider-explicit (D5/D6/DS-6 — NEVER a silent
  // paid call, the Agent-Memory anti-pattern §9). The master switch is the
  // user's `memory.consolidation.enabled`; only when it is true does the
  // model-derived provider+model even get considered. `resolveMemoryConfig` is
  // the pure core→memory bridge; resolved once and passed to buildMemoryEngine
  // so the engine's config reflects the user's `memory:` consent exactly. The
  // `memory_consolidate` tool is registered only when the gate resolves.
  const modelCfg = resolveModelConfig(opts.project.config.model);
  const resolvedMemory = resolveMemoryConfig(opts.project.config.memory);
  const memoryConsolidation = resolveConsolidationCapability(resolvedMemory, modelCfg) !== null;
  const memory = daemonStore
    ? buildMemoryEngine(
        daemonStore.store,
        opts.project.root,
        opts.project.id,
        embed,
        modelCfg,
        daemonStore.degraded,
        resolvedMemory,
      )
    : undefined;

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
        ...(engine ? { engine } : {}),
        ...(context ? { context } : {}),
        ...(memory ? { memory, memoryConsolidation } : {}),
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
