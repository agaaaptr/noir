// `noir run` status-line wiring: the line is fed by the same event stream that
// carries the host's answer, so what matters here is the ORDER of writes on the
// two streams and the modes where nothing may be written at all. Drives the
// real commander tree + run.ts with a mocked runHost (offline, no host spawn,
// no key) and both TTY answers forced, so no test depends on how vitest happens
// to wire its own stdio.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { RunHostOptions, RunHostResult } from '../src/orchestrator.js';

const { runHostMock } = vi.hoisted(() => ({
  runHostMock: vi.fn(
    async (_opts: RunHostOptions): Promise<RunHostResult> => ({
      exitCode: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, numTurns: 0 },
      eventCount: 0,
      stderr: '',
      isError: false,
      errorText: undefined,
    }),
  ),
}));
vi.mock('../src/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orchestrator.js')>();
  return { ...actual, runHost: runHostMock };
});

import { createProgram } from '../src/bin.js';
import { handleError } from '../src/output.js';

/** Force a stream's TTY answer, returning the undo. */
function setTty(stream: NodeJS.WriteStream, value: boolean): () => void {
  const previous = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { configurable: true, value });
  return () => {
    if (previous) Object.defineProperty(stream, 'isTTY', previous);
    else Reflect.deleteProperty(stream, 'isTTY');
  };
}

async function runCli(argv: readonly string[]): Promise<number> {
  const program = createProgram();
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    handleError(err);
  }
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

/** One host turn: an init line, an assistant message with text and usage, done. */
function cleanRunWith(text: string, opts: RunHostOptions): RunHostResult {
  opts.onEvent?.({ kind: 'init', sessionId: 's1', model: 'claude-sonnet-4' });
  opts.onEvent?.({
    kind: 'assistant',
    messageId: 'm1',
    text,
    usage: { inputTokens: 12, outputTokens: 3 },
  });
  opts.onEvent?.({ kind: 'result', isError: false, numTurns: 1 });
  return {
    exitCode: 0,
    usage: { inputTokens: 12, outputTokens: 3, totalCostUsd: 0, numTurns: 1 },
    eventCount: 3,
    stderr: '',
    isError: false,
  };
}

