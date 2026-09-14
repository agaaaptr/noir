// Live state for one host run, rendered inside the TUI.
//
// THIS PATH MUST NEVER GO THROUGH `captureProcessOutput`. That helper swaps
// `process.stdout.write` / `process.stderr.write` for collectors while a
// dispatched command runs, and Ink renders every frame by calling
// `process.stdout.write` itself — so a run screen wrapped in it would have its
// own frames swallowed. A run therefore spawns through the injected run seam,
// folds the host's normalized events into React state here, and lets Ink render
// normally: the host's output is data this module turns into lines, and it
// never touches the writer the capture would have replaced.
//
// The fold is a pure, inert class (no timers, no I/O) so it can be driven
// frame-by-frame in a test and reused to re-render a transcript read back from
// disk. Its one subtlety is that a host asked for partial messages reports the
// same thing twice: a stretch of assistant text arrives first as the deltas
// that spell it out and again as the block that closes it, and a tool call
// arrives first as the frame that opens its block and again inside the message
// that finished it. Both are therefore PROVISIONAL on arrival, and the thing
// that announced them is what they resolve into — a tool call is one row and
// one count whether or not the host streams partials — with the provisional
// form surviving only when the run ends before the confirmation lands (a
// cancelled run still shows the text it wrote and the tools it ran).

import {
  type NoirEvent,
  normalizeStreamEvent,
  parseStreamLine,
  UsageReducer,
} from '../orchestrator.js';

/** The marker a tool-activity row carries. Matches the host's own convention. */
const TOOL_MARK = '●';

/** A snapshot of everything the run screen renders. */
export interface RunStreamSnapshot {
  /** The pane rows: assistant text and tool activity, in arrival order. */
  readonly lines: readonly string[];
  /** The host's answer as plain text — what a post-run action would save. */
  readonly answer: string;
  /** How many tool calls the run has started. */
  readonly toolCount: number;
  /** The host's id for this session, once it has reported one. */
  readonly sessionId?: string;
  /** The model the host announced, once it has. */
  readonly model?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * One pane row, and whether the host has confirmed it yet.
 *
 * `text` is a tool's name on a tool row and a stretch of assistant text on a
 * text row — one field either way, because the fold has to be able to find the
 * row an announcement opened by the name it opened it with.
 */
interface Row {
  readonly kind: 'text' | 'tool';
  readonly text: string;
  /** True until a completed message — or the end of the run — confirms it. */
  pending: boolean;
}

export class RunStream {
  private readonly reducer = new UsageReducer();
  /** The pane, in arrival order. */
  private readonly rows: Row[] = [];
  private sessionId: string | undefined;
  private model: string | undefined;

  /** Fold one normalized host event in. */
  apply(event: NoirEvent): void {
    switch (event.kind) {
      case 'init':
        if (event.sessionId !== undefined) this.sessionId = event.sessionId;
        if (event.model !== undefined) this.model = event.model;
        break;
      case 'assistant':
        this.commitMessage(event);
        break;
      case 'tool':
        // The incremental feed's word for a call it has just started. A call
        // read out of a completed message carries that message's id, and is the
        // authoritative row — it is also the only row a host that streams no
        // partials ever sends.
        this.recordTool(event.name, event.messageId !== undefined);
        break;
      case 'delta':
        this.appendText(event.text);
        break;
      default:
        // `result` and `other` carry nothing this screen shows.
        break;
    }
    this.reducer.add(event);
  }

  /**
   * Settle what is still provisional: called once the run has ended, so a run
   * that stopped mid-block keeps the words it had already produced and the
   * tools it had already started instead of losing them (and so a transcript
   * read back from disk renders completely).
   */
  finalize(): void {
    for (const row of this.rows) row.pending = false;
  }

