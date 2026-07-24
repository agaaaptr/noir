// S9 t2 — centralized output + exit-code infrastructure for `@noir-ai/cli`.
//
// Stream discipline (S9 DS-4): machine-readable data → stdout; every other
// diagnostic (progress, warnings, errors, tables, help) → stderr. Under `--json`
// the decorated stderr helpers are silenced so stdout stays pristine JSON, and
// `fail()` emits a structured `{ok:false,error}` envelope to stdout instead.
//
// Decoration (picocolors / cli-table3 / ora) auto-disables under `--json`,
// `--quiet`, `CI`, `NO_COLOR`, or a non-TTY, so the same code path is safe in an
// interactive shell, a pipe, and CI.
//
// Exit codes (S9 DS-4): 0 ok · 1 error · 2 usage · 3 not-found · 4 daemon-down ·
// 5 cancelled. These constants live HERE (the single source of truth); bin.ts
// re-exports them so existing imports from `./bin.js` keep working.

import Table from 'cli-table3';
import { CommanderError } from 'commander';
import ora, { type Ora } from 'ora';
import pc from 'picocolors';

// ---------------------------------------------------------------------------
// Exit-code contract + error types
// ---------------------------------------------------------------------------
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  DAEMON_DOWN: 4,
  CANCELLED: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Application-level CLI error carrying an S9 exit code. Thrown directly by
 * bin.ts for legacy usage paths; `fail()` is the ergonomic throw helper.
 * `inferExitCode` / `handleError` map it onto `process.exitCode`.
 */
export class NoirCliError extends Error {
  readonly exitCode: number;
  constructor(exitCode: number, message: string) {
    super(message);
    this.name = 'NoirCliError';
    this.exitCode = exitCode;
  }
}

/**
 * The `code` stamped onto every CommanderError our own `fail()` throws, so
 * `inferExitCode` can tell "we threw this on purpose with an authoritative
 * exitCode" apart from "commander threw this for help/usage/unknown-command"
 * (which must be remapped onto the S9 contract by `commanderExitCode`).
 */
const NOIR_ERROR_CODE = 'noir.error';

// ---------------------------------------------------------------------------
// Global-option shape. Commander stores `--no-input` under the attribute
// `input` (default `true`; the flag sets it `false`) — see commander's
// `Option.attributeName()` which strips the leading `no-`. Both `input`
// (commander's real key) and `noInput` (the spec's intent) are accepted so
// callers may pass either commander's raw globals or a hand-built object.
// ---------------------------------------------------------------------------
export interface CliOptions {
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly verbose?: boolean;
  /** Commander's storage for `--no-input` (`false` ⇒ no input). */
  readonly input?: boolean;
  /** Convenience alias matching the `--no-input` intent (`true` ⇒ no input). */
  readonly noInput?: boolean;
}

function isJsonMode(opts: CliOptions): boolean {
  return opts.json === true;
}

function isQuietMode(opts: CliOptions): boolean {
  return opts.quiet === true;
}

/** True when the user has asked for no interactive input (either spelling). */
export function isNoInput(opts: CliOptions = {}): boolean {
  return opts.noInput === true || opts.input === false;
}

function envFlagSet(name: string): boolean {
  // NO_COLOR spec: present AND non-empty (regardless of value) disables color.
  const v = process.env[name];
  return v !== undefined && v !== '';
}

function isCiEnv(): boolean {
  // CI conventions: set to `true`, `1`, or a server name. Treat explicit
  // opt-outs ("0"/"false") as "not CI" so users can force-disable the guard.
  const v = process.env.CI;
  if (v === undefined || v === '') return false;
  return v !== '0' && v !== 'false';
}

// ---------------------------------------------------------------------------
// Interactivity gate (DS-3/DS-7). Drives both the @clack home menu and the
// decoration of every helper below. Requires BOTH stdin and stdout to be TTYs:
// @clack reads keypresses from stdin while ora/picocolors render to stdout.
// ---------------------------------------------------------------------------
export function isInteractive(opts: CliOptions = {}): boolean {
  if (isJsonMode(opts) || isNoInput(opts)) return false;
  if (isCiEnv() || envFlagSet('NO_COLOR')) return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

// ---------------------------------------------------------------------------
// Data output (stdout). The ONLY helper here that writes to stdout; under
// `--json` a command calls this exactly once with its full payload and never
// mixes other stdout writes, keeping machine output pristine.
// ---------------------------------------------------------------------------
export function json(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// ---------------------------------------------------------------------------
// Human diagnostics (stderr). picocolors auto-strips ANSI under NO_COLOR /
// non-TTY, and each helper additionally short-circuits under `--json`
// (decoration off, payload is the output) — and `info`/`log`/`success` also
// under `--quiet`. `warn`/`error` survive `--quiet` (they carry signal).
// ---------------------------------------------------------------------------
export function log(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts) || isQuietMode(opts)) return;
  process.stderr.write(`${msg}\n`);
}

export function info(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts) || isQuietMode(opts)) return;
  process.stderr.write(`${pc.cyan(msg)}\n`);
}

export function success(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts) || isQuietMode(opts)) return;
  process.stderr.write(`${pc.green(msg)}\n`);
}

export function warn(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts)) return;
  process.stderr.write(`${pc.yellow(msg)}\n`);
}

export function error(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts)) return;
  process.stderr.write(`${pc.red(msg)}\n`);
}

