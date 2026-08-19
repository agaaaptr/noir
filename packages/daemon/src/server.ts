import { McpServer } from '@modelcontextprotocol/server';
import type { ContextEngine } from '@noir-ai/context';
import type { ProjectInfo } from '@noir-ai/core';
import { NOIR_VERSION } from '@noir-ai/core';
import type { MemoryEngine } from '@noir-ai/memory';
import type { Store } from '@noir-ai/store';
import type {
  AdvanceOpts,
  GateResult,
  Mode,
  Phase,
  TaskClass,
  TaskState,
  WorkflowEngine,
  WorkflowState,
} from '@noir-ai/workflow';
import { PHASES, resumeTask, runQuick, TASK_CLASSES, VerifyGateError } from '@noir-ai/workflow';
import { z } from 'zod';
import {
  buildRequests,
  type ClickUpOp,
  type ExecResult,
  executeOp,
  normalizeOp,
  previewRows,
} from './clickup-write.js';
import {
  findBinding,
  type IntegrationAuditEntry,
  type IntegrationService,
  resolveToken,
  writeIntegrationAudit,
} from './integration-seam.js';
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
  /**
   * Optional memory engine. When present, the `memory_save`, `memory_recall`,
   * `memory_search`, `memory_sessions`, and `memory_forget` tools are
   * registered. Built once per serve lifecycle from the same store handle + the
   * SAME `EmbedFn` already resolved for S6 (see `buildMemoryEngine` in
   * `./memory-seam.js`) and reused across HTTP requests, mirroring the store +
   * engine + context. The engine is the only thing that writes `source:memory`
   * rows through the injected handle, so the daemon's single-writer discipline
   * is preserved (blueprint D6: in-process, no sidecar, canonical `ProjectId`).
   */
  memory?: MemoryEngine;
  /**
   * Whether the {@link memory} engine is consolidation-capable — i.e. the user
   * opted in (`memory.consolidation.enabled === true`) AND a usable provider+model
   * resolved (see `resolveConsolidationCapability` in `./memory-seam.js`, the AND
   * of the master switch + the provider derivation). Only when this is true is the
   * `memory_consolidate` tool registered: consolidation is OPT-IN +
   * provider-explicit (blueprint D5/D6 / §9), NEVER a silent paid call — a
   * `model:` block set for summarize/title/draft does NOT flip this when the user
   * left `memory.consolidation.enabled` false. The engine's `consolidate`
   * self-refuses (`no-provider`/`model-unavailable`) when this flag is false, so
   * the flag + the engine agree by construction.
   */
  memoryConsolidation?: boolean;
  /**
   * Optional integration service. Built once per serve
   * lifecycle from the discovered `integration.json` declarations
   * (@noir-ai/skills `discoverIntegrations`) merged with the user's
   * `integrations:<name>` config block. When present, the `integrations_auth`
   * tool is ALWAYS registered (resolves a token by env var at call time — kills
   * the non-interactive-shell gotcha), and `noir_clickup_write` is registered
   * when a `noir-clickup` declaration with `runtime:'gated-write-proxy'` is
   * discovered. Both tools degrade gracefully (`no-token`/`no-config`) when the
   * binding/env is absent — never a crash. Token values NEVER enter stderr or
   * audit bodies (only the tool RESULT to the trusted host + the outbound
   * `Authorization` header).
   */
  integrations?: IntegrationService;
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
  /** Task class (drives the soft PRD gate); absent on legacy tasks. */
  taskClass?: TaskClass;
  /** Block reason captured by `setBlocked` (absent unless the task is blocked). */
  blockReason?: string;
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
    ...(task.taskClass === undefined ? {} : { taskClass: task.taskClass }),
    ...(task.blockReason === undefined ? {} : { blockReason: task.blockReason }),
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
          "Report the active Noir spec-driven task's phase, state, the next gate ahead, mode, and observable gate history. Omit taskId to read the active task.",
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
          'Checkpoint a Noir spec-driven task: `save` flushes the in-flight state to the store KV; `restore` reads it back. Omit taskId to target the active task.',
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

    // `workflow_start` / `workflow_advance` expose the engine's writes that the
    // S9 `task new` / `task advance` CLI commands drive (previously those were
    // honest "not exposed" stubs). Both are writes, so a read-only (daemon-down)
    // store fences them off up front with a clear envelope (mirrors
    // `context_index` / `memory_save`). The result reuses buildWorkflowStatus so
    // the wire shape matches `workflow_status` (taskId/phase/state/nextGate/...).
    server.registerTool(
      'workflow_start',
      {
        description:
          'Start a Noir spec-driven task at draft/intake and make it the active task (workflow:active). Re-starting an existing taskId overwrites it (the KV is the source of truth, not a journal). Defaults to full mode. taskClass (feature/epic/…) drives the soft PRD gate at the spec gate; quick mode writes a stub spec + fast-forwards to executing.',
        inputSchema: {
          taskId: z.string().min(1).describe('Stable task handle (re-starting overwrites).'),
          slug: z.string().min(1).describe('Human-readable slug, e.g. "add-login".'),
          mode: z.enum(['full', 'quick']).optional().describe("Mode: 'full' (default) or 'quick'."),
          taskClass: z
            .enum(TASK_CLASSES)
            .optional()
            .describe(
              'Task class (feature/epic/enhancement/bugfix/spike/quick-task/refactor). Drives the soft PRD gate (prd.mandatoryFor).',
            ),
        },
      },
      async ({ taskId, slug, mode, taskClass }) => {
        if (degraded) {
          return textResult({
            ok: false,
            degraded: true,
            error: 'store is read-only (daemon down) — workflow_start is unavailable',
          });
        }
        try {
          // Fall back to the project's configured mode (config.mode) before the
          // hard default, so `mode: quick` in .noir/config.yml actually sets the
          // default the docs describe (getting-started "full vs quick").
          const resolvedMode: Mode = mode ?? ctx.project.config.mode ?? 'full';
          // taskClass plumbs into startTask so the soft PRD gate (prdRecommendation)
          // can fire for mandatoryFor classes (c4-surface-wiring S1).
          await engine.startTask(taskId, slug, resolvedMode, taskClass as TaskClass | undefined);
          // Quick mode wiring (c4-surface-wiring S3): runQuick writes the stub spec
          // + records the spec/plan gates as skipped + fast-forwards to executing.
          // Previously --mode quick started the task without the fast-forward (inert).
          if (resolvedMode === 'quick') {
            await runQuick(engine, taskId);
          }
          const payload = buildWorkflowStatus(engine, taskId, degraded);
          if (!payload) return textResult({ ok: false, taskId, error: 'unknown task' });
          return textResult(payload);
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    server.registerTool(
      'workflow_advance',
      {
        description:
          'Advance a Noir spec-driven task to its next phase, or jump with `to`. At a gate-landing state (entering specified/planned/done) a gate is recorded — approved by default, forced (with reason) via `force`, or skipped via `skip`. Omit taskId to target the active task. `force` and `skip` are mutually exclusive. For an evidence-backed verify gate, supply `evidence` (ranAt + checks[]).',
        inputSchema: {
          taskId: z
            .string()
            .optional()
            .describe('Task id; defaults to the active task (workflow:active).'),
          force: z
            .object({ reason: z.string().min(1) })
            .optional()
            .describe(
              'Pass the next gate without satisfying its criteria; requires a non-empty reason. Mutually exclusive with skip.',
            ),
          to: z
            .enum(['intake', 'clarify', 'spec', 'plan', 'execute', 'verify', 'document'])
            .optional()
            .describe('Jump directly to a phase, bypassing the FSM.'),
          skip: z
            .boolean()
            .optional()
            .describe(
              "Quick-mode: record the landing gate as 'skipped' instead of 'approved'. Mutually exclusive with force.",
            ),
          evidence: z
            .object({
              ranAt: z.number(),
              summary: z.string(),
              checks: z.array(
                z.object({
                  name: z.string(),
                  exitCode: z.number(),
                  outputDigest: z.string(),
                  command: z.string(),
                  tier: z.enum(['hard', 'soft']).optional(),
                }),
              ),
            })
            .optional()
            .describe(
              'c4-verify-gate-recovery: validation evidence for the verify gate (ranAt + checks[]). Required when the verify gate is configured for the task class.',
            ),
        },
      },
      async ({ taskId, force, to, skip, evidence }) => {
        if (degraded) {
          return textResult({
            ok: false,
            degraded: true,
            error: 'store is read-only (daemon down) — workflow_advance is unavailable',
          });
        }
        try {
          const id = taskId ?? engine.activeTaskId();
          if (!id) return textResult({ ok: false, error: 'no active task' });
          const opts: AdvanceOpts = {};
          if (force) opts.force = { reason: force.reason };
          if (to) opts.to = to;
          if (skip) opts.skip = true;
          if (evidence) opts.evidence = evidence;
          await engine.advance(id, opts);
          const payload = buildWorkflowStatus(engine, id, degraded);
          if (!payload) return textResult({ ok: false, taskId: id, error: 'unknown task' });
          return textResult(payload);
        } catch (err) {
          // Verify-gate pending/failed: surface a structured envelope so the CLI
          // can render recovery options (retry / force / skip / block). The
          // `failed` decision was already recorded in the audit before throw.
          if (err instanceof VerifyGateError) {
            return textResult({
              ok: false,
              pendingGate: err.pendingGate,
              ...(err.evidence === undefined ? {} : { evidence: err.evidence }),
              recovery: ['retry', 'force', 'skip', 'block'],
            });
          }
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    // `workflow_resume` surfaces the engine's `resumeTask` (c4-surface-wiring S2):
    // reads the active (or named) task; blocked/in-flight tasks are resumable,
    // done/abandoned are terminal. A read — allowed under a degraded (read-only)
    // store, mirroring `workflow_status`. Returns the status payload + a
    // `resumable` boolean so the CLI can render a resume briefing.
    server.registerTool(
      'workflow_resume',
      {
        description:
          'Resume a Noir spec-driven task across a session break. Omit taskId to target the active task. Blocked/in-flight tasks are resumable; done/abandoned are terminal. Returns the task status + a resumable flag.',
        inputSchema: {
          taskId: z
            .string()
            .optional()
            .describe('Task id; defaults to the active task (workflow:active).'),
        },
      },
      async ({ taskId }) => {
        try {
          let task: TaskState | null = null;
          if (taskId) {
            task = engine.status(taskId);
          } else if (ctx.store) {
            // resumeTask reads workflow:active → the persisted TaskState and
            // returns null for terminal tasks. Uses only the public Store API.
            task = await resumeTask(ctx.store);
          }
          if (!task) {
            return textResult({ ok: true, resumable: false, error: 'no resumable task' });
          }
          const payload = buildWorkflowStatus(engine, task.taskId, degraded);
          if (!payload) {
            return textResult({ ok: true, resumable: false, error: 'no resumable task' });
          }
          return textResult({ resumable: true, ...payload });
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    // `workflow_block` surfaces `engine.setBlocked` (c4-surface-wiring S4): mark
    // the active (or named) task blocked with a non-empty reason. A write — a
    // degraded (read-only) store refuses it up front (no crash).
    server.registerTool(
      'workflow_block',
      {
        description:
          'Mark a Noir spec-driven task blocked with a reason. Omit taskId to target the active task. A blocked task is resumable (retains FSM edges to every in-flight phase).',
        inputSchema: {
          taskId: z
            .string()
            .optional()
            .describe('Task id; defaults to the active task (workflow:active).'),
          reason: z.string().min(1).describe('Non-empty block reason (why the task is stuck).'),
        },
      },
      async ({ taskId, reason }) => {
        if (degraded) {
          return textResult({
            ok: false,
            degraded: true,
            error: 'store is read-only (daemon down) — workflow_block is unavailable',
          });
        }
        try {
          const id = taskId ?? engine.activeTaskId();
          if (!id) return textResult({ ok: false, error: 'no active task' });
          await engine.setBlocked(id, reason);
          const payload = buildWorkflowStatus(engine, id, degraded);
          if (!payload) return textResult({ ok: false, taskId: id, error: 'unknown task' });
          return textResult(payload);
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    // `workflow_abandon` surfaces `engine.abandon` (c4-surface-wiring S4): mark
    // the active (or named) task abandoned (terminal). A write — degraded stores
    // refuse it up front.
    server.registerTool(
      'workflow_abandon',
      {
        description:
          'Abandon a Noir spec-driven task (terminal). Omit taskId to target the active task. Abandonment is irreversible for the task lifecycle.',
        inputSchema: {
          taskId: z
            .string()
            .optional()
            .describe('Task id; defaults to the active task (workflow:active).'),
        },
      },
      async ({ taskId }) => {
        if (degraded) {
          return textResult({
            ok: false,
            degraded: true,
            error: 'store is read-only (daemon down) — workflow_abandon is unavailable',
          });
        }
        try {
          const id = taskId ?? engine.activeTaskId();
          if (!id) return textResult({ ok: false, error: 'no active task' });
          await engine.abandon(id);
          const payload = buildWorkflowStatus(engine, id, degraded);
          if (!payload) return textResult({ ok: false, taskId: id, error: 'unknown task' });
          return textResult(payload);
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    // `workflow_research_record` (c4-research-grounding): record a research
    // finding — appends to `research:<taskId>` (mirrors the gate audit). A write;
    // degraded stores refuse it up front.
    server.registerTool(
      'workflow_research_record',
      {
        description:
          'Record a research finding for a Noir spec-driven task (append-only to research:<taskId>). Non-grounding-fact types require a source (defeats faux context).',
        inputSchema: {
          taskId: z
            .string()
            .optional()
            .describe('Task id; defaults to the active task (workflow:active).'),
          type: z
            .enum(['assumption', 'discovery', 'decision', 'grounding-fact'])
            .describe('Research entry type.'),
          text: z.string().min(1).max(220).describe('Finding text (capped).'),
          source: z
            .string()
            .optional()
            .describe(
              'Evidence/citation — file:line, URL, or command. Required unless type is grounding-fact.',
            ),
        },
      },
      async ({ taskId, type, text, source }) => {
        if (degraded) {
          return textResult({
            ok: false,
            degraded: true,
            error: 'store is read-only (daemon down) — workflow_research_record is unavailable',
          });
        }
        try {
          const id = taskId ?? engine.activeTaskId();
          if (!id) return textResult({ ok: false, error: 'no active task' });
          const entry = engine.recordResearch(id, {
            type,
            text,
            ...(source === undefined ? {} : { source }),
            taskClass: engine.status(id)?.taskClass,
          });
          return textResult({ ok: true, taskId: id, entry });
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
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
          force: z
            .boolean()
            .optional()
            .describe('Force a full reindex (drop all chunks+vectors, re-index from scratch).'),
        },
      },
      async ({ paths, force }) => {
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
          // force:true → full reindex: drop every indexed chunk + vector, then
          // re-index the registered roots from scratch (spec F1 "warn + offer
          // reindex"). Any `paths` in the same call are a no-op for reindex —
          // it re-reads the registered roots. The default remains the
          // content-hash incremental walk.
          if (force === true) {
            const result = await context.reindex();
            return textResult({ ok: true, ...result });
          }
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

  // The memory engine is optional: stdio/HTTP inject it alongside the store +
  // workflow + context engines (same lifecycle, same single store handle, the
  // SAME EmbedFn already resolved for S6). When present, expose Noir's
  // cross-session memory — append-only observations stored on top of the store
  // (FTS5 + vec0 + KV) — via five tools (spec §8): `memory_save`,
  // `memory_recall` (hybrid BM25 ∪ kNN + RRF, hydrated to FULL content),
  // `memory_search` (BM25-only instant), `memory_sessions`, `memory_forget`.
  // `host_status` / `store_status` / `workflow_status` / `context_*` above are
  // unchanged. `memory_save` / `memory_forget` are writes, so a read-only
  // (daemon-down) handle fences them off up front (mirrors `context_index`).
  if (ctx.memory) {
    const memory = ctx.memory;
    const storeDegraded = ctx.storeDegraded === true;

    server.registerTool(
      'memory_save',
      {
        description:
          'Persist a cross-session memory observation (pattern / preference / architecture / bug / workflow / fact / decision). Stored locally on top of the Noir store (FTS5 + vectors + KV) — never truncated, never sent to an LLM. Returns the full saved observation.',
        inputSchema: {
          content: z
            .string()
            .min(1)
            .describe('The insight to remember (full text; never truncated).'),
          // Open enum: unknown types are accepted + stored, so this is a
          // free-form string (with the known values described) rather than a
          // closed zod enum that would reject forward-compatible types.
          type: z
            .string()
            .optional()
            .describe(
              'Observation type — pattern | preference | architecture | bug | workflow | fact | decision. Unknown values are accepted.',
            ),
          concepts: z
            .array(z.string())
            .optional()
            .describe('User tags (no auto-LLM tagging in v1 — explicit only).'),
          files: z.array(z.string()).optional().describe('Repo-relative paths mentioned.'),
          importance: z
            .number()
            .min(0)
            .max(1)
            .optional()
            .describe('Salience 0..1 (defaults to 0.5).'),
          sessionId: z.string().optional().describe('Host session id (recorded when known).'),
        },
      },
      async (input) => {
        // Read-only (daemon-down) store: a save is a write — fence it off up
        // front with a clear envelope rather than letting the engine throw
        // mid-run (mirrors `context_index`).
        if (storeDegraded) {
          return textResult({
            ok: false,
            degraded: true,
            error: 'store is read-only (daemon down) — memory_save is unavailable',
          });
        }
        try {
          const observation = await memory.save(input);
          return textResult({ ok: true, id: observation.id, observation });
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    server.registerTool(
      'memory_recall',
      {
        description:
          'Hybrid recall over cross-session memory: BM25 ∪ cosine-kNN fused by Reciprocal Rank Fusion (k=60) scoped to source:"memory", plus a cheap entity-boost. Returns ranked observations with FULL content (hydrated from the authoritative KV row — never the truncated FTS snippet). Degrades to BM25-only when the embedder is unavailable.',
        inputSchema: {
          query: z.string().describe('Natural-language or identifier query.'),
          limit: z.number().int().positive().optional().describe('Max results (default 10).'),
          type: z.string().optional().describe('Filter to a single observation type.'),
          sessionId: z.string().optional().describe('Filter to a single host session.'),
        },
      },
      async ({ query, limit, type, sessionId }) => {
        try {
          const results = await memory.recall(query, { limit, type, sessionId });
          return textResult({ ok: true, results });
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    server.registerTool(
      'memory_search',
      {
        description:
          'Instant BM25-only lookup over cross-session memory (no embedding cost). Returns ranked observations with FULL content, scoped to source:"memory". Use memory_recall for the hybrid (vector + BM25) path.',
        inputSchema: {
          query: z.string().describe('Natural-language or identifier query.'),
          limit: z.number().int().positive().optional().describe('Max results (default 10).'),
        },
      },
      async ({ query, limit }) => {
        try {
          const hits = await memory.search(query, { limit });
          return textResult({ ok: true, hits });
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    server.registerTool(
      'memory_sessions',
      {
        description:
          "List per-session memory rollups (session id, observation count, most-recent timestamp) for this project's cross-session memory.",
        inputSchema: {},
      },
      async () => {
        try {
          return textResult({ ok: true, sessions: memory.sessions() });
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    server.registerTool(
      'memory_forget',
      {
        description:
          'Remove observations from cross-session memory: deletes the authoritative KV row + best-effort FTS/vector purge. Returns the count actually removed.',
        inputSchema: {
          ids: z.array(z.string()).min(1).describe('Observation ids to remove.'),
        },
      },
      async ({ ids }) => {
        if (storeDegraded) {
          return textResult({
            ok: false,
            degraded: true,
            error: 'store is read-only (daemon down) — memory_forget is unavailable',
          });
        }
        try {
          const result = memory.forget(ids);
          return textResult({ ok: true, ...result });
        } catch (err) {
          return textResult({ ok: false, degraded: true, error: errorMessage(err) });
        }
      },
    );

    // Consolidation is OPT-IN + provider-explicit (blueprint D5/D6 / §9):
    // the tool is registered ONLY when the daemon wired a consolidation-capable
    // engine — i.e. the user set `memory.consolidation.enabled: true` AND a usable
    // provider+model resolved (see `resolveConsolidationCapability`). The engine's
    // `consolidate` self-refuses (`no-provider`/`model-unavailable`) and logs the
    // miss otherwise — never a crash, never a silent paid call. A `model:` block
    // set for summarize/title/draft does NOT register this tool when the user
    // opted out under `memory:` (the Agent-Memory anti-pattern, §9).
    if (ctx.memoryConsolidation === true) {
      server.registerTool(
        'memory_consolidate',
        {
          description:
            'Explicitly consolidate recent memory observations into ONE derived lesson (append-only; originals are never mutated). Provider-gated: refuses + logs if no provider is configured — NEVER a silent paid call. Emits a type:"lesson" observation with provenance.',
          inputSchema: {
            types: z
              .array(z.string())
              .optional()
              .describe('Restrict candidates to these observation types.'),
            limit: z
              .number()
              .int()
              .positive()
              .optional()
              .describe('Cap on candidate observations.'),
          },
        },
        async ({ types, limit }) => {
          try {
            const result = await memory.consolidate?.({ types, limit });
            if (result === undefined) {
              // Defensive: the gate (`ctx.memoryConsolidation`) and the engine's
              // `consolidate` presence agree by construction; if they ever
              // diverge, surface a clear refusal instead of a crash.
              return textResult({
                ok: false,
                degraded: true,
                error: 'consolidation is not wired on this engine',
              });
            }
            return textResult(result);
          } catch (err) {
            return textResult({ ok: false, degraded: true, error: errorMessage(err) });
          }
        },
      );
    }
  }

  // The integration service is optional: stdio/HTTP inject it
  // once per serve lifecycle (mirrors the store/engine/memory/context handles).
  // `integrations_auth` is ALWAYS registered when the service is present — it
  // resolves an integration token VALUE from process.env at CALL TIME (never at
  // load time; never cached) and returns it to the calling agent. This kills the
  // non-interactive-shell gotcha (the skill + its MCP tool never read shell env
  // directly; only the daemon's process env matters). When the env value is
  // absent, the tool reports `no-token` and the skill falls back to manual paste.
  //
  // SECURITY: the token travels ONLY in the tool RESULT to the trusted host +
  // the outbound `Authorization` header. It is never written to stderr, never
  // persisted, never echoed into an audit body. `noir_clickup_write` (below) is
  // registered only when a `noir-clickup` declaration with
  // `runtime:'gated-write-proxy'` is discovered, and its dry-run path never even
  // resolves the token.
  if (ctx.integrations) {
    const integrations = ctx.integrations;

    server.registerTool(
      'integrations_auth',
      {
        description:
          "Resolve an integration token VALUE server-side at call time (kills the non-interactive-shell gotcha). Pass {integration:'noir-clickup'} to resolve tokenEnv from the discovered declaration, or {envVar:'CLICKUP_API_TOKEN'} to name the env var directly. Returns {ok:true,token,envVar} when present, or {ok:false,reason:'no-token',envVar} when absent (the skill then does manual-paste fallback). The token is returned ONLY in this tool result — never logged, never persisted.",
        inputSchema: {
          integration: z
            .string()
            .optional()
            .describe(
              "Integration name (e.g. 'noir-clickup' or 'clickup'); resolves tokenEnv from the discovered declaration (config override honored).",
            ),
          envVar: z
            .string()
            .optional()
            .describe(
              'Env-var name to read directly (e.g. CLICKUP_API_TOKEN). Used when no integration binding applies.',
            ),
        },
      },
      async ({ integration, envVar }) => {
        if (integration === undefined && envVar === undefined) {
          return textResult({
            ok: false,
            reason: 'invalid-input',
            error: 'pass one of {integration} or {envVar}',
          });
        }
        const resolution = resolveToken(integrations, { integration, envVar });
        return textResult(resolution);
      },
    );

    // `noir_clickup_write` — the gated-write-proxy for ClickUp. Registered ONLY when the shipped
    // `noir-clickup` declaration is discovered AND the EFFECTIVE runtime resolves
    // to `gated-write-proxy`. The effective runtime is the user's
    // `integrations.clickup.runtime` overlay when set, else the declaration's
    // runtime — so a local downgrade to `runtime:'none'` (a read-only run) takes
    // the write tool off without touching the shipped declaration. The tier
    // model: `none` = skill-side reads only; `integrations_auth` still resolves
    // the token regardless (registered above), so the skill's read flows keep
    // working. The proxy constructs URLs ONLY from op + payload + the workspace
    // binding (a caller-supplied `url` is ignored) — the prompt-injection
    // defense. The confirm gate is HARD: unless `confirm === true`, NO `fetch`
    // is made; the tool returns a dry-run preview (method/allowlisted URL/
    // redacted headers/body). Executed writes append to `.noir/audit/`
    // (X-OQ2: REUSE the dir).
    const clickupBinding = findBinding(integrations, 'noir-clickup');
    if (clickupBinding && clickupBinding.effectiveRuntime === 'gated-write-proxy') {
      const binding = clickupBinding;
      const root = integrations.root;

      server.registerTool(
        'noir_clickup_write',
        {
          description:
            'ClickUp gated-write-proxy: renders a DRY-RUN preview of the exact HTTP request(s) for an op, and ONLY on explicit {confirm:true} executes them server-side with the pk_ token (NO Bearer). Ops: status (PUT /task/{id}), subtask (POST /list/{list_id}/task + optional PUT status), comment (POST /task/{id}/comment), batch (loop POST /list/{list_id}/task, concurrency 4, 429 backoff on X-RateLimit-Reset). URLs are allowlisted — a caller-supplied url is ignored (prompt-injection defense). Executed writes are audited to .noir/audit/.',
          inputSchema: {
            op: z
              .enum([
                'status',
                'subtask',
                'comment',
                'batch',
                // `task:`-prefixed aliases emitted by the LOCKED noir-clickup
                // SKILL.md; normalized to the short form internally.
                'task:set-status',
                'task:create-subtask',
                'task:comment',
                'task:batch-create',
              ])
              .describe(
                "Write op. Short form ('status'|'subtask'|'comment'|'batch') or the task:-prefixed form the skill emits.",
              ),
            // Flat op-specific fields (matches the LOCKED skill's call shape;
            // the `payload` nesting is honored by also accepting a payload
            // object — the handler reads both).
            taskId: z.string().optional().describe('status/comment: the ClickUp task id.'),
            status: z
              .string()
              .optional()
              .describe('status: the new status value; subtask: optional new-subtask status.'),
            parentTaskId: z
              .string()
              .optional()
              .describe('subtask: the parent task id (same list).'),
            name: z.string().optional().describe('subtask: the new subtask name.'),
            listId: z
              .string()
              .optional()
              .describe('subtask/batch: overrides integrations.clickup.listId.'),
            teamId: z.string().optional().describe('Optional team-id override (custom-id reads).'),
            commentText: z.string().optional().describe('comment: the comment body.'),
            notifyAll: z.boolean().optional().describe('comment: notify_all flag (default false).'),
            assigneeId: z.number().optional().describe('comment: assignee user id (integer).'),
            tasks: z
              .array(z.record(z.string(), z.unknown()))
              .optional()
              .describe(
                'batch: normalized tasks array ({name,description?,tags?,assignees?,status?}).',
              ),
            markdown: z
              .string()
              .optional()
              .describe('batch: H2-per-task markdown (## Title \\n body \\n - tag: x).'),
            payload: z
              .record(z.string(), z.unknown())
              .optional()
              .describe('Alternative: a single payload object with any of the fields above.'),
            confirm: z
              .boolean()
              .optional()
              .describe(
                'HARD confirm gate. Unless true, the tool is DRY-RUN (no fetch). Default false.',
              ),
            dryRun: z
              .boolean()
              .optional()
              .describe('Force a dry-run preview even if confirm is true (safe default wins).'),
          },
        },
        async (input) => {
          // Merge the flat input fields with the optional `payload` object so
          // both the `{op,payload}` shape and the LOCKED skill's flat call
          // shape work. Flat fields take precedence (they're the explicit form).
          const payloadRaw: Record<string, unknown> = {
            ...(input.payload ?? {}),
            ...Object.fromEntries(
              Object.entries(input).filter(
                ([k, v]) =>
                  k !== 'op' &&
                  k !== 'confirm' &&
                  k !== 'dryRun' &&
                  k !== 'payload' &&
                  v !== undefined,
              ),
            ),
          };

          // 1. Build the request(s) (dry-run computation; NO network). This
          //    validates the op + payload against the allowlist + id charset,
          //    throwing InvalidOp on a contract violation.
          let built: ReturnType<typeof buildRequests>;
          try {
            built = buildRequests(input.op, payloadRaw, {
              ...(binding.teamId !== undefined ? { teamId: binding.teamId } : {}),
              ...(binding.listId !== undefined ? { listId: binding.listId } : {}),
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return textResult({ ok: false, reason: 'invalid-op', op: input.op, error: message });
          }

          // 2. Resolve the mode. `confirm:true` AND NOT `dryRun:true` ⇒ execute.
          //    Everything else ⇒ dry-run (the SAFE default; never execute
          //    without explicit confirm).
          const execute = input.confirm === true && input.dryRun !== true;

          if (!execute) {
            // Dry-run: NO token resolution, NO fetch. Return the preview.
            return textResult({
              ok: true,
              mode: 'dry-run',
              op: built.op,
              integration: 'noir-clickup',
              preview: previewRows(built.requests),
              note: 'Pass {confirm:true} to execute. No network call was made.',
            });
          }

          // 3. Execute path: resolve the token at CALL TIME. No token ⇒ refuse,
          //    no fetch (graceful; the skill does manual-paste fallback).
          const resolution = resolveToken(integrations, { integration: 'noir-clickup' });
          if (!resolution.ok) {
            return textResult({
              ok: false,
              reason: resolution.reason,
              // `envVar` is present on the no-token branch; the unknown-integration
              // branch carries `integration` instead. Spread conditionally so the
              // union narrows cleanly.
              ...('envVar' in resolution ? { envVar: resolution.envVar } : {}),
              op: built.op,
              error: 'no token resolved; set the env var or use the manual-paste fallback',
            });
          }
          const token = resolution.token;

          // 4. Execute via the daemon's global fetch. The token enters ONLY here
          //    (as `Authorization: pk_<token>`, NO Bearer).
          const op: ClickUpOp = built.op;
          let results: ExecResult[];
          try {
            results = await executeOp(op, built.requests, token, (url, init) => fetch(url, init));
          } catch (err) {
            // A throw here is unexpected (executeOne catches its own fetch
            // errors); surface it as a degraded envelope, never a crash.
            const message = err instanceof Error ? err.message : String(err);
            return textResult({ ok: false, reason: 'http-error', op, error: message });
          }

          // 5. Audit every EXECUTED request to .noir/audit/integration-clickup.jsonl
          //    (X-OQ2: REUSE the dir). Best-effort; the result envelope reports
          //    `audited:false` if the write failed.
          let audited = true;
          for (const r of results) {
            const entry: IntegrationAuditEntry = {
              kind: 'integration',
              integration: 'noir-clickup',
              op: normalizeOp(input.op),
              target: r.target,
              method: r.method,
              httpStatus: r.httpStatus,
              success: r.success,
              timestamp: Date.now(),
              ...(r.rateLimitedWaitMs !== undefined
                ? { rateLimitedWaitMs: r.rateLimitedWaitMs }
                : {}),
              ...(r.error !== undefined ? { error: r.error } : {}),
            };
            try {
              writeIntegrationAudit(root, 'noir-clickup', entry);
            } catch {
              audited = false;
            }
          }

          // 6. Return the executed result. The token is NEVER included. The
          //    overall `ok` reflects whether every request succeeded; per-request
          //    detail is in `results[]`.
          const allOk = results.length > 0 && results.every((r) => r.success);
          return textResult({
            ok: allOk,
            mode: 'executed',
            op,
            integration: 'noir-clickup',
            results,
            audited,
          });
        },
      );
    }
  }

  return server;
}
