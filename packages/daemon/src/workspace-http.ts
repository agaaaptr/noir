// Workspace daemon HTTP server — the cross-repo multiplexer (spec §6).
//
// Unlike `startHttpServer` (one project, one store), a workspace daemon serves
// MANY projects over one Streamable HTTP endpoint. It opens:
//   • ONE workspace store (memory + feed — the shared context), and
//   • ZERO-or-more member project stores (context/workflow tools), opened lazily
//     and cached, keyed by the member projectId.
// Each request carries its identity in the URL query `?p=<projectId>`; a request
// whose `p` is not a current member is refused. The workspace daemon is STILL the
// single writer per DB: the workspace store is opened once here, and each member
// store is opened once per member (no second process holds a write handle).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { type ContextEngine, createEmbedFn, resolveEmbedderConfig } from '@noir-ai/context';
import {
  isWorkspaceMember,
  loadProjectInfo,
  type ProjectInfo,
  readWorkspaceRegistry,
  workspaceStoreDbPath,
} from '@noir-ai/core';
import { createMemoryEngine, type MemoryEngine } from '@noir-ai/memory';
import { openStore } from '@noir-ai/store';
import type { WorkflowEngine } from '@noir-ai/workflow';
import { buildContextEngine } from './context-seam.js';
import { wakeFeedWaiters } from './feed.js';
import { createNoirServer } from './server.js';
import { type DaemonStore, openStoreForDaemon } from './store-seam.js';
import { buildWorkflowEngine, resolveGateConfig } from './workflow-seam.js';
import {
  clearWorkspaceDaemonRecord,
  readWorkspaceDaemonRecord,
  writeWorkspaceDaemonRecord,
} from './workspace-record.js';

export interface StartWorkspaceHttpOptions {
  /** Workspace name (identity + store location). */
  name: string;
  /** Any project in the workspace (used to resolve the shared embedder + founder root). */
  project: ProjectInfo;
  port?: number;
  /** 0 ⇒ never idle-exit (the default for a long-lived shared daemon). */
  idleTimeoutSec: number;
}

export interface RunningWorkspaceDaemon {
  port: number;
  pid: number;
  startedAt: number;
  stop: () => Promise<void>;
}

interface MemberContext {
  project: ProjectInfo;
  store: DaemonStore;
  engine?: WorkflowEngine;
  context?: ContextEngine;
}

function parseRepo(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const p = new URL(url, 'http://127.0.0.1').searchParams.get('p');
    return p;
  } catch {
    return null;
  }
}

async function openWorkspaceStore(name: string, root: string): Promise<DaemonStore | undefined> {
  const dbPath = workspaceStoreDbPath(name);
  const projectId = `ws-${name}`;
  try {
    const store = await openStore({ projectId, root, dbPath });
    return { store, dbPath, degraded: false };
  } catch {
    try {
      const store = await openStore({ projectId, root, dbPath, readonly: true });
      return { store, dbPath, degraded: true };
    } catch {
      return undefined;
    }
  }
}

async function buildMember(root: string): Promise<MemberContext | null> {
  let project: ProjectInfo;
  try {
    project = loadProjectInfo(root);
  } catch {
    return null;
  }
  let store: DaemonStore;
  try {
    store = await openStoreForDaemon(project.id, root);
  } catch {
    return null;
  }
  // Everything after the store open must not strand the handle. A member config
  // the context layer rejects (e.g. `context.embedder.dim !== 384` for a remote
  // embedder — the core schema constrains only to a positive int) throws HERE,
  // after the store is open: without this guard it would leak an open SQLite
  // connection for the daemon's life (the member never reaches memberCache, so
  // shutdown never closes it) AND reject the request handler, which has no
  // catch — hanging the client with no 500 envelope. Close and return null so
  // getMember yields null and the handler's 500 path answers.
  try {
    const engine = buildWorkflowEngine(
      store.store,
      project.root,
      project.id,
      resolveGateConfig(project.config),
    );
    const embedderCfg = resolveEmbedderConfig(project.config.context);
    const context = buildContextEngine(
      store.store,
      project.root,
      project.id,
      embedderCfg,
      store.degraded,
    );
    return { project, store, engine, context };
  } catch {
    await store.store.close().catch(() => undefined);
    return null;
  }
}

