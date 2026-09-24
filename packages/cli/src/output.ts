// Centralized output + exit-code infrastructure for `@noir-ai/cli`.
//
// Stream discipline: machine-readable data → stdout; every other
// diagnostic (progress, warnings, errors, tables, help) → stderr. Under `--json`
// the decorated stderr helpers are silenced so stdout stays pristine JSON, and
// `fail()` emits a structured `{ok:false,error}` envelope to stdout instead.
//
// Decoration (picocolors / cli-table3 / ora) auto-disables under `--json`,
// `--quiet`, `CI`, `NO_COLOR`, or a non-TTY, so the same code path is safe in an
// interactive shell, a pipe, and CI. The `--quiet` half is enforced by the
// colour authority itself: bin.ts's `preAction` bridges the flag to `NOIR_QUIET`,
// which `theme.useColor()` reads, so a quiet run emits no ANSI even where a
// string is coloured without consulting this module's `opts`.
//
// Exit codes: 0 ok · 1 error · 2 usage · 3 not-found · 4 daemon-down ·
// 5 cancelled · 130/143 interrupted (128 + the signal that stopped the run:
// SIGINT and SIGTERM). The first six are the `EXIT` enum below; the interrupt
// codes come from the run's own stop path, not from `fail()`'s contract. These
// constants live HERE (the single source of truth); bin.ts re-exports them so
// existing imports from `./bin.js` keep working.

import Table from 'cli-table3';
import { CommanderError } from 'commander';
import ora, { type Ora } from 'ora';
import { c, isCiEnv, terminalWidth } from './theme.js';
import { displayWidth, truncateMiddle, truncateToWidth } from './width.js';

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
 * Application-level CLI error carrying a contracted exit code. Thrown directly by
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
 * (which must be remapped onto the CLI exit-code contract by `commanderExitCode`).
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
  /** TUI-policy flag. `false` (`--no-tui`) forces bare `noir` onto the
   *  non-interactive `status` path even in a TTY; `true` (`--tui`) is an
   *  advisory hint that still requires a TTY; absent (auto) defers to
   *  {@link isInteractive}. Advisory only — never hard-gates a subcommand. */
  readonly tui?: boolean;
  /** Hint-suppression flag (`--no-tips`). When `true`, redirect /
   *  deprecation hints (and any other {@link tip} output) are silenced for
   *  CI / log-friendly runs. */
  readonly noTips?: boolean;
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

// `isCiEnv` is imported from ./theme.js (the color authority) — see note there.

// ---------------------------------------------------------------------------
// Interactivity gate. Drives both the @clack home menu and the
// decoration of every helper below. Requires BOTH stdin and stdout to be TTYs:
// @clack reads keypresses from stdin while ora/picocolors render to stdout.
// ---------------------------------------------------------------------------
export function isInteractive(opts: CliOptions = {}): boolean {
  if (isJsonMode(opts) || isNoInput(opts)) return false;
  if (isCiEnv() || envFlagSet('NO_COLOR')) return false;
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Derive the explicit `interactive` flag the scaffold engine reads (via
 * {@link ScaffoldOptions.interactive}) from the bridge bin.ts owns. The bin's
 * `preAction` sets `NOIR_NON_INTERACTIVE=1` under `--json`/`--no-input`; this
 * helper folds that with the {@link isInteractive} TTY/CI/NO_COLOR gate so a
 * single boolean flows into the engine + `buildConflictOpts`. The ENGINE itself
 * never reads `process.env` for interactivity — only this CLI helper does.
 */
export function resolveInteractive(): boolean {
  if (flaggedNonInteractiveCli()) return false;
  return isInteractive();
}

/** True when the bin's `preAction` flagged this invocation non-interactive
 *  (`--json` / `--no-input` → `NOIR_NON_INTERACTIVE`). CLI-internal; the engine
 *  reads {@link ScaffoldOptions.interactive} instead. */
function flaggedNonInteractiveCli(): boolean {
  const v = process.env.NOIR_NON_INTERACTIVE;
  return v !== undefined && v !== '';
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
  process.stderr.write(`${c.info(msg)}\n`);
}

export function success(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts) || isQuietMode(opts)) return;
  process.stderr.write(`${c.ok(msg)}\n`);
}

export function warn(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts)) return;
  process.stderr.write(`${c.warn(msg)}\n`);
}

export function error(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts)) return;
  process.stderr.write(`${c.error(msg)}\n`);
}