  /** Everything the run screen renders, as of now. */
  snapshot(): RunStreamSnapshot {
    const usage = this.reducer.snapshot();
    const lines: string[] = [];
    const answer: string[] = [];
    let toolCount = 0;
    for (const row of this.rows) {
      if (row.kind === 'tool') {
        // Every tool row is one call, provisional or not: confirming a row
        // replaces it rather than adding one, so the count never moves twice
        // for the same call.
        toolCount += 1;
        lines.push(`${TOOL_MARK} ${row.text}`);
        continue;
      }
      answer.push(row.text);
      lines.push(...splitRows(row.text));
    }
    return {
      lines,
      // Provisional text counts: a cancelled run's answer is what it managed to
      // say, and `finalize` will have committed it anyway.
      answer: answer.join(''),
      toolCount,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.model === undefined ? {} : { model: this.model }),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }

  /**
   * Commit a completed assistant message.
   *
   * Its text supersedes the deltas that spelled it out — the host reports the
   * same words twice — and its tool calls are the authoritative word on the
   * calls the incremental feed opened, each taking over the row its own
   * announcement opened. The text lands where its deltas were, which is above
   * the calls it went on to make: a message that says something and then calls
   * a tool reads in that order, rather than the call floating above the
   * sentence that introduced it.
   */
  private commitMessage(event: {
    readonly text?: string;
    readonly tools?: readonly string[];
    readonly isError?: boolean;
  }): void {
    // Where the block's words were already showing, so the committed text takes
    // that place; a block whose text never streamed is appended instead.
    const opened = this.rows.findIndex((row) => row.kind === 'text' && row.pending);
    const at = opened === -1 ? this.rows.length : opened;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const row = this.rows[i];
      if (row !== undefined && row.kind === 'text' && row.pending) this.rows.splice(i, 1);
    }
    // API-error text is a diagnostic, not the answer: it is shown when the run
    // fails, and never accumulated as something to save.
    if (event.isError !== true && event.text !== undefined && event.text.length > 0) {
      this.rows.splice(at, 0, { kind: 'text', text: event.text, pending: false });
    }
    for (const name of event.tools ?? []) this.recordTool(name, true);
  }

  /**
   * Record a tool call, confirmed by a completed message or announced by the
   * frame that opened its block. A confirmed call takes over the row the
   * announcement left open; with nothing to take over — the first word on the
   * call, which is all some hosts ever send — it opens a row of its own.
   */
  private recordTool(name: string, confirmed: boolean): void {
    if (confirmed) {
      const opened = this.rows.findIndex(
        (row) => row.kind === 'tool' && row.pending && row.text === name,
      );
      const row = this.rows[opened];
      if (row !== undefined) {
        row.pending = false;
        return;
      }
    }
    this.rows.push({ kind: 'tool', text: name, pending: !confirmed });
  }

  /** Extend the stretch of text the host is writing, or start a new one. */
  private appendText(text: string): void {
    const last = this.rows[this.rows.length - 1];
    // Only the last row, and only while it is unconfirmed: a delta that arrives
    // after a tool call starts a new stretch, and one that follows a committed
    // block belongs to the next message.
    if (last !== undefined && last.kind === 'text' && last.pending) {
      this.rows[this.rows.length - 1] = { kind: 'text', text: last.text + text, pending: true };
      return;
    }
    this.rows.push({ kind: 'text', text, pending: true });
  }
}

/** Split a stretch of text into the rows a pane displays it on. */
function splitRows(text: string): string[] {
  const rows = text.split('\n');
  // A block that ends with a newline would otherwise leave a trailing blank row.
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop();
  return rows;
}

/**
 * Re-render a persisted transcript (raw stream-json lines) the way the run
 * screen would have shown it, so reopening an old run reads as prose and tool
 * activity rather than as JSONL. Unparseable lines are skipped: a transcript is
 * an audit record written by another process, and one bad line must not cost
 * the reader the rest of it.
 */
export function renderTranscript(rawLines: readonly string[]): readonly string[] {
  const stream = new RunStream();
  for (const line of rawLines) {
    const raw = parseStreamLine(line);
    if (raw === null) continue;
    const event = normalizeStreamEvent(raw);
    if (event !== null) stream.apply(event);
  }
  stream.finalize();
  return stream.snapshot().lines;
}
