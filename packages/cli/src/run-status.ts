// A live status line for `noir run`, drawn on STDERR.
//
// The stretch between spawning the host and its first token of output is the
// one part of a run with no feedback at all, and it has no upper bound: a slow
// gateway, a queued model, or a host quietly retrying all read as a hang. This
// line names what is happening — which host, which model, how long, how many
// tokens so far — so that stretch is never silent.
//
// Three design constraints shape it:
//
//   1. STDERR, because stdout carries the host's answer (or the `--json`
//      envelope) and must stay clean for pipes, redirection, and machine
//      consumers. Under `--json` and `--quiet` the line emits nothing at all,
//      so those byte-for-byte contracts are untouched.
//   2. EVENT-DRIVEN, never a timer. The host's answer streams to stdout, which
//      normally shares this terminal; a redraw racing that stream would land
//      inside the answer. Every render here is caused by a host event.
//   3. ONE ROW AT A TIME. While the line owns the row the cursor is on, it
//      rewrites in place. The moment anything else is about to be written to
//      that row it finishes the row with a newline first, so the answer never
//      starts glued to the tail of the status text. It then keeps quiet until
//      stdout leaves the cursor at the start of a row again — which is what
//      makes a carriage return safe to use, since anything else would drag the
//      cursor back over what was just written. "One row" is a promise the line
//      has to keep: text wider than the terminal is folded onto a second row by
//      the terminal itself, so the line is clamped to the width, and what it
//      clears is measured against that same width.
//
// Where stderr is not a terminal (CI logs, redirection) there is nothing to
// redraw and no cursor to protect, so the line degrades to two plain markers:
// one when the run starts, one when it ends.

import { type NoirEvent, UsageReducer } from './orchestrator.js';
import { terminalWidth } from './theme.js';
import { displayWidth, truncateToWidth } from './width.js';

/**
 * How many lines of the host's own stderr a failure message carries. Bounded
 * because a host may narrate far more than a terminal can usefully show; the
 * unfiltered stream is still in the transcript.
 */
export const HOST_STDERR_TAIL_LINES = 20;

export interface RunStatusOptions {
  /** Label for the host being driven (`claude`, `claude-work`, …). */
  readonly host: string;
  /** Machine-output mode: the status line is suppressed entirely. */
  readonly json?: boolean;
  /** The user asked for no diagnostics: the status line is suppressed entirely. */
  readonly quiet?: boolean;
  /** Whether the status line's own stream is a terminal (redraw) or a pipe (markers). */
  readonly stderrIsTty?: boolean;
  /**
   * Whether stdout renders on the same terminal as stderr. When it does, the
   * answer can land on the row the status line is holding, so the line must
   * yield first. When stdout is redirected or piped it is not on the terminal
   * at all, and the status line can keep its row for the whole run. Defaults to
   * true — the conservative answer when the caller does not say.
   */
  readonly stdoutSharesCursor?: boolean;
  /** Where the line is written (defaults to stderr). */
  readonly write?: (chunk: string) => void;
  /** Monotonic millisecond clock (defaults to `performance.now`). */
  readonly now?: () => number;
}

/**
 * Humanize a duration the way a person reads it: `8s`, `2m 18s`, `1h 05m`.
 * Raw seconds stop being readable well before a long tool-heavy run finishes.
 */
export function humanizeElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

export class RunStatusLine {
  private readonly host: string;
  private readonly enabled: boolean;
  private readonly animated: boolean;
  private readonly sharesCursor: boolean;
  private readonly write: (chunk: string) => void;
  private readonly now: () => number;
  /**
   * Running token totals for the live line. This is a SECOND accumulator: the
   * snapshot the run reports at the end is reduced independently from the full
   * event stream, and both apply the same `max usage per message id` rule, so
   * the number on screen and the number in the summary agree.
   */
  private readonly usage = new UsageReducer();
  private startedAt: number;
  private model: string | undefined;
  private streaming = false;
  private begun = false;
  private ended = false;
  /** True while the status text is sitting on the row the cursor is currently at. */
  private onRow = false;
  /** True when the last stdout write ended a line — the only safe moment to move the cursor. */
  private stdoutAtRowStart = true;
  /** The text currently on the row (empty when the row is not ours). */
  private rendered = '';