export async function startWorkspaceHttpServer(
  opts: StartWorkspaceHttpOptions,
): Promise<RunningWorkspaceDaemon> {
  const { name } = opts;
  const startedAt = Date.now();
  const pid = process.pid;
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();

  // Activity tracking for idle-exit (mirrors http.ts). `idleTimeoutSec: 0` disables it.
  let lastActivity = Date.now();
  const touch = () => {
    lastActivity = Date.now();
  };
  let idleTimer: NodeJS.Timeout | undefined;
  if (opts.idleTimeoutSec > 0) {
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > opts.idleTimeoutSec * 1000) void shutdown();
    }, 10_000);
  }

  const wsStore = await openWorkspaceStore(name, opts.project.root);
  const embedderCfg = resolveEmbedderConfig(opts.project.config.context);
  const embed = createEmbedFn(embedderCfg).embed;
  // Build the workspace memory engine even when the store opened degraded
  // (read-only fallback): reads (recall/search) keep working, writes fence with a
  // clear "store is read-only" envelope via the engine's own degraded flag — the
  // same degraded story as the project daemon. Only a totally unopenable store
  // (wsStore === undefined) omits memory tools entirely.
  const wsMemory: MemoryEngine | undefined = wsStore
    ? createMemoryEngine({
        store: wsStore.store,
        root: opts.project.root,
        projectId: `ws-${name}`,
        embed,
        storeDegraded: wsStore.degraded,
        softForget: true,
      })
    : undefined;

  const memberCache = new Map<string, MemberContext>();
  // A cold-cache miss is async (store open). Without an in-flight slot, two
  // requests for the same member that miss the cache in the same tick each
  // reach a second `openStoreForDaemon` — a second write handle to one DB,
  // the first of which is then silently dropped (leak) and never closed.
  const memberInFlight = new Map<string, Promise<MemberContext | null>>();

  async function getMember(repo: string): Promise<MemberContext | null> {
    const cached = memberCache.get(repo);
    if (cached) return cached;
    const inFlight = memberInFlight.get(repo);
    if (inFlight) return inFlight;
    const registry = readWorkspaceRegistry(name);
    const member = registry?.members.find((m) => m.projectId === repo);
    if (!member) return null;
    const pending = (async () => {
      const built = await buildMember(member.root);
      // The registry pairs a projectId with the root it joined from. If the root
      // no longer resolves to that same projectId (re-`noir init`, moved dir),
      // the member is stale — refuse rather than serve another project's store
      // under this authenticated identity.
      if (built === null) return null;
      if (built.project.id !== repo) {
        await built.store.store.close().catch(() => undefined);
        return null;
      }
      memberCache.set(repo, built);
      return built;
    })();
    memberInFlight.set(repo, pending);
    try {
      return await pending;
    } finally {
      memberInFlight.delete(repo);
    }
  }

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;
    touch();
    if (req.method === 'GET' && (req.url === '/health' || req.url?.startsWith('/health?'))) {
      const registry = readWorkspaceRegistry(name);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          pid,
          workspace: name,
          memberCount: registry?.members.length ?? 0,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        }),
      );
      return;
    }
    if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
      const repo = parseRepo(req.url);
      const registry = readWorkspaceRegistry(name);
      if (!repo || !registry || !isWorkspaceMember(registry, repo)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: false,
            error: `${repo ?? '(missing ?p=)'} is not a member of workspace ${JSON.stringify(name)}`,
          }),
        );
        return;
      }
      const member = await getMember(repo);
      if (!member) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ ok: false, error: `could not open the store for member ${repo}` }),
        );
        return;
      }
      // Prune members that left the registry (fresh read above). Close their
      // open project-store handles before dropping them — a long-lived daemon
      // must not leak a departed member's SQLite connection + WAL mapping.
      for (const key of memberCache.keys()) {
        if (!isWorkspaceMember(registry, key)) {
          const departed = memberCache.get(key);
          memberCache.delete(key);
          if (departed) void departed.store.store.close().catch(() => {});
        }
      }
      const server = createNoirServer({
        project: member.project,
        transport: 'streamable-http',
        daemon: true,
        pid,
        startedAt,
        store: member.store.store,
        dbPath: member.store.dbPath,
        storeDegraded: member.store.degraded,
        ...(member.engine ? { engine: member.engine } : {}),
        ...(member.context ? { context: member.context } : {}),
        ...(wsMemory && wsStore
          ? {
              memory: wsMemory,
              // The memory engine writes to the WORKSPACE store, whose degraded
              // flag differs from the member's project store — thread it so the
              // memory tools fence on the right handle (server.ts memoryStoreDegraded).
              memoryStoreDegraded: wsStore.degraded,
              workspace: {
                name,
                repo,
                feedStore: wsStore.store,
                wakeFeed: () => wakeFeedWaiters(wsStore.store),
              },
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

  writeWorkspaceDaemonRecord(name, { pid, port, startedAt, workspace: name });

  async function shutdown(): Promise<void> {
    if (idleTimer) {
      clearInterval(idleTimer);
      idleTimer = undefined;
    }
    await new Promise<void>((r) => httpServer.close(() => r()));
    await wsStore?.store.close().catch(() => undefined);
    for (const m of memberCache.values()) {
      await m.store.store.close().catch(() => undefined);
    }
    const rec = readWorkspaceDaemonRecord(name);
    if (rec && rec.pid === pid) clearWorkspaceDaemonRecord(name);
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => void shutdown().then(() => process.exit(0)));
  }

  return { port, pid, startedAt, stop: shutdown };
}