/**
 * Redirect / deprecation hint (stderr). Silenced under `--json` (a CI
 * consumer's stdout envelope must stay pristine) AND under `--no-tips`
 * ({@link CliOptions.noTips}). This is the ONLY helper deprecation / redirect
 * notices should use, so a single `--no-tips` flag quiets them all in CI / logs.
 * Style matches {@link warn} (these are advisory, not errors).
 */
export function tip(msg: string, opts: CliOptions = {}): void {
  if (isJsonMode(opts) || opts.noTips === true) return;
  process.stderr.write(`${c.warn(msg)}\n`);
}

// ---------------------------------------------------------------------------
// Tables (stderr). Suppressed entirely under `--json` — the command has
// already emitted the rows as a JSON array via `json()`.
//
// Design: cli-table3 styles headers/borders via `@colors/colors`
// (whose NO_COLOR/TTY semantics differ from picocolors), which painted EVERY
// header red while the body stripped — RED is now reserved strictly for ERROR.
// We bypass `@colors/colors` entirely by passing EMPTY `style.head`/`style.border`
// arrays (cli-table3's `wrapWithStyleColors` early-returns on length 0) and
// PRE-COLOR the header strings ourselves via `theme.c` (picocolors). Result:
// the header, border, and body all strip consistently under NO_COLOR / non-TTY,
// because picocolors is the SOLE color authority. Responsive `colWidths` are
// measured in DISPLAY columns (see `./width.js`) so a coloured or wide cell is
// allocated the space it actually draws, and cells too long for their column are
// cut by that same module rather than by cli-table3's code-unit arithmetic.
// `wordWrap` keeps free-text cells readable; `truncate: '…'` is the final
// backstop for a long token inside a wrapped cell.
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
  const widths = computeColWidths(rows, cols);
  const t = new Table({
    head: cols.map((col) => c.bold(c.info(col))),
    // Empty arrays ⇒ cli-table3 applies NO @colors/colors wrap (neither the
    // default red header nor a colored border). All color is ours, via theme.
    style: { head: [], border: [] },
    colWidths: widths,
    wordWrap: true,
    truncate: '…',
  });
  for (const row of rows) {
    t.push(cols.map((col, i) => truncateCell(row[col], (widths[i] ?? 0) - 2)));
  }
  process.stderr.write(`${t.toString()}\n`);
}

/**
 * The narrowest a column's content area may normally be, in display columns.
 * Below this a cell is nothing but its ellipsis, so it is only reached by the
 * final overflow pass, never by the ordinary greedy trim.
 */
const MIN_CONTENT_WIDTH = 3;

/**
 * Compute per-column widths (cli-table3 `colWidths`, which INCLUDE each column's
 * 2 padding chars) that fit `terminalWidth()`. Strategy:
 *
 *   1. Measure each column's NATURAL content width in DISPLAY columns (longest
 *      cell, at least a small minimum content width).
 *   2. If the natural total fits, use it as-is — every cell renders whole.
 *   3. Otherwise GREEDILY TRIM ONLY THE WIDEST column, down to its own header
 *      length (never below the minimum content width, and never held open above
 *      the content budget), until the row fits. A long header can therefore not
 *      pin a column open (the header wraps), while narrow columns (paths, ids,
 *      statuses) still give up as little as possible: they are single tokens
 *      that can't word-wrap, so truncating them loses information.
 *   4. When every column is already at that floor and the row still does not
 *      fit (many columns, so the per-column padding alone exhausts the width),
 *      make one final bounded pass that shrinks the widest columns below the
 *      floor. The cells those columns hold are then drawn with a visible
 *      ellipsis, so the row stays inside the terminal instead of overflowing.
 *
 * Widths are measured through `displayWidth` (ANSI stripped, wide glyphs count 2)
 * so a coloured badge or a CJK character does not inflate the column past what it
 * draws. cli-table3 accepts only positive integers (negatives collapse). Each
 * returned width is `content + 2` to reserve the column's padding, so the
 * content area equals the measured width and the math against `terminalWidth()`
 * is exact.
 */
