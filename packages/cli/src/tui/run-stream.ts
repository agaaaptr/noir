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
// disk. Its one subtlety is that the host reports the same assistant text
// twice: once as the deltas it writes, and again as the completed block. Text
// from the deltas is therefore PROVISIONAL — it is dropped the moment the block
// it belongs to is confirmed, and only survives as committed text if the run
// ends before that confirmation (a cancelled run still shows what it said).

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

export class RunStream {
  private readonly reducer = new UsageReducer();
  /** Rows confirmed by the host's own completed blocks. */
  private readonly committed: string[] = [];
  /** Assistant text, in the order it was confirmed. */
  private readonly answerParts: string[] = [];
  /** Text seen on the delta feed but not yet confirmed by a completed block. */
  private live = '';
  private toolCount = 0;
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
        // The completed block re-reports the deltas verbatim, so the preview is
        // dropped before the text is committed — otherwise every answer renders
        // twice, once as it streamed and once as it finished.
        this.live = '';
        // API-error text is a diagnostic, not the answer: it is shown when the
        // run fails, and never accumulated as something to save.
        if (event.isError !== true && event.text !== undefined && event.text.length > 0) {
          this.answerParts.push(event.text);
          this.pushText(event.text);
        }
        break;
      case 'tool':
        this.toolCount += 1;
        this.committed.push(`${TOOL_MARK} ${event.name}`);
        break;
      case 'delta':
        this.live += event.text;
        break;
      default:
        // `result` and `other` carry nothing this screen shows.
        break;
    }
    this.reducer.add(event);
  }

  /**
   * Settle the provisional text: called once the run has ended, so a run that
   * stopped mid-block keeps the words it had already produced instead of losing
   * them (and so a transcript read back from disk renders completely).
   */
  finalize(): void {
    if (this.live.length === 0) return;
    this.answerParts.push(this.live);
    this.pushText(this.live);
    this.live = '';
  }

  /** Everything the run screen renders, as of now. */
  snapshot(): RunStreamSnapshot {
    const usage = this.reducer.snapshot();
    return {
      lines:
        this.live.length === 0 ? [...this.committed] : [...this.committed, ...splitRows(this.live)],
      // Provisional text counts: a cancelled run's answer is what it managed to
      // say, and `finalize` will have committed it anyway.
      answer: this.answerParts.join('') + this.live,
      toolCount: this.toolCount,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
      ...(this.model === undefined ? {} : { model: this.model }),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    };
  }

  /** Commit a stretch of assistant text as one row per line it contains. */
  private pushText(text: string): void {
    for (const row of splitRows(text)) this.committed.push(row);
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
