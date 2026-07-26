// S9 t5 — `noir task {new,status,advance,next}`.
//
// Thin MCP-client commands over the daemon's S4 workflow surface. The daemon
// registers four workflow tools (packages/daemon/src/server.ts): `workflow_status`
// (read the active or named task), `checkpoint` (save/restore in-flight state),
// `workflow_start` (start a task), and `workflow_advance` (advance/jump a task).
// All four CLI sub-commands are wired: `status`/`next` → `workflow_status`;
// `new` → `workflow_start`; `advance` → `workflow_advance`.
//
// `new`/`advance` are writes. A read-only (daemon-down) store refuses them with
// a `{ok:false,degraded:true}` envelope (surfaced as exit 1 here); any other
// logical failure (unknown task, no active task, illegal transition) is likewise
// exit 1 for these writes. Daemon-unreachable ⇒ exit 4 (DAEMON_DOWN) from
// `callDaemonTool`, so transport vs logical failures stay distinguishable.
//
// `status` / `next` (reads) map the daemon's logical-failure envelopes
// (`{ok:false,error:'no active task'}` / `{ok:false,error:'unknown task'}`)
// onto exit 3 (NOT_FOUND) — a focused task read reporting absence is a
// not-found condition, not an error (the broader `noir status` folds the same
// envelope to `null` and stays exit 0).

import { callDaemonTool, type DaemonClientOptions } from '../daemon-client.js';
import { type CliOptions, definitionList, EXIT, fail, info, log } from '../output.js';
import { badge } from '../theme.js';

/** Options accepted by every `task` sub-command (globals + daemon knobs). */
export interface TaskOptions extends CliOptions, DaemonClientOptions {}

// ---------------------------------------------------------------------------
// Tool result shapes (slices of the daemon wire payloads; local types).
// ---------------------------------------------------------------------------

/** `workflow_status` success payload (WorkflowStatus). */
interface WorkflowStatusResult {
  ok: true;
  taskId: string;
  phase: string;
  state: string;
  mode: string;
  nextGate: string | null;
  history?: unknown;
  updatedAt?: number;
  degraded?: boolean;
}