function computeColWidths(
  rows: readonly Record<string, unknown>[],
  cols: readonly string[],
): number[] {
  const n = cols.length;
  if (n === 0) return [];
  const headerLen = cols.map((col) => displayWidth(col));
  const natural = cols.map((col, i) => {
    let max = Math.max(headerLen[i] ?? displayWidth(col), MIN_CONTENT_WIDTH);
    for (const row of rows) {
      const len = displayWidth(formatCell(row[col]));
      if (len > max) max = len;
    }
    return max;
  });
  // cli-table3 row overhead: per column 1 left border + 2 padding, plus a final
  // right border ⇒ 3n + 1 non-content chars. `budget` is what remains for the
  // sum of column CONTENT areas, and it is the ONLY budget this function uses:
  // every "does it fit" test below — the natural-width fast path included —
  // compares against it, so no branch can return a row wider than the terminal.
  //
  // Floored at `n` (one content column per column) deliberately. A narrower
  // budget would be a lie twice over: cli-table3 accepts only POSITIVE integer
  // widths, so a zero or negative column collapses rather than shrinking; and
  // whenever `4n + 1 > terminalWidth()` the row is unachievable anyway — the
  // borders and padding alone no longer fit, so no arrangement of the content
  // can save it. The floor keeps the trim from driving a column to zero on such
  // a terminal and gives the final pass a natural stopping point (all columns
  // one content column wide). Do not "fix" it away as redundant.
  const budget = Math.max(n, terminalWidth() - 3 * n - 1);
  const naturalSum = natural.reduce((a, b) => a + b, 0);
  if (naturalSum <= budget) {
    return natural.map((w) => w + 2);
  }
  // Overflow: greedily cut the widest reducible column down to its floor.
  const content = natural.slice();
  let sum = naturalSum;
  // A column's floor is its own header — so a table that can fit its headers
  // keeps every one of them on a single line — capped at the whole budget,
  // because a header wider than that can never be honoured anyway. Without the
  // cap, one very long header would pin its column open and push the row past
  // the terminal.
  const floor = headerLen.map((h) => Math.min(Math.max(h, MIN_CONTENT_WIDTH), budget));
  while (sum > budget) {
    let idx = -1;
    let widest = -1;
    for (let i = 0; i < n; i++) {
      const c = content[i] ?? 0;
      const f = floor[i] ?? MIN_CONTENT_WIDTH;
      if (c > f && c > widest) {
        widest = c;
        idx = i;
      }
    }
    if (idx === -1) break; // every column is at its floor — stop
    const overshoot = sum - budget;
    const reducible = (content[idx] ?? 0) - (floor[idx] ?? MIN_CONTENT_WIDTH);
    const cut = Math.min(overshoot, reducible);
    content[idx] = (content[idx] ?? 0) - cut;
    sum -= cut;
  }
  // Final bounded pass: when the columns are all at their floor yet the row
  // still will not fit, shrink the widest columns below that floor (down to a
  // single content column each) so the cells ellipsise and the row fits. The
  // pass visits each column at most once, so it always terminates.
  if (sum > budget) {
    for (let pass = 0; pass < n && sum > budget; pass++) {
      let idx = -1;
      let widest = 0;
      for (let j = 0; j < n; j++) {
        const c = content[j] ?? 0;
        if (c > 1 && c > widest) {
          widest = c;
          idx = j;
        }
      }
      if (idx === -1) break; // every column is a single column wide — give up
      const cut = Math.min(sum - budget, (content[idx] ?? 1) - 1);
      content[idx] = (content[idx] ?? 1) - cut;
      sum -= cut;
    }
  }
  return content.map((w) => w + 2);
}

/**
 * True for a value shaped like a filesystem path. Paths legitimately contain
 * whitespace (a directory named "My Projects"), so this is a SHAPE test rather
 * than a single-token test: the value must carry a separator AND either start
 * like a path — a leading `/`, `./`, `../`, `~/`, or a Windows drive prefix such
 * as `C:\` — or end in a file extension (`…/store.db`). A sentence that merely
 * contains a slash ("the spec/plan docs") matches neither, so it is still left
 * to `wordWrap` instead of being cut.
 */
function isPathToken(s: string): boolean {
  if (!/[\\/]/.test(s)) return false;
  return /^(\/|\.\/|\.\.\/|~\/|[A-Za-z]:[\\/])/.test(s) || /\.[A-Za-z0-9][A-Za-z0-9_-]*$/.test(s);
}

