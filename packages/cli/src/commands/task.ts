// S9 — `noir task {new,status,advance,next}`.
//
// Thin MCP-client commands over the daemon's workflow surface. The daemon
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

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadProjectInfo } from '@noir-ai/core';
import {
  PHASES,
  type Phase,
  TASK_CLASSES,
  type TaskClass,
  writeChangelogStub,
  writeDecisionStub,
} from '@noir-ai/workflow';
import {
  callDaemonTool,
  type DaemonClientOptions,
  type DaemonProbe,
  probeDaemon,
  withInProcessRead,
} from '../daemon-client.js';
import {
  type CliOptions,
  definitionList,
  EXIT,
  fail,
  info,
  isInteractive,
  log,
  success,
  tip,
  warn,
} from '../output.js';
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
  /** Task class (drives the soft PRD gate); absent on legacy tasks. */
  taskClass?: string;
  /** Block reason captured by `setBlocked` (absent unless blocked). */
  blockReason?: string;
}

/** `workflow_status` logical-failure envelopes (no active / unknown task). */
interface WorkflowNotFound {
  ok: false;
  error?: string;
  taskId?: string;
}

/** `workflow_resume` payload — a WorkflowStatus + a resumable flag. */
interface WorkflowResumeResult {
  ok: boolean;
  resumable?: boolean;
  taskId?: string;
  phase?: string;
  state?: string;
  mode?: string;
  nextGate?: string | null;
  history?: unknown;
  updatedAt?: number;
  degraded?: boolean;
  taskClass?: string;
  blockReason?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Phase → skill suggestion (grounded in the real @noir-ai/skills builtin pack;
// each phase maps to a shipped noir-* skill the host can invoke next).
// Exported so `noir handoff` reuses the SAME phase→skill map when naming
// the next gate's skill in the handoff artifact — single source.
// ---------------------------------------------------------------------------
export const PHASE_SKILL: Readonly<Record<string, string>> = {
  // C3 curation (2026-08-10): intake+clarify merged into brainstorming;
  // execute → executing-plans; verify → verifying; document → wrap.
  intake: 'noir-brainstorming',
  clarify: 'noir-brainstorming',
  spec: 'noir-spec',
  plan: 'noir-planning',
  execute: 'noir-executing-plans',
  verify: 'noir-verifying',
  document: 'noir-wrap',
};

/** Map a phase string to its shipped skill id (`null` if unknown / absent).
 *  Exported for `noir handoff`. */
export function skillFor(phase: string | null | undefined): string | null {
  if (typeof phase !== 'string') return null;
  return PHASE_SKILL[phase] ?? null;
}

/**
 * c4-verify-gate-recovery S8 — write the document-phase artifacts when a task
 * lands at `done`: a changelog entry + a pending decision-record stub. Uses the
 * artifact conflict seam with `preserve` policy (never clobber a user's edit).
 * The decision-record number is the next after the highest existing ADR.
 */
function writeDoneArtifacts(opts: CliOptions, taskId: string): void {
  try {
    const project = loadProjectInfo(process.cwd());
    const conflict = { conflictPolicy: 'preserve' as const, interactive: false };
    writeChangelogStub(project.root, `- ${taskId}: completed (verify gate passed)`, conflict);
    // Decision-record numbering: scan .noir/decisions/ (the artifact writer's
    // path) for NNNN.md, take max+1.
    const decisionsDir = join(project.root, '.noir', 'decisions');
    let nextN = 1;
    try {
      const files = readdirSync(decisionsDir);
      const nums = files
        .map((f) => Number.parseInt(f.replace(/\D.*$/, ''), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      if (nums.length > 0) nextN = Math.max(...nums) + 1;
    } catch {
      // No decisions dir yet — start at 1.
    }
    writeDecisionStub(project.root, nextN, taskId, conflict);
  } catch {
    // Artifact writes are best-effort — a failure must never mask the advance
    // result. Surface a tip so the user knows the artifacts didn't land.
    tip('document-phase artifacts could not be written (use --no-artifacts to skip)', opts);
  }
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
  const rows: { label: string; value: string }[] = [
    { label: 'Task', value: s.taskId },
    { label: 'Phase', value: s.phase },
    { label: 'State', value: s.state },
    { label: 'Mode', value: s.mode },
  ];
  if (typeof s.taskClass === 'string' && s.taskClass.length > 0) {
    rows.push({ label: 'Class', value: s.taskClass });
  }
  if (typeof s.blockReason === 'string' && s.blockReason.length > 0) {
    rows.push({ label: 'Block reason', value: s.blockReason });
  }
  rows.push(
    { label: 'Next gate', value: s.nextGate ?? '—' },
    { label: 'Updated', value: formatStamp(s.updatedAt) },
  );
  definitionList(rows, opts);
}

// ---------------------------------------------------------------------------
// `noir task status [<id>]`
// ---------------------------------------------------------------------------
export interface TaskStatusOptions extends TaskOptions {
  /** Positional task id; omitted ⇒ the active task. */
  id?: string;
}

/** The gate phases in lifecycle order (mirrors the daemon's `nextGateAfter`). */
const GATE_PHASES = ['spec', 'plan', 'verify'] as const satisfies readonly Phase[];

/** The next gate-phase strictly ahead of `phase`, or `null` (past verify). */
function nextGateAfter(phase: string): Phase | null {
  const cur = PHASES.indexOf(phase as Phase);
  for (const p of GATE_PHASES) {
    if (PHASES.indexOf(p) > cur) return p;
  }
  return null;
}

/**
 * Run `task status` against the daemon when it is up, or fall back to the
 * IN-PROCESS read-only workflow engine when the daemon probe reports it down
 * (S9 DS-5). A status read on a read-only store is a pure KV read, so instead
 * of exit 4 it resolves against the in-process engine (still exit 3 NOT_FOUND
 * for an unknown / absent task). Writes (`task new` / `advance`) keep the
 * daemon-required exit-4 path.
 */
export async function taskStatus(opts: TaskStatusOptions): Promise<void> {
  // Conservative probe (mirrors contextSearch/memoryRecall): only a CONFIRMED
  // `{running:false}` engages the in-process fallback; an unavailable probe
  // defaults to the daemon path.
  let probe: DaemonProbe;
  try {
    probe = await probeDaemon(opts);
  } catch {
    probe = { running: true };
  }
  if (!probe.running) {
    const s = await withInProcessRead(opts, async (engines) => {
      const id = typeof opts.id === 'string' && opts.id.length > 0 ? opts.id : null;
      const taskId = id ?? engines.workflow.activeTaskId();
      if (!taskId) fail(EXIT.NOT_FOUND, 'task: no active task', opts);
      const task = engines.workflow.status(taskId);
      if (!task) fail(EXIT.NOT_FOUND, `task: unknown task '${taskId}'`, opts);
      const stopped = task.state === 'blocked' || task.state === 'abandoned';
      return {
        ok: true as const,
        taskId: task.taskId,
        phase: task.phase,
        state: task.state,
        mode: task.mode,
        nextGate: stopped ? null : nextGateAfter(task.phase),
        history: task.history,
        updatedAt: task.updatedAt,
        degraded: true as const,
      };
    });
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: s })}\n`);
      return;
    }
    renderStatusRow(s, opts);
    return;
  }
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
  /** Task class — drives the soft PRD gate (prd.mandatoryFor). */
  taskClass?: string;
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
  // Validate taskClass client-side (exit 2 on a typo) — c4-surface-wiring S1.
  let taskClass: TaskClass | undefined;
  if (opts.taskClass !== undefined) {
    if (!TASK_CLASSES.includes(opts.taskClass as TaskClass)) {
      fail(
        EXIT.USAGE,
        `task new: invalid class '${opts.taskClass}' (expected one of: ${TASK_CLASSES.join(', ')})`,
        opts,
      );
    }
    taskClass = opts.taskClass as TaskClass;
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
      ...(taskClass === undefined ? {} : { taskClass }),
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
  /** Skip the document-phase artifact writes (changelog + decision stubs). */
  noArtifacts?: boolean;
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
  // c4-verify-gate-recovery S8 — document-phase artifact wiring: when the task
  // lands at `done`, write a changelog entry + a pending decision-record stub
  // via the artifact conflict seam (preserve on conflict). `--no-artifacts`
  // skips; the memory consolidation hook is provider-gated and fires via the
  // daemon's existing memory engine when configured (not re-implemented here).
  if (res.state === 'done' && opts.noArtifacts !== true) {
    writeDoneArtifacts(opts, res.taskId);
  }
  // Surface (never auto-emit) the handoff command at the verify gate, the
  // natural handoff point (work moves from Noir's planning into the host's
  // execution). One-line stderr hint via `tip()` so `--no-tips` / `--json`
  // silence it in CI / pipes. Never blocks; never writes to stdout.
  if (typeof opts.to === 'string' && opts.to === 'verify') {
    tip('run `noir handoff` for a ready-to-paste host prompt', opts);
  }
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: res })}\n`);
    return;
  }
  renderStatusRow(res, opts);
}