// ---------------------------------------------------------------------------
// Tables (stderr). Suppressed entirely under `--json` — the command has
// already emitted the rows as a JSON array via `json()`. cli-table3 itself is
// isTTY-aware, but we gate it here so JSON pipes never see table text.
// ---------------------------------------------------------------------------
export function table(
  rows: readonly Record<string, unknown>[],
  cols: readonly string[],
  opts: CliOptions = {},
): void {
  if (isJsonMode(opts)) return;
  if (rows.length === 0) {
    info('(no rows)', opts);
    return;
  }
  const t = new Table({ head: [...cols] });
  for (const row of rows) {
    t.push(cols.map((col) => formatCell(row[col])));
  }
  process.stderr.write(`${t.toString()}\n`);
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Spinner (stderr). ora when interactive; a no-op otherwise so scriptable /
// CI / `--json` / `--quiet` runs pay nothing and never animate a pipe.
// ---------------------------------------------------------------------------
export interface Spinner {
  start(text?: string): Spinner;
  stop(): Spinner;
  clear(): Spinner;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  info(text?: string): void;
  text: string;
}

class NoopSpinner implements Spinner {
  text = '';
  start(_text?: string): Spinner {
    return this;
  }
  stop(): Spinner {
    return this;
  }
  clear(): Spinner {
    return this;
  }
  succeed(_text?: string): void {}
  fail(_text?: string): void {}
  warn(_text?: string): void {}
  info(_text?: string): void {}
}

/** Wraps an `ora` instance so the `Spinner` interface stays decoupled from ora's exact type. */
class OraSpinner implements Spinner {
  private readonly handle: Ora;

  constructor(initialText: string) {
    this.handle = ora(initialText);
  }

  get text(): string {
    return this.handle.text;
  }
  set text(value: string) {
    this.handle.text = value;
  }

  start(text?: string): Spinner {
    if (text !== undefined) this.handle.text = text;
    this.handle.start();
    return this;
  }

  stop(): Spinner {
    this.handle.stop();
    return this;
  }

  clear(): Spinner {
    this.handle.clear();
    return this;
  }

  succeed(text?: string): void {
    this.handle.succeed(text);
  }

  fail(text?: string): void {
    this.handle.fail(text);
  }

  warn(text?: string): void {
    this.handle.warn(text);
  }

  info(text?: string): void {
    this.handle.info(text);
  }
}

export function spinner(text = '', opts: CliOptions = {}): Spinner {
  if (isJsonMode(opts) || isQuietMode(opts) || !isInteractive(opts)) {
    return new NoopSpinner();
  }
  return new OraSpinner(text);
}

// ---------------------------------------------------------------------------
// Failure + exit-code mapping
// ---------------------------------------------------------------------------

/**
 * Write a diagnostic and throw a `CommanderError` carrying the S9 exit code,
 * so bin.ts's `exitOverride` + `handleError` surface it as `process.exitCode`
 * without any mid-action `process.exit`. Under `--json` the message becomes a
 * structured `{ok:false,error}` envelope on STDOUT; otherwise plain text on
 * STDERR. Always throws (`never`).
 */
export function fail(exitCode: number, message: string, opts: CliOptions = {}): never {
  if (isJsonMode(opts)) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: { code: exitCode, message } })}\n`);
  } else if (message.length > 0) {
    process.stderr.write(`${message}\n`);
  }
  throw new CommanderError(exitCode, NOIR_ERROR_CODE, message);
}

/**
 * Guard for commands that would otherwise block on a prompt. Honors the S9
 * hard rule: "no blocking prompts when !isTTY or --no-input — error exit 2
 * naming the missing flag instead". `hint` describes the operation so the
 * message points the user at the flag-based alternative.
 */
export function requireInteractive(opts: CliOptions, hint: string): void {
  if (!isInteractive(opts)) {
    fail(
      EXIT.USAGE,
      `${hint} needs an interactive terminal, but input is disabled (non-TTY, --no-input, --json, CI, or NO_COLOR). Re-run in a TTY or supply the value as a flag.`,
      opts,
    );
  }
}

// Remap commander's own exit codes onto the S9 contract:
//   help/version → 0 · unknown command → 3 · every other usage error → 2
function commanderExitCode(err: CommanderError): number {
  switch (err.code) {
    case 'commander.helpDisplayed':
    case 'commander.versionDisplayed':
      return EXIT.OK;
    case 'commander.unknownCommand':
      return EXIT.NOT_FOUND;
    default:
      return EXIT.USAGE;
  }
}

/** Map any thrown value onto the S9 exit-code contract. */
export function inferExitCode(err: unknown): number {
  if (err instanceof NoirCliError) return err.exitCode;
  if (err instanceof CommanderError) {
    // Errors our own `fail()` threw carry a `noir.*` code and an authoritative
    // exitCode — respect it. Commander's own errors are remapped by `code`.
    if (err.code.startsWith('noir.')) return err.exitCode;
    return commanderExitCode(err);
  }
  return EXIT.ERROR;
}

/**
 * Map a thrown error onto stderr + `process.exitCode`. Never throws, never
 * calls `process.exit` (commander's `exitOverride` already prevented that for
 * commander's own errors). Used by the bin entry's `run()`.
 */
export function handleError(err: unknown): void {
  if (err instanceof NoirCliError) {
    if (err.message.length > 0) process.stderr.write(`${err.message}\n`);
  } else if (err instanceof CommanderError) {
    // If `fail()` threw it, the message is already written (stderr or the JSON
    // stdout envelope); if commander threw it, `configureOutput.writeErr`
    // already wrote it during parse. Don't double-write either way.
  } else {
    process.stderr.write(`noir: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exitCode = inferExitCode(err);
}
