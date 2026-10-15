import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DenyRule,
  evaluateDeny,
  type NoirConfig,
  paths,
  readProjectConfig,
} from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { WorkflowEngine } from '@noir-ai/workflow';
import { EXIT } from '../output.js';

/**
 * `noir hook` — the host-invoked lifecycle-hook dispatcher.
 *
 * The scaffold writes per-host hook entries that call `noir hook --host <id>`
 * and pipe a JSON object to stdin describing the event. This command reads it,
 * loads the project's `enforcement` config from `.noir/config.yml`, and emits
 * the host's own decision dialect:
 *
 *  - `SessionStart`/`SubagentStart` — inject a compiled, budgeted brief
 *    (router + always-on rules) as `additionalContext`. The project baseline
 *    reaches the model through the host's own `@import` of `.noir/NOIR.md`, so
 *    it is not re-injected here.
 *  - `PreToolUse` — evaluate the deny-list and deny a violating call.
 *  - `Stop` — block stopping while the active task's verification is pending
 *    (opt-in via `enforcement.stopGate`).
 *  - anything else — pass through with exit 0.
 *
 * A hook must never fail the session: every read is best-effort, enforcement
 * fails OPEN (an unknown event, a missing file, or an unreadable store never
 * blocks), and the command always emits valid JSON or nothing.
 */

const BRIEF_BUDGET = 9000; // chars — under the host's 10,000-char additionalContext cap.

export type DialectHost = 'claude' | 'gemini' | 'cursor';

export interface HookInput {
  hook_event_name?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  session_id?: string;
  transcript_path?: string;
  [key: string]: unknown;
}

export interface EnforcementConfig {
  enabled: boolean;
  deny: DenyRule[];
  stopGate: boolean;
}

export interface HookDispatchResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

/** Walk up from `root` to the directory that owns a `.noir/`, or null. */
export function findNoirRoot(root: string): string | null {
  for (let dir = root; ; dir = join(dir, '..')) {
    if (existsSync(join(dir, '.noir'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) return null;
  }
}

/** Read a `.noir/` file best-effort; returns '' when absent or unreadable. */
function readNoirFile(noirRoot: string, rel: string): string {
  try {
    return readFileSync(join(noirRoot, rel), 'utf8').trim();
  } catch {
    return '';
  }
}

/** The compiled, budgeted session brief: the router + the always-on rules — the
 *  two `.noir/` files no host context file `@import`s. The project baseline
 *  lives in `.noir/NOIR.md`, which every host already loads via its context
 *  file, so it is not re-injected here. Truncates under the injection cap. */
export function compileBrief(noirRoot: string): string {
  const parts = [
    readNoirFile(noirRoot, '.noir/router.md'),
    readNoirFile(noirRoot, '.noir/rules/anti-slop.md'),
  ].filter((text) => text !== '');
  const brief = parts.join('\n\n');
  return brief.length <= BRIEF_BUDGET
    ? brief
    : `${brief.slice(0, BRIEF_BUDGET)}\n\n(context truncated)`;
}

/** Resolve the enforcement config, applying the schema defaults when absent. */
function resolveEnforcement(cfg: NoirConfig | undefined): EnforcementConfig {
  return {
    enabled: cfg?.enforcement?.enabled ?? true,
    deny: cfg?.enforcement?.deny ?? [],
    stopGate: cfg?.enforcement?.stopGate ?? false,
  };
}

/** Map a host's event spelling to a canonical kind. Each host names its events
 *  differently (claude: SessionStart/PreToolUse/Stop; gemini: SessionStart/
 *  BeforeTool; cursor: sessionStart/preToolUse/stop), but they mean the same
 *  three behaviors. Case-insensitive so cursor's lowercase names match. */
function canonicalEvent(event: string): 'inject' | 'subagent' | 'pre-tool' | 'stop' | 'unknown' {
  const e = event.toLowerCase();
  if (e === 'sessionstart') return 'inject';
  if (e === 'subagentstart') return 'subagent';
  if (e === 'pretooluse' || e === 'beforetool') return 'pre-tool';
  if (e === 'stop') return 'stop';
  return 'unknown';
}

/**
 * The pure, testable dispatch. Given the parsed hook input, the host dialect,
 * the resolved enforcement config, and a precomputed Stop-gate decision (from
 * {@link stopGateDecision}), returns the process result. Never throws.
 */
export function dispatch(
  input: HookInput,
  host: DialectHost,
  enforcement: EnforcementConfig,
  stopGate: { block: true; reason: string } | null,
): HookDispatchResult {
  const event = input.hook_event_name ?? 'SessionStart';
  const kind = canonicalEvent(event);

  if (kind === 'inject' || kind === 'subagent') {
    const brief = compileBrief(findNoirRoot(input.cwd ?? process.cwd()) ?? process.cwd());
    if (host === 'cursor') {
      return brief === ''
        ? { exitCode: 0 }
        : { exitCode: 0, stdout: JSON.stringify({ additional_context: brief }) };
    }
    const envelope: Record<string, unknown> = { hookEventName: event };
    if (brief !== '') envelope.additionalContext = brief;
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: envelope }) };
  }

  if (kind === 'pre-tool') {
    if (!enforcement.enabled) return { exitCode: 0 };
    const denied = evaluateDeny(enforcement.deny, input.tool_name ?? '', input.tool_input);
    if (!denied) return { exitCode: 0 };
    if (host === 'claude') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: denied.reason,
          },
        }),
      };
    }
    // gemini/cursor: the verified reason-carrying block is exit 2 + stderr.
    return { exitCode: 2, stderr: denied.reason };
  }

  if (kind === 'stop') {
    if (enforcement.enabled && enforcement.stopGate && stopGate && host === 'claude') {
      return {
        exitCode: 0,
        stdout: JSON.stringify({ decision: 'block', reason: stopGate.reason }),
      };
    }
    return { exitCode: 0 };
  }

  return { exitCode: 0 };
}