// ---------------------------------------------------------------------------
// `noir task resume [<id>] [--last] [--prompt '<continue instruction>']`
//   → workflow_resume (c4-surface-wiring S2)
// ---------------------------------------------------------------------------
export interface TaskResumeOptions extends TaskOptions {
  id?: string;
  last?: boolean;
  prompt?: string;
}

/** Render a resume briefing: state, phase, next action + skill hint + artifacts. */
function renderResumeBriefing(r: WorkflowResumeResult, opts: CliOptions): void {
  const flag = r.degraded === true ? `  ${badge('warn', 'degraded')}` : '';
  log(`resume — ${r.taskId} (${r.state}, ${r.mode})${flag}`, opts);
  const rows: { label: string; value: string }[] = [
    { label: 'Task', value: String(r.taskId) },
    { label: 'Phase', value: String(r.phase) },
    { label: 'State', value: String(r.state) },
    { label: 'Mode', value: String(r.mode) },
  ];
  if (typeof r.taskClass === 'string' && r.taskClass.length > 0) {
    rows.push({ label: 'Class', value: r.taskClass });
  }
  if (typeof r.blockReason === 'string' && r.blockReason.length > 0) {
    rows.push({ label: 'Block reason', value: r.blockReason });
  }
  rows.push({ label: 'Next gate', value: r.nextGate ?? '—' });
  definitionList(rows, opts);
  const suggestion = skillFor(r.phase ?? null);
  if (suggestion) info(`skill for current phase (${r.phase}): ${suggestion}`, opts);
  // A blocked task resumes via jump-to-phase (FSM edges from blocked → any in-flight).
  if (r.state === 'blocked') {
    info('resume a blocked task with: noir task advance --to <phase>', opts);
  }
}

