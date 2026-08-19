// v2 — the host orchestrator (Archetype B). Drives the host agentic CLI as a
// headless subprocess and consumes its `stream-json` event stream, rather than
// Noir running its own model + tool loop (which D5 forbids).
//
// This module is the PURE, testable core:
//   - `resolveHostRun` — the spawn command for a host (custom binary wins over
//     the host default, so users with multiple profiles — e.g. `claude` vs
//     `claude-work` — can point Noir at their own binary without a restart).
//   - `parseStreamLine` / `normalizeStreamEvent` — map a raw `stream-json` line
//     to a small `NoirEvent` union (the `init`/`assistant`/`result` payloads are
//     the stable, shared contract across hosts).
//   - `UsageReducer` — accumulates token/cost with the `max usage per
//     message.id` rule (Claude emits one JSONL line PER content block of an
//     assistant message, each line's `usage` a CUMULATIVE snapshot of that
//     message — summing lines over-counts ~2.5-3x).
//   - `runHost` — the spawn + readline integration over that core.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { HostId } from '@noir-ai/adapters';
import { buildBridgeArgs, resolveCommandViaShell } from './shell-bridge.js';

/** A resolved spawn command: binary + the headless flags appended before prompt. */
export interface HostRunSpec {
  readonly binary: string;
  readonly flags: readonly string[];
}

/** Default headless binary per host. `null` = not a spawnable CLI. */
const HOST_BINARY: Record<HostId, string | null> = {
  claude: 'claude',
  gemini: 'gemini',
  opencode: 'opencode',
  cursor: 'cursor-agent',
  'agents-md': null, // emits AGENTS.md — a file host, not a spawnable CLI
};

/**
 * Headless flags per host. `claude` is the regression anchor (fully specified);
 * the others use the same `-p --output-format stream-json` contract where the
 * host supports it, and remain overridable via the custom-binary path (D2a).
 */
const HOST_FLAGS: Record<HostId, readonly string[]> = {
  claude: ['-p', '--output-format', 'stream-json', '--verbose'],
  gemini: ['-p', '--output-format', 'stream-json'],
  opencode: ['run'],
  cursor: ['-p'],
  'agents-md': [],
};

/**
 * Resolve the spawn command for `host`. `customBinary` (the user's own profile
 * command, e.g. `claude-work`) wins over the host default. Returns `null` when
 * the host has no spawnable CLI (agents-md).
 */
export function resolveHostRun(host: HostId, customBinary?: string): HostRunSpec | null {
  const binary = customBinary && customBinary.length > 0 ? customBinary : HOST_BINARY[host];
  if (!binary) return null;
  return { binary, flags: HOST_FLAGS[host] };
}

// ---------------------------------------------------------------------------
// Event normalization
// ---------------------------------------------------------------------------

/** A token-usage snapshot (the fields of the stream-json `usage` object). */
export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
}

/** The normalized event union — the shared, host-agnostic payload. */
export type NoirEvent =
  | { readonly kind: 'init'; readonly sessionId?: string; readonly model?: string }
  | {
      readonly kind: 'assistant';
      readonly messageId?: string;
      readonly text?: string;
      readonly usage?: TokenUsage;
      /** Set when the host flags the assistant message as an API error
       *  (`is_api_error_message:true` or an `error` category string) — its text
       *  is a diagnostic, never the answer. */
      readonly isError?: boolean;
      /** The host's error category string (e.g. "authentication_failed") when
       *  the assistant event carries one — used for actionable auth guidance. */
      readonly errorCategory?: string;
    }
  | {
      readonly kind: 'result';
      readonly isError: boolean;
      readonly durationMs?: number;
      readonly numTurns?: number;
      readonly totalCostUsd?: number;
      readonly usage?: TokenUsage;
    }
  | { readonly kind: 'other' };

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function usageFrom(v: unknown): TokenUsage | undefined {
  const o = asObj(v);
  if (!o) return undefined;
  const input = num(o.input_tokens);
  const output = num(o.output_tokens);
  const cache = num(o.cache_read_input_tokens) ?? num(o.cache_creation_input_tokens);
  if (input === undefined && output === undefined && cache === undefined) return undefined;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cache };
}

/** Extract the text delta from an assistant message's content (best-effort). */
function messageText(message: Record<string, unknown> | null): string | undefined {
  if (!message) return undefined;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((block) => {
        const b = asObj(block);
        return b && typeof b.text === 'string' ? (b.text as string) : null;
      })
      .filter((t): t is string => t !== null);
    if (parts.length > 0) return parts.join('');
  }
  return undefined;
}

