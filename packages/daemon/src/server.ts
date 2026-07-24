import { McpServer } from '@modelcontextprotocol/server';
import type { ContextEngine } from '@noir-ai/context';
import type { ProjectInfo } from '@noir-ai/core';
import { NOIR_VERSION } from '@noir-ai/core';
import type { Store } from '@noir-ai/store';
import type { GateResult, Mode, Phase, WorkflowEngine, WorkflowState } from '@noir-ai/workflow';
import { PHASES } from '@noir-ai/workflow';
import { z } from 'zod';
import { buildStatus, type Transport } from './status.js';

/** Gate phases in lifecycle order (spec → plan → verify), used by {@link nextGateAfter}. */
const GATE_PHASES: readonly Phase[] = ['spec', 'plan', 'verify'] as const;

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
  /**
   * Optional workflow engine. When present, the `workflow_status` and
   * `checkpoint` tools are registered. Built once per serve lifecycle from the
   * same store handle (see {@link buildWorkflowEngine}) and reused across HTTP
   * requests, mirroring the store.
   */
  engine?: WorkflowEngine;
  /**
   * Optional context engine. When present, the `context_search`,
   * `context_index`, and `context_status` tools are registered. Built once per
   * serve lifecycle from the same store handle (see `buildContextEngine` in
   * `./context-seam.js`) and reused across HTTP requests, mirroring the store
   * + engine. The engine — through its indexer — is the only thing that writes
   * context rows, so the daemon's single-writer discipline is preserved.
   */
  context?: ContextEngine;
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

/** JSON returned by the `workflow_status` / `checkpoint` tools. */
export interface WorkflowStatus {
  ok: boolean;
  taskId: string;
  phase: Phase;
  state: WorkflowState;
  /** Next gate-phase ahead of the current phase (null past verify, or blocked). */
  nextGate: Phase | null;
  mode: Mode;
  /** In-process view of the observable gate audit (Noir §9.1). */
  history: GateResult[];
  updatedAt: number;
  /** Mirrors `store_status`: true when the store is a read-only fallback. */
  degraded: boolean;
}

/**
 * The next gate-phase (spec / plan / verify) strictly ahead of `phase` in the
 * lifecycle. Once a gate has fired it lives in `history`; this points at the one
 * still to come. Returns `null` past `verify` (nothing left to gate).
 */
export function nextGateAfter(phase: Phase): Phase | null {
  const cur = PHASES.indexOf(phase);
  for (const p of GATE_PHASES) {
    if (PHASES.indexOf(p) > cur) return p;
  }
  return null;
}

/**
 * Build the `workflow_status` payload from an engine + taskId.
 *
 * Reads the persisted `TaskState` straight from the store KV (a live read off
 * the daemon's single handle — no cache). `nextGate` is `null` for `blocked` /
 * `abandoned` tasks (no forward gate applies). Returns `null` for an unknown
 * task so the tool handler can emit a clear not-found envelope.
 */
export function buildWorkflowStatus(
  engine: WorkflowEngine,
  taskId: string,
  degraded = false,
): WorkflowStatus | null {
  const task = engine.status(taskId);
  if (!task) return null;
  const stopped = task.state === 'blocked' || task.state === 'abandoned';
  return {
    ok: true,
    taskId: task.taskId,
    phase: task.phase,
    state: task.state,
    nextGate: stopped ? null : nextGateAfter(task.phase),
    mode: task.mode,
    history: task.history,
    updatedAt: task.updatedAt,
    degraded,
  };
}

/** Wrap a JSON-serializable value as a single-text-block MCP tool result. */
function textResult(obj: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] };
}