export async function taskResume(opts: TaskResumeOptions): Promise<void> {
  const args: Record<string, unknown> = {};
  // `--last` / a positional id both target a specific task; omit both → active.
  if (typeof opts.id === 'string' && opts.id.length > 0) {
    args.taskId = opts.id;
  }
  const res = await callDaemonTool<WorkflowResumeResult>(opts, 'workflow_resume', args);
  // resume is a read; the "nothing to resume" envelope is exit 1 (not a crash).
  if (res.resumable !== true) {
    const detail =
      typeof res.error === 'string' && res.error.length > 0 ? res.error : 'nothing to resume';
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: false, resumable: false, error: detail })}\n`);
      return;
    }
    fail(EXIT.ERROR, `task resume: ${detail}`, opts);
  }
  // `--prompt` records a resume intent (additive KV, observable — not an FSM
  // state change). Surface it in the briefing so the host sees the continue note.
  if (typeof opts.prompt === 'string' && opts.prompt.length > 0) {
    info(`resume prompt: ${opts.prompt}`, opts);
  }
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: res })}\n`);
    return;
  }
  renderResumeBriefing(res, opts);
}

// ---------------------------------------------------------------------------
// `noir task block <reason> [--task <id>]`  → workflow_block (S4)
// ---------------------------------------------------------------------------
export interface TaskBlockOptions extends TaskOptions {
  reason: string;
  task?: string;
}