/** Parse a raw stream-json line to a JSON value, or `null` for blank/invalid. */
export function parseStreamLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/** Normalize a raw stream-json event to a {@link NoirEvent}, or `null`. */
export function normalizeStreamEvent(raw: unknown): NoirEvent | null {
  const r = asObj(raw);
  if (!r) return null;
  const type = r.type;
  if (type === 'system') {
    if (r.subtype === 'init') {
      return { kind: 'init', sessionId: str(r.session_id), model: str(r.model) };
    }
    return { kind: 'other' };
  }
  if (type === 'assistant') {
    const message = asObj(r.message);
    return {
      kind: 'assistant',
      messageId: message ? str(message.id) : undefined,
      text: messageText(message),
      usage: message ? usageFrom(message.usage) : undefined,
      // An API error message is a diagnostic, not the answer — flag it so the
      // caller never streams it as assistant text (optional-when-true keeps
      // exact-shape consumers of the existing union intact).
      ...(r.is_api_error_message === true || typeof r.error === 'string'
        ? {
            isError: true as const,
            ...(typeof r.error === 'string' ? { errorCategory: r.error } : {}),
          }
        : {}),
    };
  }
  if (type === 'result') {
    return {
      kind: 'result',
      isError: r.is_error === true,
      durationMs: num(r.duration_ms),
      numTurns: num(r.num_turns),
      totalCostUsd: num(r.total_cost_usd),
      usage: usageFrom(r.usage),
    };
  }
  return { kind: 'other' };
}

// ---------------------------------------------------------------------------
// Usage reduction
// ---------------------------------------------------------------------------

/** A monotonic token/cost accumulator snapshot. */
export interface UsageSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalCostUsd: number;
  readonly numTurns: number;
}

/**
 * Accumulates token/cost from a `stream-json` feed with the dedup rule: take
 * the `max` usage per `message.id`, never sum lines. Claude emits one line per
 * content block of an assistant message, each carrying that message's
 * CUMULATIVE usage — so the correct per-message total is the max, and the
 * session total is the sum of per-message maxes.
 */
export class UsageReducer {
  private readonly maxByMessage = new Map<string, { input: number; output: number }>();
  private input = 0;
  private output = 0;
  private costUsd = 0;
  private turns = 0;

  /** Feed one normalized event into the reducer. */
  add(event: NoirEvent): void {
    if (event.kind === 'assistant' && event.messageId && event.usage) {
      const key = event.messageId;
      const input = event.usage.inputTokens ?? 0;
      const output = event.usage.outputTokens ?? 0;
      const prev = this.maxByMessage.get(key);
      if (!prev) {
        this.maxByMessage.set(key, { input, output });
        this.input += input;
        this.output += output;
      } else {
        // Cumulative snapshot — only the growth over the last-seen max counts.
        this.input += Math.max(0, input - prev.input);
        this.output += Math.max(0, output - prev.output);
        this.maxByMessage.set(key, {
          input: Math.max(prev.input, input),
          output: Math.max(prev.output, output),
        });
      }
    } else if (event.kind === 'result') {
      if (event.totalCostUsd !== undefined) this.costUsd = event.totalCostUsd;
      if (event.numTurns !== undefined) this.turns = event.numTurns;
    }
  }

  /** The current accumulator snapshot. */
  snapshot(): UsageSnapshot {
    return {
      inputTokens: this.input,
      outputTokens: this.output,
      totalCostUsd: this.costUsd,
      numTurns: this.turns,
    };
  }
}

// ---------------------------------------------------------------------------
// Spawn integration
// ---------------------------------------------------------------------------

export interface RunHostOptions {
  readonly host: HostId;
  readonly prompt: string;
  readonly customBinary?: string;
  /** Extra args appended after the host's headless flags (run-profile `args`). */
  readonly extraArgs?: readonly string[];
  /** Environment for the host spawn + shell fallback (defaults to process.env). */
  readonly env?: Record<string, string | undefined>;
  /** Raw stream-json line (for transcript persistence). */
  onLine?: (line: string) => void;
  /** Normalized event (for streaming render). */
  onEvent?: (event: NoirEvent) => void;
}