/** Coerce a thrown value into a readable message for error envelopes. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  // The workflow engine is optional: stdio/HTTP inject it alongside the store
  // (same lifecycle). When present, surface the SDD task state via
  // `workflow_status` and flush / read checkpoints via `checkpoint`.
  // `host_status` / `store_status` above are unchanged.
  if (ctx.engine) {
    const engine = ctx.engine;
    const degraded = ctx.storeDegraded === true;

    server.registerTool(
      'workflow_status',
      {
        description:
          "Report the active Noir SDD task's phase, state, the next gate ahead, mode, and observable gate history. Omit taskId to read the active task.",
        inputSchema: {
          taskId: z
            .string()
            .optional()
            .describe('Task id; defaults to the active task (workflow:active).'),
        },
      },
      async ({ taskId }) => {
        const id = taskId ?? engine.activeTaskId();
        if (!id) return textResult({ ok: false, error: 'no active task' });
        const payload = buildWorkflowStatus(engine, id, degraded);
        if (!payload) return textResult({ ok: false, taskId: id, error: 'unknown task' });
        return textResult(payload);
      },
    );

    server.registerTool(
      'checkpoint',
      {
        description:
          'Checkpoint a Noir SDD task: `save` flushes the in-flight state to the store KV; `restore` reads it back. Omit taskId to target the active task.',
        inputSchema: {
          action: z
            .enum(['save', 'restore'])
            .describe("'save' flushes state; 'restore' returns the in-flight task state."),
          taskId: z
            .string()
            .optional()
            .describe('Task id; defaults to the active task (workflow:active).'),
        },
      },
      async ({ action, taskId }) => {
        const id = taskId ?? engine.activeTaskId();
        if (!id) return textResult({ ok: false, error: 'no active task' });
        if (action === 'save') {
          try {
            await engine.checkpoint(id);
          } catch (err) {
            // Degraded (read-only store): surface clearly, never crash.
            return textResult({
              ok: false,
              action: 'save',
              taskId: id,
              degraded: true,
              error: errorMessage(err),
            });
          }
        }
        const payload = buildWorkflowStatus(engine, id, degraded);
        if (!payload) return textResult({ ok: false, taskId: id, error: 'unknown task' });
        return textResult({ action, ...payload });
      },
    );
  }

  // The context engine is optional: stdio/HTTP inject it alongside the store +
  // workflow engine (same lifecycle, same single store handle). When present,
  // expose Noir's hybrid retrieval (BM25 ∪ cosine-kNN fused by RRF) via three
  // tools — `context_search`, `context_index`, `context_status` (spec F9/F10/F11).
  // `host_status` / `store_status` / `workflow_status` above are unchanged.
  if (ctx.context) {
    const context = ctx.context;
    const storeDegraded = ctx.storeDegraded === true;

    server.registerTool(
      'context_search',
      {
        description:
          'Hybrid search over the Noir context index: BM25 ∪ cosine-kNN fused by Reciprocal Rank Fusion (k=60), packed into a token budget with window-extracted snippets (never truncated). Returns ranked hits with path, snippet, and score.',
        inputSchema: {
          query: z
            .string()
            .describe('Natural-language or identifier query (e.g. "ContextEngine").'),
          limit: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Max hits requested from each leg before fusion (default 10).'),
          budgetTokens: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Token budget for the packed result set (default 4096).'),
          // Singular `source` (not the spec's plural `sources`): both store
          // primitives (SearchFtOpts.source / VecOpts.source) and the engine's
          // SearchOptions.source take a single string, so a plural array is not
          // honor-able here. Spec F9 source-filtering surfaces as one bucket.
          source: z
            .string()
            .optional()
            .describe('Restrict both legs to a single source bucket (e.g. "docs", "codebase").'),
        },
      },
      async ({ query, limit, budgetTokens, source }) => {
        try {
          const result = await context.search(query, { limit, budgetTokens, source });
          return textResult({ ok: true, ...result });
        } catch (err) {
          // Never crash the daemon: surface a degraded envelope (spec F12).
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    // No `watch` param is exposed here on purpose: watch mode (spec F5, daemon
    // --watch via chokidar) is deferred and the engine's IndexPathOptions has
    // no watch field. Accepting it now would silently no-op; if exposed later,
    // return an explicit `ok:false, error:'watch not implemented (F5)'` rather
    // than ignoring the flag. (spec F10 lists watch, but it is not wired yet.)
    server.registerTool(
      'context_index',
      {
        description:
          'Incrementally index files/directories into the Noir context store (SHA-256 content-hash; unchanged files are skipped). Indexes docs + 384-dim vectors into the existing tables (no schema migration). Omit paths to index the project root.',
        inputSchema: {
          paths: z
            .array(z.string())
            .optional()
            .describe('Files/directories to index (repo-relative or absolute); defaults to ["."].'),
        },
      },
      async ({ paths }) => {
        // Read-only (daemon-down) store: indexing is a write, so fence it off
        // up front with a clear envelope rather than letting the first write
        // throw partway through (spec F12 / AC-5).
        if (storeDegraded) {
          return textResult({
            ok: false,
            degraded: true,
            error: 'store is read-only (daemon down) — context_index is unavailable',
          });
        }
        try {
          const result = await context.indexPaths(paths && paths.length > 0 ? paths : ['.']);
          return textResult({ ok: true, ...result });
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    server.registerTool(
      'context_status',
      {
        description:
          "Report the Noir context index's health: project id, document + vector counts, indexed file count, the active embedder (kind/model/dim), and degraded state.",
        inputSchema: {},
      },
      async () => {
        try {
          // Live read off the single writer handle — no cache (mirrors
          // buildStoreStatus). docCount/vecCount/indexedFiles reflect indexed
          // data immediately after context_index.
          return textResult(context.status());
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );
  }

  return server;
}