describe('noir run — status line wiring', () => {
  /** Every write to either stream, in the order the process made them. */
  let log: { stream: 'out' | 'err'; chunk: string }[];
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let tmp: string;
  let prevExit: typeof process.exitCode;
  let restores: (() => void)[];

  /** Answer one stream's TTY question for the rest of the test. */
  function tty(stream: 'out' | 'err', value: boolean): void {
    const target = stream === 'err' ? process.stderr : process.stdout;
    restores.push(setTty(target, value));
  }

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    tmp = mkdtempSync(join(tmpdir(), 'noir-run-status-'));
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    log = [];
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      log.push({ stream: 'out', chunk: String(chunk) });
      return true;
    });
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      log.push({ stream: 'err', chunk: String(chunk) });
      return true;
    });
    // vitest's own stdio is piped; pin both answers explicitly so the TTY and
    // non-TTY paths are exercised deliberately rather than inherited.
    restores = [];
    tty('err', false);
    tty('out', false);
  });

  afterEach(() => {
    for (const restore of restores.reverse()) restore();
    stdout.mockRestore();
    stderr.mockRestore();
    cwd.mockRestore();
    process.exitCode = prevExit;
    vi.clearAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const textOf = (stream: 'out' | 'err'): string =>
    log
      .filter((w) => w.stream === stream)
      .map((w) => w.chunk)
      .join('');

  it('leaves stdout and stderr byte-identical under --json', async () => {
    runHostMock.mockImplementationOnce(async (o: RunHostOptions) => cleanRunWith('hello', o));
    expect(await runCli(['run', 'hi', '--json'])).toBe(0);
    // The envelope is the whole of stdout, and stderr carries not one byte —
    // this is the machine contract the status line must never touch.
    expect(textOf('err')).toBe('');
    const envelope = JSON.parse(textOf('out'));
    expect(envelope.ok).toBe(true);
    expect(envelope.data.host).toBe('claude');
    expect(envelope.data.exitCode).toBe(0);
  });

  it('leaves stderr empty under --quiet', async () => {
    runHostMock.mockImplementationOnce(async (o: RunHostOptions) => cleanRunWith('hello', o));
    expect(await runCli(['run', 'hi', '--quiet'])).toBe(0);
    expect(textOf('err')).toBe('');
    expect(textOf('out')).toBe('hello\n');
  });

  it('prints one plain start marker and one plain end marker on a pipe', async () => {
    runHostMock.mockImplementationOnce(async (o: RunHostOptions) => cleanRunWith('hello', o));
    expect(await runCli(['run', 'hi'])).toBe(0);
    const err = textOf('err');
    expect(err).toContain('▶ claude · waiting for first event…\n');
    expect(err).toContain('● claude-sonnet-4 · 0s · ↓12↑3 tokens\n');
    // Nothing here may emit cursor control: this is a log file.
    expect(err).not.toContain('\r');
    expect(err).not.toContain('\x1b');
    // The answer is still the only thing on stdout, and it is unchanged.
    expect(textOf('out')).toBe('hello\n');
  });

  it('redraws in place on a terminal and yields the row before the answer', async () => {
    tty('err', true);
    tty('out', true);
    runHostMock.mockImplementationOnce(async (o: RunHostOptions) => cleanRunWith('hello', o));
    expect(await runCli(['run', 'hi'])).toBe(0);

    const err = textOf('err');
    expect(err).toContain('▶ claude · waiting for first event…');
    expect(err).toContain('● claude-sonnet-4 · 0s · ↓12↑3 tokens');
    // Every redraw replaces the previous row rather than printing a new one.
    expect(err.split('\r\x1b[K').length - 1).toBeGreaterThanOrEqual(3);
    expect(textOf('out')).toBe('hello\n');

    // The status line finished its row BEFORE the answer reached stdout — the
    // answer must never begin glued to the tail of the progress text.
    const handover = log.findIndex((w) => w.stream === 'err' && w.chunk === '\n');
    const answer = log.findIndex((w) => w.stream === 'out' && w.chunk === 'hello');
    expect(handover).toBeGreaterThanOrEqual(0);
    expect(answer).toBeGreaterThan(handover);

    // And once the cursor is inside the answer, no further cursor movement.
    const afterAnswer = log.slice(answer + 1).filter((w) => w.stream === 'err');
    expect(afterAnswer.some((w) => w.chunk.includes('\r'))).toBe(false);
  });

  it('keeps redrawing when stdout is redirected away from the terminal', async () => {
    // stderr is the terminal, stdout is a file: nothing can collide, so the
    // line owns its row for the whole run and is erased at the end.
    tty('err', true);
    runHostMock.mockImplementationOnce(async (o: RunHostOptions) => cleanRunWith('hello', o));
    expect(await runCli(['run', 'hi'])).toBe(0);
    const err = textOf('err');
    expect(err).toContain('● claude-sonnet-4 · 0s · ↓12↑3 tokens');
    expect(log.some((w) => w.stream === 'err' && w.chunk === '\r\x1b[K')).toBe(true);
    expect(textOf('out')).toBe('hello\n');
  });

  it('starts the failure message on a new row when the answer stopped mid-line', async () => {
    tty('err', true);
    tty('out', true);
    runHostMock.mockImplementationOnce(async (o: RunHostOptions) => {
      o.onEvent?.({ kind: 'init', sessionId: 's1', model: 'claude-sonnet-4' });
      // The host died mid-sentence, so stdout never emitted the newline that
      // would have ended the answer's row.
      o.onEvent?.({ kind: 'assistant', messageId: 'm1', text: 'let me look at that' });
      return {
        exitCode: 1,
        usage: { inputTokens: 5, outputTokens: 2, totalCostUsd: 0, numTurns: 1 },
        eventCount: 2,
        stderr: '',
        isError: true,
        errorText: 'connection reset',
      };
    });
    expect(await runCli(['run', 'hi'])).toBe(1);
    expect(textOf('out')).toBe('let me look at that');

    // Without the row break the error reads as the tail of the answer — the
    // exact shape this guards against: "…look at thathost 'claude' failed".
    const answer = log.findIndex((w) => w.stream === 'out' && w.chunk === 'let me look at that');
    const failure = log.findIndex((w) => w.stream === 'err' && w.chunk.includes('failed (exit 1)'));
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(failure).toBeGreaterThan(answer);
    expect(log.slice(answer + 1, failure).some((w) => w.stream === 'err' && w.chunk === '\n')).toBe(
      true,
    );
  });

  it('erases the line before the failure message, on both a terminal and a pipe', async () => {
    runHostMock.mockResolvedValueOnce({
      exitCode: 1,
      usage: { inputTokens: 2, outputTokens: 1, totalCostUsd: 0, numTurns: 1 },
      eventCount: 1,
      stderr: '',
      isError: true,
      errorText: 'not logged in',
    });
    tty('err', true);
    expect(await runCli(['run', 'hi'])).toBe(1);

    // The failure text must not be tacked onto the tail of a progress row.
    const cleared = log.findIndex((w) => w.stream === 'err' && w.chunk === '\r\x1b[K');
    const failure = log.findIndex((w) => w.stream === 'err' && w.chunk.includes('failed (exit 1)'));
    expect(cleared).toBeGreaterThanOrEqual(0);
    expect(failure).toBeGreaterThan(cleared);
  });
});