  constructor(opts: RunStatusOptions) {
    this.host = opts.host;
    this.enabled = opts.json !== true && opts.quiet !== true;
    this.animated = this.enabled && opts.stderrIsTty === true;
    this.sharesCursor = opts.stdoutSharesCursor !== false;
    this.write = opts.write ?? ((chunk: string): void => void process.stderr.write(chunk));
    this.now = opts.now ?? ((): number => performance.now());
    this.startedAt = this.now();
  }

  /**
   * Claim the row: show the seeded "waiting" state immediately, before the host
   * has said anything, so the spawn itself is never blank. Calling this twice
   * is a no-op.
   */
  begin(): void {
    if (!this.enabled || this.begun) return;
    this.begun = true;
    this.startedAt = this.now();
    if (this.animated) {
      this.draw();
      return;
    }
    this.write(`${this.render()}\n`);
  }

  /** Feed one normalized host event. Anything unrenderable is ignored. */
  event(e: NoirEvent): void {
    if (!this.enabled || this.ended || !this.begun) return;
    if (e.kind === 'result') {
      this.end();
      return;
    }
    if (e.kind === 'init') {
      if (e.model !== undefined) this.model = e.model;
    } else if (e.kind === 'assistant' || e.kind === 'tool') {
      // A tool call is output: the host is working, so the line stops saying it
      // is still waiting — and a tool-only message carries that message's
      // tokens, which the shared accumulator folds in by the same rule.
      this.streaming = true;
      this.usage.add(e);
    } else if (e.kind === 'delta') {
      // The first slice of the answer: there is text on screen from here on.
      this.streaming = true;
    } else {
      return; // 'other' carries nothing this line can show
    }
    this.draw();
  }

  /**
   * Announce the chunk the caller is about to write to STDOUT — before writing
   * it. Warning the line first lets it finish its row: the answer would
   * otherwise start glued to the tail of the status text. It also records
   * whether that write ended a line, which is the only moment the cursor can be
   * moved without landing inside the answer.
   */
  beforeStdout(chunk: string): void {
    if (chunk.length === 0) return;
    if (this.animated && this.sharesCursor && this.onRow) {
      this.write('\n');
      this.onRow = false;
    }
    this.stdoutAtRowStart = chunk.endsWith('\n');
  }

  /**
   * Finish the row the host's answer left open. A failure message printed onto
   * a half-written answer reads as part of the answer, so a caller about to
   * report a failure asks for the row to be terminated first. A no-op unless
   * this line is drawing on a terminal stdout also writes to and the answer
   * stopped mid-line — the only state where the cursor is inside the answer.
   */
  finishRow(): void {
    if (!this.animated || !this.sharesCursor || this.stdoutAtRowStart) return;
    this.write('\n');
    this.stdoutAtRowStart = true;
  }

  /**
   * Close the line out. On a terminal the line is erased so the run summary
   * takes its place — unless the answer has since moved the cursor off it, in
   * which case the text stays as the record of how long the wait was. On a pipe
   * it becomes the final marker. Safe to call twice.
   */
  end(): void {
    if (!this.enabled || this.ended) return;
    this.ended = true;
    if (!this.animated) {
      this.write(`${this.render(true)}\n`);
      return;
    }
    if (!this.onRow || !this.cursorFree()) return;
    this.write(this.erase(this.rendered));
    this.rendered = '';
    this.onRow = false;
  }