export async function taskBlock(opts: TaskBlockOptions): Promise<void> {
  if (typeof opts.reason !== 'string' || opts.reason.trim().length === 0) {
    fail(EXIT.USAGE, 'task block: a non-empty <reason> is required', opts);
  }
  const args: Record<string, unknown> = { reason: opts.reason };
  if (typeof opts.task === 'string' && opts.task.length > 0) args.taskId = opts.task;
  const res = await callDaemonTool<WorkflowStatusResult | WorkflowNotFound>(
    opts,
    'workflow_block',
    args,
  );
  if (res.ok !== true) {
    const detail =
      typeof res.error === 'string' && res.error.length > 0 ? res.error : 'block failed';
    fail(EXIT.ERROR, `task block: ${detail}`, opts);
  }
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: res })}\n`);
    return;
  }
  renderStatusRow(res, opts);
}

// ---------------------------------------------------------------------------
// `noir task abandon [--task <id>]`  → workflow_abandon (S4, destructive confirm)
// ---------------------------------------------------------------------------
export interface TaskAbandonOptions extends TaskOptions {
  task?: string;
}

export async function taskAbandon(opts: TaskAbandonOptions): Promise<void> {
  // Abandonment is terminal — confirm in interactive mode (mirrors the in-TUI
  // destructive-confirm pattern). --no-input / --json / CI skip the prompt.
  if (isInteractive(opts)) {
    const clack = await import('@clack/prompts');
    const confirm = await clack.confirm({
      message: 'Abandon this task? This is terminal and cannot be undone.',
      initialValue: false,
    });
    if (clack.isCancel(confirm)) {
      clack.cancel('Cancelled.');
      fail(EXIT.CANCELLED, 'cancelled', opts);
    }
    if (confirm !== true) {
      fail(EXIT.CANCELLED, 'abandon cancelled', opts);
    }
  }
  const args: Record<string, unknown> = {};
  if (typeof opts.task === 'string' && opts.task.length > 0) args.taskId = opts.task;
  const res = await callDaemonTool<WorkflowStatusResult | WorkflowNotFound>(
    opts,
    'workflow_abandon',
    args,
  );
  if (res.ok !== true) {
    const detail =
      typeof res.error === 'string' && res.error.length > 0 ? res.error : 'abandon failed';
    fail(EXIT.ERROR, `task abandon: ${detail}`, opts);
  }
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: res })}\n`);
    return;
  }
  renderStatusRow(res, opts);
}

// ---------------------------------------------------------------------------
// `noir task verify [--check <name> ...]`  → runs checks + submits evidence
//   to workflow_advance (c4-verify-gate-recovery S3).
// ---------------------------------------------------------------------------
export interface TaskVerifyOptions extends TaskOptions {
  /** Restrict to a named subset of checks; defaults to all configured checks. */
  check?: string[];
}

/** A check definition resolved from the project config. */
interface VerifyCheck {
  name: string;
  command: string;
  tier: 'hard' | 'soft';
}

/** `workflow_advance` result with optional verify-gate pending/recovery. */
interface WorkflowAdvanceResult {
  ok: boolean;
  taskId?: string;
  phase?: string;
  state?: string;
  mode?: string;
  nextGate?: string | null;
  history?: unknown;
  updatedAt?: number;
  degraded?: boolean;
  error?: string;
  /** c4-verify-gate-recovery: present when the verify gate did not admit `done`. */
  pendingGate?: { gate: string; reason: string };
  recovery?: string[];
}

