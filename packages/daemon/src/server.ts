import { McpServer } from '@modelcontextprotocol/server';
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

  return server;
}