/** `workflow_status` logical-failure envelopes (no active / unknown task). */
interface WorkflowNotFound {
  ok: false;
  error?: string;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Phase → skill suggestion (grounded in the real @noir-ai/skills builtin pack;
// each phase maps to a shipped noir-* skill the host can invoke next).
// ---------------------------------------------------------------------------
const PHASE_SKILL: Readonly<Record<string, string>> = {
  intake: 'noir-intake',
  clarify: 'noir-clarify',
  spec: 'noir-spec',
  plan: 'noir-plan',
  execute: 'noir-execute',
  verify: 'noir-verify',
  document: 'noir-document',
};

function skillFor(phase: string | null | undefined): string | null {
  if (typeof phase !== 'string') return null;
  return PHASE_SKILL[phase] ?? null;
}

// ---------------------------------------------------------------------------
// Shared fetch + render
// ---------------------------------------------------------------------------

/**
 * Call `workflow_status` (active task when `taskId` is absent). Returns the
 * success payload or throws exit 3 (NOT_FOUND) for a logical-failure envelope
 * (no active task / unknown task) — a focused task read's "absent" is a
 * not-found condition.
 */
async function fetchStatus(opts: TaskOptions, taskId?: string): Promise<WorkflowStatusResult> {
  const args: Record<string, unknown> =
    typeof taskId === 'string' && taskId.length > 0 ? { taskId } : {};
  const res = await callDaemonTool<WorkflowStatusResult | WorkflowNotFound>(
    opts,
    'workflow_status',
    args,
  );
  if (res.ok === true) return res;
  const detail = res.error ?? 'task not found';
  // exit 3 (NOT_FOUND): the daemon was reachable; there's just no such task.
  fail(EXIT.NOT_FOUND, `task: ${detail}`, opts);
}

/** Format a `WorkflowStatus.updatedAt` epoch-ms stamp as a readable UTC string. */
function formatStamp(ms?: number): string {
  if (typeof ms !== 'number' || ms <= 0) return '-';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\..*$/, 'Z');
}

function renderStatusRow(s: WorkflowStatusResult, opts: CliOptions): void {
  const flag = s.degraded === true ? `  ${badge('warn', 'degraded')}` : '';
  log(`task status — ${s.taskId}${flag}`, opts);
  definitionList(
    [
      { label: 'Task', value: s.taskId },
      { label: 'Phase', value: s.phase },
      { label: 'State', value: s.state },
      { label: 'Mode', value: s.mode },
      { label: 'Next gate', value: s.nextGate ?? '—' },
      { label: 'Updated', value: formatStamp(s.updatedAt) },
    ],
    opts,
  );
}

// ---------------------------------------------------------------------------
// `noir task status [<id>]`
// ---------------------------------------------------------------------------
export interface TaskStatusOptions extends TaskOptions {
  /** Positional task id; omitted ⇒ the active task. */
  id?: string;
}

export async function taskStatus(opts: TaskStatusOptions): Promise<void> {
  const s = await fetchStatus(opts, opts.id);
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: s })}\n`);
    return;
  }
  renderStatusRow(s, opts);
}

// ---------------------------------------------------------------------------
// `noir task next`
// ---------------------------------------------------------------------------
export async function taskNext(opts: TaskOptions): Promise<void> {
  const s = await fetchStatus(opts);
  const suggestion = skillFor(s.phase);
  const nextSkill = skillFor(s.nextGate);
  const data = {
    taskId: s.taskId,
    phase: s.phase,
    state: s.state,
    mode: s.mode,
    nextGate: s.nextGate,
    suggestion,
    nextSkill,
    degraded: s.degraded === true,
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  const flag = data.degraded ? `  ${badge('warn', 'degraded')}` : '';
  log(`task next — ${s.taskId} · phase ${s.phase} (${s.state}, ${s.mode})${flag}`, opts);
  if (s.nextGate) {
    info(`next gate: ${s.nextGate}`, opts);
  } else {
    info('no further gate ahead (past verify, or stopped).', opts);
  }
  if (suggestion) info(`skill for current phase (${s.phase}): ${suggestion}`, opts);
  if (nextSkill) info(`skill for next gate (${s.nextGate}): ${nextSkill}`, opts);
  if (!suggestion && !nextSkill) {
    info('run `noir skills list` to see applicable skills.', opts);
  }
}

// ---------------------------------------------------------------------------
// `noir task new --slug <slug> [--mode full|quick]`  → workflow_start
// ---------------------------------------------------------------------------
export interface TaskNewOptions extends TaskOptions {
  slug: string;
  mode?: string;
}

export async function taskNew(opts: TaskNewOptions): Promise<void> {
  // Validate mode client-side so a typo is a clean usage error (exit 2) rather
  // than a server-side zod rejection that would mis-map onto exit 4.
  let mode: 'full' | 'quick' | undefined;
  if (opts.mode !== undefined) {
    if (opts.mode !== 'full' && opts.mode !== 'quick') {
      fail(EXIT.USAGE, `task new: invalid mode '${opts.mode}' (expected 'full' or 'quick')`, opts);
    }
    mode = opts.mode;
  }
  // The CLI surface only takes a slug, so it doubles as the stable taskId — the
  // engine's taskId/slug distinction collapses to the slug here. Re-starting the
  // same slug overwrites (the KV is the source of truth, not a journal).
  const res = await callDaemonTool<WorkflowStatusResult | WorkflowNotFound>(
    opts,
    'workflow_start',
    {
      taskId: opts.slug,
      slug: opts.slug,
      ...(mode === undefined ? {} : { mode }),
    },
  );
  if (res.ok !== true) {
    const detail =
      typeof res.error === 'string' && res.error.length > 0 ? res.error : 'start failed';
    fail(EXIT.ERROR, `task new --slug ${opts.slug}: ${detail}`, opts);
  }
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: res })}\n`);
    return;
  }
  renderStatusRow(res, opts);
}

// ---------------------------------------------------------------------------
// `noir task advance [--to <phase>] [--force <reason>]`  → workflow_advance
// ---------------------------------------------------------------------------
export interface TaskAdvanceOptions extends TaskOptions {
  to?: string;
  force?: string;
}

export async function taskAdvance(opts: TaskAdvanceOptions): Promise<void> {
  const args: Record<string, unknown> = {};
  if (typeof opts.to === 'string' && opts.to.length > 0) {
    // Validate the target phase client-side (exit 2 on a typo) — PHASE_SKILL's
    // keys ARE the valid phases, so reuse them rather than a second literal.
    if (!Object.keys(PHASE_SKILL).includes(opts.to)) {
      fail(EXIT.USAGE, `task advance: invalid phase '${opts.to}'`, opts);
    }
    args.to = opts.to;
  }
  if (typeof opts.force === 'string' && opts.force.length > 0) {
    args.force = { reason: opts.force };
  }
  // Omit taskId → the daemon targets the active task (workflow:active).
  const res = await callDaemonTool<WorkflowStatusResult | WorkflowNotFound>(
    opts,
    'workflow_advance',
    args,
  );
  if (res.ok !== true) {
    const detail =
      typeof res.error === 'string' && res.error.length > 0 ? res.error : 'advance failed';
    fail(EXIT.ERROR, `task advance: ${detail}`, opts);
  }
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: res })}\n`);
    return;
  }
  renderStatusRow(res, opts);
}