  /** Rewrite the current row in place, skipping no-op rewrites and unsafe moments. */
  private draw(): void {
    if (!this.animated || !this.cursorFree()) return;
    // The line promises to be one row, so it is clamped to the terminal: any
    // wider and the terminal folds the overflow onto a row of its own, where
    // this line neither drew it nor knows to clear it. The width is read per
    // render, so a window resized mid-run is honored from the next redraw.
    const text = truncateToWidth(this.render(), terminalWidth());
    if (text === this.rendered) return;
    this.write(`${this.erase(this.rendered)}${text}`);
    this.rendered = text;
    this.onRow = true;
  }

  /**
   * The escape sequence that clears the status text currently on screen and
   * leaves the cursor at the start of the row it began on — where the next
   * render writes. An empty `previous` still clears the row, so a line that has
   * drawn nothing yet starts from a known-blank one.
   *
   * The extent is measured against the terminal width as it is NOW, not as it
   * was when the text was drawn. Nothing this line writes wraps, but text that
   * fitted a wider terminal does not stop existing when the window narrows: the
   * terminal folds it onto rows below, and clearing only the row the cursor
   * ends on would leave the rest above as residue. So the sequence walks back
   * up over every row the text occupies.
   */
  private erase(previous: string): string {
    const rows = Math.max(1, Math.ceil(displayWidth(previous) / terminalWidth()));
    let sequence = '\r\x1b[K';
    for (let row = 1; row < rows; row++) {
      sequence += '\x1b[1A\r\x1b[K';
    }
    return sequence;
  }

  /**
   * Whether the cursor is at the start of a row nobody else is using. On stdout
   * that is not this terminal there is no shared cursor to disturb; when it is,
   * only a write that ended a line leaves one free.
   */
  private cursorFree(): boolean {
    return !this.sharesCursor || this.stdoutAtRowStart;
  }

  /**
   * `final` marks the line the run ends on: a run that never got past the spawn
   * is over, so saying it is still waiting — directly above whatever the run
   * reported — would be a lie.
   */
  private render(final = false): string {
    const parts: string[] = [];
    if (this.streaming) {
      const u = this.usage.snapshot();
      parts.push(
        this.model ?? this.host,
        this.elapsed(),
        `↓${u.inputTokens.toLocaleString()}↑${u.outputTokens.toLocaleString()} tokens`,
      );
      return `● ${parts.join(' · ')}`;
    }
    // Before the first token there is nothing to count yet: name the host, then
    // the model once the host has announced it.
    if (this.model !== undefined) return `▶ ${[this.host, this.model, this.elapsed()].join(' · ')}`;
    if (final) return `▶ ${this.host} · no output after ${this.elapsed()}`;
    return `▶ ${this.host} · waiting for first event…`;
  }

  private elapsed(): string {
    return humanizeElapsed(this.now() - this.startedAt);
  }
}

/**
 * The last `maxLines` lines of the host's own stderr. A failing host narrates
 * its progress and its errors there and Noir otherwise reads none of it, which
 * leaves a failure reportable only by whatever single sentence the host put in
 * its stream — the run is unauditable without the rest. Bounded so a
 * pathological host cannot flood the terminal, and surfaced VERBATIM: it is the
 * host's own output, never Noir's environment, so there is nothing here to
 * redact and no value of Noir's to leak.
 */
export function hostStderrTail(stderr: string, maxLines = HOST_STDERR_TAIL_LINES): string {
  // A non-positive bound asks for no lines at all. `slice(-0)` is `slice(0)`,
  // so without this an unbounded tail would be printed by the code that exists
  // to bound it.
  if (maxLines <= 0) return '';
  const lines = stderr.split('\n').map((line) => line.trimEnd());
  // A trailing newline produces one empty element that is not a line of output.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '';
  if (lines.length <= maxLines) return lines.join('\n');
  const omitted = lines.length - maxLines;
  return [`… (${omitted} earlier lines omitted)`, ...lines.slice(-maxLines)].join('\n');
}