/**
 * The opt-in Stop gate: block when the active workflow task is still at or
 * before the verify gate (implementation done but verification pending). Reads
 * the store read-only; fails open on any error.
 */
export async function stopGateDecision(
  root: string,
): Promise<{ block: true; reason: string } | null> {
  try {
    const projectId = readFileSync(paths.projectId(root), 'utf8').trim();
    if (projectId === '') return null;
    const store = await openStore({ projectId, root, readonly: true });
    const engine = new WorkflowEngine(store, root, projectId);
    const taskId = engine.activeTaskId();
    if (!taskId) return null;
    const task = engine.status(taskId);
    if (!task) return null;
    if (task.state === 'done' || task.state === 'abandoned' || task.state === 'blocked') {
      return null;
    }
    if (task.phase === 'execute') {
      return {
        block: true,
        reason:
          'implementation is in progress — finish it and run `noir task verify` before stopping',
      };
    }
    if (task.phase === 'verify') {
      return {
        block: true,
        reason: 'verification is pending — run `noir task verify` before stopping',
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse the `--host` flag into a dialect, defaulting to claude. */
function resolveHost(hostArg: string | undefined): DialectHost {
  if (hostArg === 'gemini' || hostArg === 'cursor') return hostArg;
  return 'claude';
}

/** The async entry point `bin.ts` wires to `noir hook`. */
export async function hook(hostArg?: string): Promise<void> {
  // The host always pipes a JSON event on stdin, so an interactive TTY stdin
  // means a human ran `noir hook` directly — it would otherwise block waiting on
  // stdin, or (when stdin is empty and non-TTY) silently default to a
  // SessionStart injection. Point at the real user-facing command instead.
  if (process.stdin.isTTY) {
    process.stderr.write(
      '`noir hook` is the host-invoked lifecycle dispatcher, not a user command. Did you mean `noir hooks sync`?\n',
    );
    process.exitCode = EXIT.USAGE;
    return;
  }
  const host = resolveHost(hostArg);
  let input: HookInput = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  } catch {
    // No stdin or not JSON — the host always sends it, but never crash here.
  }

  const root = findNoirRoot(input.cwd ?? process.cwd()) ?? process.cwd();
  const enforcement = resolveEnforcement(readProjectConfig(root));

  let stopGate: { block: true; reason: string } | null = null;
  if (
    enforcement.enabled &&
    canonicalEvent(input.hook_event_name ?? '') === 'stop' &&
    enforcement.stopGate
  ) {
    stopGate = await stopGateDecision(root);
  }

  const result = dispatch(input, host, enforcement, stopGate);
  if (result.stderr !== undefined) process.stderr.write(result.stderr);
  if (result.stdout !== undefined) process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}
