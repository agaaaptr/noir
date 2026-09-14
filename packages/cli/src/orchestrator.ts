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
import { constants } from 'node:os';
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
 * host supports it, and remain overridable via the custom-binary path.
 *
 * `--include-partial-messages` is what turns the stream from "one frame per
 * content block" into "one frame per token": the host then emits `stream_event`
 * frames carrying each tool call as it starts and each stretch of assistant text
 * as it is written. A caller that renders live (the TUI's run screen, the
 * terminal status line) needs those frames to show progress while the answer is
 * still being produced, rather than only once a whole block has landed.
 */
const HOST_FLAGS: Record<HostId, readonly string[]> = {
  claude: ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'],
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
      /**
       * The tool calls the message made alongside its text, in the order it
       * made them. A consumer that renders tools must show these: a host that
       * streams no partial messages has no other way to say that a message
       * which said something also called something.
       */
      readonly tools?: readonly string[];
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
  /**
   * A tool call the host started. Carries no result text: it exists so a live
   * render can show WHAT the host is doing while it does it, which is the only
   * progress signal available between two stretches of assistant text.
   * `messageId`/`usage` are present when the tool call was read out of a
   * completed assistant message (a host that reports no partial stream), so
   * that message's tokens are still accounted for.
   */
  | {
      readonly kind: 'tool';
      readonly name: string;
      readonly messageId?: string;
      readonly usage?: TokenUsage;
    }
  /**
   * A stretch of assistant text as it is written. Provisional by construction:
   * the host re-reports the same words in the completed `assistant` message
   * that closes the block, so a consumer that renders both must reconcile them
   * rather than concatenating.
   */
  | { readonly kind: 'delta'; readonly text: string }
  /** A frame the normalizer does not model. `subtype` names what was dropped. */
  | { readonly kind: 'other'; readonly subtype?: string };

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Map a POSIX signal name (e.g. "SIGKILL") to its numeric value, else undefined. */
function signalNumber(signal: NodeJS.Signals): number | undefined {
  const n = (constants.signals as Record<string, number>)[signal];
  return typeof n === 'number' ? n : undefined;
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

/** What an assistant message's content carries, split by kind. */
interface MessageContent {
  /** The concatenated text blocks, when the message has any. */
  readonly text?: string;
  /** The names of the tool calls the message made, in order. */
  readonly tools?: readonly string[];
}

/**
 * Split an assistant message's content into its text and its tool calls.
 *
 * A message can be either, and a tool-only message carries no text at all —
 * which is why an empty text result must not be read as "nothing happened": a
 * turn whose whole content is a tool call is the common case in an agentic run,
 * and the caller needs the tool's name to show what the host is doing.
 */
function messageContent(message: Record<string, unknown> | null): MessageContent {
  if (!message) return {};
  const content = message.content;
  if (typeof content === 'string') return { text: content };
  if (!Array.isArray(content)) return {};
  const parts: string[] = [];
  const tools: string[] = [];
  for (const block of content) {
    const b = asObj(block);
    if (!b) continue;
    if (typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name);
  }
  return {
    ...(parts.length > 0 ? { text: parts.join('') } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
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
    return { kind: 'other', subtype: str(r.subtype) ?? 'system' };
  }
  if (type === 'assistant') {
    const message = asObj(r.message);
    const content = messageContent(message);
    const messageId = message ? str(message.id) : undefined;
    const usage = message ? usageFrom(message.usage) : undefined;
    const error = {
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
    // A message with text reports text; one whose whole content is a tool call
    // reports the call, with the message's usage riding along so the turn is
    // still counted (a tool-only message is often the only carrier of its own
    // message id). A message that does both reports both: the text is the
    // answer and the call is what the host went on to do, and dropping the call
    // here would leave a host with no partial feed showing a turn that looks
    // like it only talked.
    if (content.text !== undefined) {
      return {
        kind: 'assistant',
        messageId,
        text: content.text,
        usage,
        ...(content.tools === undefined ? {} : { tools: content.tools }),
        ...error,
      };
    }
    if (content.tools !== undefined) {
      // One announcement per message, naming its first tool call. The host
      // writes one content block per line, so this is the whole message; a host
      // that packs several calls into one message still reports each of them
      // separately on the incremental feed.
      return { kind: 'tool', name: content.tools[0] as string, messageId, usage };
    }
    return { kind: 'assistant', messageId, usage, ...error };
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
  if (type === 'stream_event') {
    return normalizeStreamEventInner(asObj(r.event));
  }
  return { kind: 'other', ...(typeof type === 'string' ? { subtype: type } : {}) };
}

/**
 * Normalize one frame of a `stream_event` (the incremental feed a host emits
 * when it is asked for partial messages). Only the two frames that carry live
 * progress are modelled — a tool call as it starts, and a stretch of assistant
 * text as it is written; the boundary frames around them are noise.
 */
function normalizeStreamEventInner(inner: Record<string, unknown> | null): NoirEvent {
  if (!inner) return { kind: 'other', subtype: 'stream_event' };
  const innerType = str(inner.type);
  if (innerType === 'content_block_start') {
    const block = asObj(inner.content_block);
    const name = block ? str(block.name) : undefined;
    if (block && str(block.type) === 'tool_use' && name !== undefined) {
      return { kind: 'tool', name };
    }
  }
  if (innerType === 'content_block_delta') {
    const delta = asObj(inner.delta);
    const text = delta ? str(delta.text) : undefined;
    if (delta && delta.type === 'text_delta' && text !== undefined) {
      return { kind: 'delta', text };
    }
  }
  return { kind: 'other', subtype: innerType ?? 'stream_event' };
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
    if (event.kind === 'result') {
      if (event.totalCostUsd !== undefined) this.costUsd = event.totalCostUsd;
      if (event.numTurns !== undefined) this.turns = event.numTurns;
      return;
    }
    // A tool announcement carries the usage of the message it came out of, and
    // for a tool-only message it is the only carrier — so it folds through the
    // same per-message rule rather than being dropped. The rule itself is
    // unchanged: one entry per message id, taking the max.
    const usage = event.kind === 'assistant' || event.kind === 'tool' ? event.usage : undefined;
    const key = event.kind === 'assistant' || event.kind === 'tool' ? event.messageId : undefined;
    if (!key || !usage) return;
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const prev = this.maxByMessage.get(key);
    if (!prev) {
      this.maxByMessage.set(key, { input, output });
      this.input += input;
      this.output += output;
      return;
    }
    // Cumulative snapshot — only the growth over the last-seen max counts.
    this.input += Math.max(0, input - prev.input);
    this.output += Math.max(0, output - prev.output);
    this.maxByMessage.set(key, {
      input: Math.max(prev.input, input),
      output: Math.max(prev.output, output),
    });
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

/**
 * A host child a caller can stop, as the cancel path sees it: what `spawn`
 * returns, narrowed to the three things a kill ladder needs. A caller that has
 * this handle can stop THAT process, rather than hoping a signal reaches it.
 */
export interface HostChild {
  readonly pid?: number;
  /** Send it a signal. False when it is already gone. */
  kill(signal?: NodeJS.Signals): boolean;
  /** Fires when it is reaped, which is when the handle stops being useful. */
  once(event: 'exit', listener: () => void): unknown;
}

/**
 * Signal a child — the one and only safe way to do it.
 *
 * A spawn that failed (ENOENT, a bad interpreter) produces a handle with no
 * pid, and signalling that is NOT a harmless no-op: Node hands pid 0 to
 * `kill(2)`, which means "every process in my own process group". So an
 * unguarded `child.kill()` while a bad command is failing would take out Noir,
 * whatever shares its job (a pipeline peer, a wrapper script) and the terminal
 * job around them — the opposite of stopping one host. Callers that skip the
 * pid check are the bug; this is the check.
 */
export function signalChild(child: HostChild, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  child.kill(signal);
}

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
  /**
   * The child, as soon as it exists — and again for every later spawn of the
   * same run, because a command resolved through the shell bridge is a second
   * child. Handing it over is what lets a caller kill the process itself: a
   * signal that reached Noir is not otherwise addressed to the host it spawned.
   */
  onChild?: (child: HostChild) => void;
  /**
   * Cancel the run: aborting this sends the host child a `SIGTERM`. A signal
   * that is already aborted kills the child as soon as it spawns, so a caller
   * that raced its own cancellation does not leak a process. Escalation (a
   * SIGKILL for a host that ignores the polite signal) is the caller's, not
   * this function's — the run still resolves through the ordinary close path
   * with the kill folded into its result.
   */
  signal?: AbortSignal;
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
    opts.onChild?.(child);
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

    // Cancellation. The listener is dropped the moment the child is gone, so a
    // controller reused across runs does not accumulate dead children.
    const { signal } = opts;
    const onAbort = (): void => {
      signalChild(child, 'SIGTERM');
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const detachAbort = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (err) => {
      spawnError = err;
      detachAbort();
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

    child.on('close', (code, signal) => {
      detachAbort();
      if (spawnError !== null) return; // the error/fallback path owns this spawn
      // A host terminated by a signal (crash/SIGKILL/OOM) yields code === null
      // with no result event — without this it would be reported as exit 0
      // success. Fold the kill into a non-zero exit + isError (128+n is the
      // shell convention for signal termination).
      const killed = code === null && signal != null;
      resolve({
        exitCode: killed ? 128 + (signalNumber(signal) ?? 0) : (code ?? 0),
        usage: reducer.snapshot(),
        eventCount,
        stderr: stderrBuf,
        isError: errored || killed,
        errorText: killed && errorText === undefined ? `terminated by signal ${signal}` : errorText,
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