export interface RunHostResult {
  readonly exitCode: number;
  readonly usage: UsageSnapshot;
  readonly eventCount: number;
  /** Host stderr (surfaced on a non-zero exit so errors are not swallowed). */
  readonly stderr: string;
  /** Whether the host signalled an error (non-zero exit OR a stream-json
   *  `is_error:true` result / API-error assistant event). Exit code alone is
   *  not reliable — claude can exit 0 with `is_error:true` (#79500). */
  readonly isError: boolean;
  /** The first API-error assistant text (e.g. "Not logged in · Please run
   *  /login"), quoted into the CLI's failure message. */
  readonly errorText?: string;
  /** The first API-error category (e.g. "authentication_failed"), for
   *  actionable auth guidance in the CLI. */
  readonly errorCategory?: string;
}

/**
 * Spawn the host headless and consume its `stream-json` over a stdio pipe.
 * Rejects when the host has no spawnable CLI or the binary fails to spawn;
 * otherwise resolves with the exit code + the reduced usage snapshot.
 */
export function runHost(opts: RunHostOptions): Promise<RunHostResult> {
  const spec = resolveHostRun(opts.host, opts.customBinary);
  if (!spec) {
    return Promise.reject(
      new Error(`host '${opts.host}' is not a spawnable CLI (no default command)`),
    );
  }
  return spawnAndConsume(
    spec.binary,
    [...spec.flags, ...(opts.extraArgs ?? []), opts.prompt],
    opts,
    false,
  );
}

/**
 * Spawn `binary` with `args` and consume its stream-json. On an ENOENT spawn
 * error (and not already a shell-bridge run) it attempts the shell fallback:
 * the name may be an alias/function or a PATH entry only visible inside the
 * user's interactive shell — see `shell-bridge.ts` for the safety model.
 */
function spawnAndConsume(
  binary: string,
  args: readonly string[],
  opts: RunHostOptions,
  shellRun: boolean,
): Promise<RunHostResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.env ? { env: opts.env as NodeJS.ProcessEnv } : {}),
    });
    const reducer = new UsageReducer();
    let eventCount = 0;
    let stderrBuf = '';
    let errored = false;
    let errorText: string | undefined;
    let errorCategory: string | undefined;
    // A failed spawn fires BOTH 'error' and 'close' (close with a synthetic
    // code like -2). The 'close' handler must defer to the 'error' path so the
    // shell fallback (or the rejection) owns the resolution, never a -2 result.
    let spawnError: unknown = null;

    child.on('error', (err) => {
      spawnError = err;
      if (!shellRun && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        void shellFallback(binary, args, opts, resolve, reject, err);
        return;
      }
      reject(err);
    });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      opts.onLine?.(line);
      const raw = parseStreamLine(line);
      if (raw === null) return;
      const event = normalizeStreamEvent(raw);
      if (event === null) return;
      eventCount += 1;
      if (event.kind === 'assistant' && event.isError === true) {
        errored = true;
        if (errorText === undefined && event.text && event.text.length > 0) errorText = event.text;
        if (errorCategory === undefined && event.errorCategory) errorCategory = event.errorCategory;
      } else if (event.kind === 'result' && event.isError === true) {
        errored = true;
      }
      reducer.add(event);
      opts.onEvent?.(event);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    child.on('close', (code) => {
      if (spawnError !== null) return; // the error/fallback path owns this spawn
      resolve({
        exitCode: code ?? 0,
        usage: reducer.snapshot(),
        eventCount,
        stderr: stderrBuf,
        isError: errored,
        errorText,
        errorCategory,
      });
    });
  });
}

/**
 * ENOENT shell-bridge attempt: probe the user's shell for `binary`; respawn the
 * resolved absolute path directly, or bridge an alias/function via the shell
 * (prompt + flags travel only as argv). On any failure re-reject the original
 * ENOENT so run.ts builds the friendly "no executable found" message.
 */
async function shellFallback(
  binary: string,
  args: readonly string[],
  opts: RunHostOptions,
  resolve: (r: RunHostResult) => void,
  reject: (e: unknown) => void,
  originalErr: unknown,
): Promise<void> {
  try {
    const res = await resolveCommandViaShell(binary, { env: opts.env ?? process.env });
    if (res.kind === 'path') {
      resolve(await spawnAndConsume(res.path, args, opts, true));
      return;
    }
    if (res.kind === 'alias' || res.kind === 'function') {
      const bridge = buildBridgeArgs(binary, args, res.shell);
      resolve(await spawnAndConsume(bridge.binary, bridge.args, opts, true));
      return;
    }
  } catch {
    // fall through to the original ENOENT below
  }
  reject(originalErr);
}
