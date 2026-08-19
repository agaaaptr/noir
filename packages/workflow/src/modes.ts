import type { Store } from '@noir-ai/store';
import { writeSpec } from './artifacts.js';
import type { WorkflowEngine } from './engine.js';
import { readGateHistory } from './gates.js';
import type { TaskState, WorkflowState } from './types.js';

/**
 * Default spec body written by {@link runQuick}. Quick mode is "discipline
 * lite": the spec is stubbed (the spec + plan gates are skipped), but a real
 * spec file still lands on disk so later phases (and humans) have something to
 * read. Exported so callers/tests can assert on the canonical stub text.
 */
export const QUICK_SPEC_STUB = '<quick-mode stub spec>';

/** Options for {@link runQuick}. */
export interface QuickOpts {
  /**
   * Override the stub spec body (defaults to {@link QUICK_SPEC_STUB}). Useful
   * when a quick task already has a one-line description worth persisting.
   */
  specBody?: string;
}

/**
 * Quick mode — the fast path for small / spike tasks.
 *
 * Writes a stub spec to `.noir/specs/SP-<NNNN>-<taskId>-<slug>.md` (via
 * {@link writeSpec}) and fast-forwards the task from `draft` to `executing`,
 * recording the spec and plan gates as `decision: 'skipped'`. The verify gate
 * is intentionally LEFT alone — it still fires as `approved` when the task
 * later reaches `done`, providing the one real checkpoint (discipline lite).
 *
 * The task must already be started (`engine.startTask(..., 'quick')`); this
 * function reads the slug from the persisted TaskState. Skipped gates are
 * RECORDED (Noir §9.1 observable-checkpoint invariant), never silently dropped
 * — the audit KV and `history` both carry the `skipped` entries.
 */
export async function runQuick(
  engine: WorkflowEngine,
  taskId: string,
  opts?: QuickOpts,
): Promise<TaskState> {
  const task = engine.status(taskId);
  if (!task) throw new Error(`Unknown task: ${taskId}`);
  // Guard: quick mode must only run on a task started in 'quick' mode. Calling
  // it on a full-mode task would silently downgrade the spec/plan discipline
  // (recording them as 'skipped') with no observable indication.
  if (task.mode !== 'quick') {
    throw new Error(`runQuick requires a quick-mode task (got ${task.mode})`);
  }

  // Flush the stub spec first so the artifact exists before any gate fires.
  writeSpec(engine.root, taskId, task.slug, opts?.specBody ?? QUICK_SPEC_STUB);

  // draft → clarifying → specified (spec gate SKIPPED) → planned (plan gate
  // SKIPPED) → executing. Verify is left for the normal flow (runs as approved).
  await engine.advance(taskId); // draft → clarifying (no gate)
  await engine.advance(taskId, { skip: true }); // → specified (spec gate skipped)
  await engine.advance(taskId, { skip: true }); // → planned (plan gate skipped)
  return engine.advance(taskId); // → executing (no gate) — land here
}

/** Terminal states with nothing left to resume. `blocked` is NOT terminal. */
const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set<WorkflowState>(['done', 'abandoned']);

/**
 * Reconstruct the in-flight TaskState across a session break.
 *
 * Reads `workflow:active` from the store KV → the most-recently-started
 * taskId (T4 semantics; v1 is one-task-per-project) → the persisted
 * `workflow:<taskId>` TaskState. Returns `null` when there is no active task,
 * the task record is missing, or the active task is terminal (`done` /
 * `abandoned` — nothing to resume). A `blocked` task IS resumable.
 *
 * Uses only the public {@link Store} API, so a freshly-`openStore`'d handle
 * against the same on-disk DB is sufficient (no live engine required).
 */
export async function resumeTask(store: Store): Promise<TaskState | null> {
  const activeId = store.getState<string>('workflow:active');
  if (!activeId) return null;

  const task = store.getState<TaskState>(`workflow:${activeId}`);
  if (!task) return null;
  if (TERMINAL_STATES.has(task.state)) return null;

  // Re-derive history from the authoritative audit KV (mirrors engine.status)
  // so the resumed task carries the full gate history, not the possibly-stale
  // persisted `task.history`.
  task.history = readGateHistory(store, activeId);
  return task;
}