/** Run one shell command and capture {exitCode, outputDigest}. */
function runCheck(cmd: string): { exitCode: number; digest: string } {
  // The CLI (user-invoked) owns shell access — the engine never shells out.
  // Synchronous spawn keeps `noir task verify` a single atomic step; failures
  // surface as non-zero exit codes (the evidence), never a thrown crash.
  try {
    const buf = spawnSync('sh', ['-c', cmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    let out = '';
    if (buf.stdout) out += buf.stdout.toString();
    if (buf.stderr) out += buf.stderr.toString();
    const status = buf.status;
    return {
      exitCode: typeof status === 'number' ? status : 1,
      digest: createHash('sha256').update(out).digest('hex'),
    };
  } catch {
    return { exitCode: 1, digest: createHash('sha256').update('').digest('hex') };
  }
}

export async function taskVerify(opts: TaskVerifyOptions): Promise<void> {
  // Resolve the check set from the project config (workflow.gate.verify.checks).
  // No checks resolvable → exit 2 (USAGE) rather than inventing commands.
  const project = loadProjectInfo(process.cwd());
  const cfgChecks = project.config.workflow?.gate?.verify?.checks ?? [];
  const all: VerifyCheck[] = cfgChecks.map((c) => ({
    name: c.name,
    command: c.command,
    tier: (c.tier ?? 'hard') as 'hard' | 'soft',
  }));
  let checks = all;
  if (opts.check && opts.check.length > 0) {
    const want = new Set(opts.check);
    checks = all.filter((c) => want.has(c.name));
    if (checks.length === 0) {
      fail(
        EXIT.USAGE,
        `task verify: no configured checks match --check ${[...want].join(',')}`,
        opts,
      );
    }
  }
  if (checks.length === 0) {
    fail(
      EXIT.USAGE,
      'task verify: no verify checks configured (set workflow.gate.verify.checks in noir.config)',
      opts,
    );
  }

  // Run each check, capture evidence.
  const ranAt = Date.now();
  const evidence = {
    ranAt,
    checks: checks.map((c) => {
      const r = runCheck(c.command);
      return {
        name: c.name,
        exitCode: r.exitCode,
        outputDigest: r.digest,
        command: c.command,
        tier: c.tier,
      };
    }),
    summary: '',
  };
  const passed = evidence.checks.filter((c) => c.exitCode === 0).length;
  const failed = evidence.checks.length - passed;
  evidence.summary = `${passed} passed, ${failed} failed`;

  // Submit evidence to workflow_advance (targets the active task → verify gate).
  const res = await callDaemonTool<WorkflowAdvanceResult>(opts, 'workflow_advance', { evidence });
  if (res.ok === true) {
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: res, evidence })}\n`);
      return;
    }
    success(`verify — ${evidence.summary} → gate approved`, opts);
    renderStatusRow(res as WorkflowStatusResult, opts);
    return;
  }
  // Pending / failed: render recovery options.
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ evidence, ...res })}\n`);
    return;
  }
  if (res.pendingGate) {
    warn(`verify gate: ${res.pendingGate.reason} (${evidence.summary})`, opts);
    const recovery = res.recovery ?? ['retry', 'force', 'skip', 'block'];
    info(
      `recovery: ${recovery
        .map((r) =>
          r === 'retry'
            ? '`noir task verify`'
            : r === 'force'
              ? '`noir task advance --force <reason>`'
              : r === 'skip'
                ? '`noir task advance --skip`'
                : r === 'block'
                  ? '`noir task block <reason>`'
                  : `\`${r}\``,
        )
        .join(' | ')}`,
      opts,
    );
  } else {
    fail(EXIT.ERROR, `task verify: ${res.error ?? 'verify failed'}`, opts);
  }
}