/**
 * A cell value cut to fit its column's content area.
 *
 * Only a cell that OVERFLOWS is touched, and the untouched path returns the
 * value byte-for-byte — which is what keeps a coloured cell coloured, since the
 * truncators strip ANSI and return plain text. A path is cut in the MIDDLE, so
 * the leading directories and the final file name both survive; it is tested
 * first because a path can contain spaces and would otherwise be mistaken for
 * free text. A non-path multi-word cell is left entirely to `wordWrap`, and a
 * single-token cell — which cannot wrap — is cut at the tail. Every cut is
 * measured in display columns and never splits a grapheme cluster.
 */
function truncateCell(value: unknown, contentWidth: number): string {
  const s = formatCell(value);
  if (contentWidth <= 0 || displayWidth(s) <= contentWidth) return s;
  if (isPathToken(s)) return truncateMiddle(s, contentWidth);
  if (/\s/.test(s)) return s; // multi-word free text: `wordWrap` folds it
  return truncateToWidth(s, contentWidth);
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
// Definition list (stderr). A two-column Field/Value rendering for snapshot-
// shaped output (status / task / context-status). `status.ts` hand-rolled this
// exact shape; this generalizes it. Rendered via the same responsive `table()`,
// so it inherits the clean (non-red) header + NO_COLOR behavior automatically.
// ---------------------------------------------------------------------------
export interface DefinitionRow {
  /** Field label (left column). */
  label: string;
  /** Field value; passed through unchanged so the table formats it exactly once. */
  value: unknown;
}

export function definitionList(rows: readonly DefinitionRow[], opts: CliOptions = {}): void {
  table(
    rows.map((r) => ({ Field: r.label, Value: r.value })),
    ['Field', 'Value'],
    opts,
  );
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
 * The one-line `{ok:false,error}` envelope every `--json` failure writes. Built
 * in one place so a failure written by `fail()` and one written on the way out
 * of a signal handler cannot drift apart.
 */
function failureEnvelope(exitCode: number, message: string): string {
  return `${JSON.stringify({ ok: false, error: { code: exitCode, message } })}\n`;
}

/**
 * Write a diagnostic and throw a `CommanderError` carrying the given exit code,
 * so bin.ts's `exitOverride` + `handleError` surface it as `process.exitCode`
 * without any mid-action `process.exit`. Under `--json` the message becomes a
 * structured `{ok:false,error}` envelope on STDOUT; otherwise plain text on
 * STDERR. Always throws (`never`).
 */
export function fail(exitCode: number, message: string, opts: CliOptions = {}): never {
  if (isJsonMode(opts)) {
    process.stdout.write(failureEnvelope(exitCode, message));
  } else if (message.length > 0) {
    process.stderr.write(`${message}\n`);
  }
  throw new CommanderError(exitCode, NOIR_ERROR_CODE, message);
}

/** How long a leaving path waits for its own last line to land before it goes. */
const EXIT_FLUSH_MS = 250;

/**
 * {@link fail} for the paths that leave from a signal handler, where there is no
 * caller left to catch what it throws: the verdict is written and the exit
 * follows it, with the same shape and the same exit code an ordinary failure
 * would have produced. Under `--json` the envelope is the run's last output, so
 * the exit waits for the write to land — a process that exits with stdout still
 * queued loses it — and goes without it if the write never lands, because the
 * whole point of this path is to leave.
 */
export function failAndExit(exitCode: number, message: string, opts: CliOptions = {}): void {
  // The code this process leaves with, even if the write below never lands.
  process.exitCode = exitCode;
  const jsonMode = isJsonMode(opts);
  const text = jsonMode
    ? failureEnvelope(exitCode, message)
    : message.length > 0
      ? `${message}\n`
      : '';
  if (text.length === 0) {
    process.exit(exitCode);
  }
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    process.exit(exitCode);
  };
  (jsonMode ? process.stdout : process.stderr).write(text, leave);
  setTimeout(leave, EXIT_FLUSH_MS);
}

/**
 * Guard for commands that would otherwise block on a prompt. Honors the
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

// Remap commander's own exit codes onto the CLI exit-code contract:
//   help/version → 0 · unknown command → 3 · every other usage error → 2
function commanderExitCode(err: CommanderError): number {
  switch (err.code) {
    case 'commander.helpDisplayed':
    case 'commander.versionDisplayed':
    case 'commander.version': // commander v12 uses this code for --version (exit 0)
      return EXIT.OK;
    case 'commander.unknownCommand':
      return EXIT.NOT_FOUND;
    default:
      return EXIT.USAGE;
  }
}

/** Map any thrown value onto the CLI exit-code contract. */
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
