// Post-run actions for `noir run`. Two things matter here. First, that a
// non-interactive run is byte-for-byte what it was before the menu existed —
// the menu is an offer, and a pipe must never see a byte of it. Second, that
// each action hands the right thing to the right seam: the answer as plain
// text (never the raw stream-json transcript), `--resume <id>` with a prompt
// collected fresh, the answer text written to the chosen path.
//
// The run itself is driven through the real commander tree with a fake host;
// @clack/prompts, the daemon client and the handoff seam are mocked, so
// nothing here touches a daemon, a network, or a key.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { RunHostOptions, RunHostResult } from '../src/orchestrator.js';

const { CANCEL, clackMock, runHostMock, handoffMock, calls, failure, payloads } = vi.hoisted(() => {
  const CANCEL = Symbol('cancel');
  return {
    CANCEL,
    calls: [] as Array<{ name: string; args: Record<string, unknown> | undefined }>,
    failure: { current: null as unknown },
    payloads: { current: {} as Record<string, unknown> },
    clackMock: {
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      select: vi.fn(),
      text: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === CANCEL),
    },
    runHostMock: vi.fn(
      async (_opts: RunHostOptions): Promise<RunHostResult> => ({
        exitCode: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, numTurns: 0 },
        eventCount: 0,
        stderr: '',
        isError: false,
      }),
    ),
    handoffMock: vi.fn(async (_opts: unknown): Promise<void> => {}),
  };
});

vi.mock('@clack/prompts', () => clackMock);

vi.mock('../src/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orchestrator.js')>();
  return { ...actual, runHost: runHostMock };
});

vi.mock('../src/commands/handoff.js', () => ({ handoff: handoffMock }));

vi.mock('../src/daemon-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon-client.js')>();
  return {
    ...actual,
    callDaemonTool: vi.fn(async (_opts: unknown, name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args });
      if (failure.current !== null) throw failure.current;
      return payloads.current[name];
    }),
    probeDaemon: vi.fn(async () => ({ running: true })),
  };
});

import { createProgram } from '../src/bin.js';
import { handleError } from '../src/output.js';
import { postRunActions } from '../src/run-actions.js';

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

/** One host turn: init, two assistant chunks, result. */
function cleanRunWith(
  text: string,
  o: RunHostOptions,
  sessionId: string | undefined,
): RunHostResult {
  o.onEvent?.({ kind: 'init', sessionId, model: 'claude-sonnet-4' });
  o.onEvent?.({ kind: 'assistant', messageId: 'm1', text });
  o.onEvent?.({ kind: 'assistant', messageId: 'm1', text: ' Done.' });
  o.onEvent?.({ kind: 'result', isError: false, numTurns: 1 });
  return {
    exitCode: 0,
    usage: { inputTokens: 12, outputTokens: 3, totalCostUsd: 0, numTurns: 1 },
    eventCount: 4,
    stderr: '',
    isError: false,
  };
}

/** One identical answer for every simulated run. */
const ANSWER = 'The answer is 42. Done.';

describe('noir run — post-run actions', () => {
  let log: { stream: 'out' | 'err'; chunk: string }[];
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let root: string;
  let prevExit: typeof process.exitCode;
  let restores: (() => void)[];
  let savedCi: string | undefined;
  let savedNoColor: string | undefined;

  function tty(stream: 'out' | 'err' | 'in', value: boolean): void {
    const target =
      stream === 'out' ? process.stdout : stream === 'err' ? process.stderr : process.stdin;
    restores.push(setTty(target as NodeJS.WriteStream, value));
  }

  /** Collect one clean turn from the fake host (null = it reported no session). */
  function hostAnswers(sessionId: string | null = 's1'): void {
    runHostMock.mockImplementationOnce(async (o: RunHostOptions) =>
      cleanRunWith('The answer is 42.', o, sessionId ?? undefined),
    );
  }

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    savedCi = process.env.CI;
    savedNoColor = process.env.NO_COLOR;
    delete process.env.CI;
    delete process.env.NO_COLOR;
    root = mkdtempSync(join(tmpdir(), 'noir-run-actions-'));
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    calls.length = 0;
    failure.current = null;
    payloads.current = {
      memory_capture: { ok: true, id: 'cap-1', observation: { id: 'cap-1', content: 'saved' } },
      workflow_research_record: { ok: true, taskId: 'T-1', entry: {} },
    };
    log = [];
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      log.push({ stream: 'out', chunk: String(chunk) });
      return true;
    });
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      log.push({ stream: 'err', chunk: String(chunk) });
      return true;
    });
    // vitest's own stdio is piped; pin every answer explicitly so each test
    // exercises the mode it means to rather than inheriting one.
    restores = [];
    tty('out', false);
    tty('err', false);
    tty('in', false);
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const restore of restores.reverse()) restore();
    stdout.mockRestore();
    stderr.mockRestore();
    cwd.mockRestore();
    if (savedCi === undefined) delete process.env.CI;
    else process.env.CI = savedCi;
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    process.exitCode = prevExit;
    rmSync(root, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  const textOf = (stream: 'out' | 'err'): string =>
    log
      .filter((w) => w.stream === stream)
      .map((w) => w.chunk)
      .join('');

  /** The option values the menu was last opened with. */
  function offeredActions(): unknown[] {
    const last = clackMock.select.mock.calls.at(-1)?.[0] as
      | { options?: Array<{ value: unknown }> }
      | undefined;
    return (last?.options ?? []).map((o) => o.value);
  }

  describe('non-interactive runs', () => {
    it('are byte-for-byte what they were before the menu existed', async () => {
      hostAnswers();
      expect(await runCli(['run', 'hi'])).toBe(0);
      // The answer, streamed, then the newline the summary is written after —
      // and nothing else. No prompt, no menu, no extra byte.
      expect(textOf('out')).toBe('The answer is 42. Done.\n');
      expect(clackMock.select).not.toHaveBeenCalled();
      expect(clackMock.text).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
      expect(textOf('err')).not.toContain('What next?');
    });

    it('keep the answer the only thing on stdout under --quiet', async () => {
      // `--quiet` silences the stderr diagnostics; it is not an interactivity
      // switch (the menu is gated on the streams being terminals, plus
      // --json/--no-input/CI/NO_COLOR). On this run nothing is a terminal, so
      // no menu is drawn and stdout carries the answer and nothing else.
      hostAnswers();
      expect(await runCli(['run', 'hi', '--quiet'])).toBe(0);
      expect(textOf('out')).toBe('The answer is 42. Done.\n');
      expect(textOf('err')).toBe('');
      expect(clackMock.select).not.toHaveBeenCalled();
    });

    it('add the answer text and the session id to the --json envelope', async () => {
      hostAnswers();
      expect(await runCli(['run', 'hi', '--json'])).toBe(0);
      expect(textOf('err')).toBe('');
      const envelope = JSON.parse(textOf('out'));
      expect(envelope.data.answerText).toBe(ANSWER);
      expect(envelope.data.sessionId).toBe('s1');
      // Every key the envelope carried before is untouched.
      expect(envelope.data.host).toBe('claude');
      expect(envelope.data.prompt).toBe('hi');
      expect(envelope.data.exitCode).toBe(0);
      expect(envelope.data.numTurns).toBe(1);
      expect(typeof envelope.data.transcript).toBe('string');
      expect(clackMock.select).not.toHaveBeenCalled();
    });

    it('omit the session id when the host reported none', async () => {
      hostAnswers(null);
      expect(await runCli(['run', 'hi', '--json'])).toBe(0);
      const envelope = JSON.parse(textOf('out'));
      expect(envelope.data.answerText).toBe(ANSWER);
      expect('sessionId' in envelope.data).toBe(false);
    });
  });

  describe('the interactive menu', () => {
    beforeEach(() => {
      tty('out', true);
      tty('in', true);
    });

    it('offers every applicable action and dismisses to nothing', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('dismiss');
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(offeredActions()).toEqual([
        'memory',
        'research',
        'handoff',
        'resume',
        'save',
        'dismiss',
      ]);
      // Dismissing changes nothing: no seam was touched, and the exit code is
      // still the run's.
      expect(calls).toEqual([]);
      expect(handoffMock).not.toHaveBeenCalled();
      expect(textOf('out')).toBe('The answer is 42. Done.\n');
    });

    it('treats a cancelled menu as a no-op', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce(CANCEL);
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(calls).toEqual([]);
    });

    it('still offers the menu under --quiet, which silences diagnostics only', async () => {
      // Pinned deliberately: --quiet is not an interactivity switch, so a
      // terminal with prompts allowed still gets the menu. What it silences is
      // the stderr summary, not the question.
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('dismiss');
      expect(await runCli(['run', 'hi', '--quiet'])).toBe(0);
      expect(clackMock.select).toHaveBeenCalledTimes(1);
      expect(textOf('out')).toBe('The answer is 42. Done.\n');
    });

    it('exits 0 when the menu itself cannot be drawn', async () => {
      hostAnswers();
      // The prompt library throwing (or failing to load, or the terminal going
      // away between the gate and the render) must not rewrite the run's
      // result: the answer already streamed and the summary already printed.
      clackMock.select.mockRejectedValueOnce(new Error('EIO on stdin'));
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(textOf('out')).toBe('The answer is 42. Done.\n');
      expect(calls).toEqual([]);
      expect(textOf('err')).not.toContain('EIO');
    });

    it('drops the answer options when the host produced no answer text', async () => {
      // A run can succeed with no assistant text at all (tool-only turns).
      // Offering "save the answer" there would ask for content that does not
      // exist — and the memory seam would fall through to reading stdin.
      runHostMock.mockImplementationOnce(async (o: RunHostOptions) => {
        o.onEvent?.({ kind: 'init', sessionId: 's1', model: 'claude-sonnet-4' });
        o.onEvent?.({ kind: 'result', isError: false, numTurns: 1 });
        return {
          exitCode: 0,
          usage: { inputTokens: 1, outputTokens: 0, totalCostUsd: 0, numTurns: 1 },
          eventCount: 2,
          stderr: '',
          isError: false,
        };
      });
      clackMock.select.mockResolvedValueOnce('dismiss');
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(offeredActions()).toEqual(['handoff', 'resume', 'dismiss']);
    });

    it('drops the continue option when the host reported no session', async () => {
      hostAnswers(null);
      clackMock.select.mockResolvedValueOnce('dismiss');
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(offeredActions()).not.toContain('resume');
    });

    it('saves the answer text to memory, never the raw transcript', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('memory');
      expect(await runCli(['run', 'hi'])).toBe(0);
      const capture = calls.find((c) => c.name === 'memory_capture');
      expect(capture?.args).toEqual({ content: ANSWER, eventType: 'capture' });
      // The plain words, not stream-json: the transcript is not what memory is
      // asked to remember.
      expect(String(capture?.args?.content)).not.toContain('"type"');
      expect(String(capture?.args?.content)).not.toContain('session_id');
    });

    it('reports a memory write the store refused, and keeps exit 0', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('memory');
      // A degraded store: the daemon answers, but refuses the write.
      payloads.current = {
        memory_capture: { ok: false, error: 'store is read-only (daemon down)' },
      };
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(textOf('err')).toContain('store is read-only');
      expect(textOf('err')).toContain('did not complete');
    });

    it('reports an unreachable daemon instead of crashing', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('memory');
      // What the daemon client throws when nothing answers. The finished run's
      // result must survive it, and the failure must still be visible.
      failure.current = new Error('daemon not reachable — try `noir daemon start`');
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(textOf('err')).toContain('daemon not reachable');
      expect(textOf('err')).toContain('did not complete');
    });

    it('records the answer as task research, capped to what the daemon accepts', async () => {
      runHostMock.mockImplementationOnce(async (o: RunHostOptions) =>
        cleanRunWith('x'.repeat(400), o, 's1'),
      );
      clackMock.select.mockResolvedValueOnce('research');
      expect(await runCli(['run', 'hi'])).toBe(0);
      const record = calls.find((c) => c.name === 'workflow_research_record');
      expect(record?.args?.type).toBe('discovery');
      expect(record?.args?.source).toBe('noir run');
      const text = String(record?.args?.text);
      expect(text.length).toBeLessThanOrEqual(220);
      expect(text.startsWith('xxx')).toBe(true);
    });

    it('writes a handoff artifact through the handoff seam', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('handoff');
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(handoffMock).toHaveBeenCalledTimes(1);
      expect(handoffMock.mock.calls[0]?.[0]).toMatchObject({ write: true });
    });

    it('writes the answer text to the chosen file', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('save');
      clackMock.text.mockResolvedValueOnce('answer.md');
      expect(await runCli(['run', 'hi'])).toBe(0);
      const written = readFileSync(join(root, 'answer.md'), 'utf8');
      expect(written).toBe(`${ANSWER}\n`);
      expect(textOf('err')).toContain('Answer written to');
    });

    it('falls back to a generated file name when the path is left empty', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('save');
      clackMock.text.mockResolvedValueOnce('');
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(textOf('err')).toMatch(/noir-run-.*\.md/);
    });

    it('continues the session with a freshly collected prompt', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('resume').mockResolvedValueOnce('dismiss');
      clackMock.text.mockResolvedValueOnce('and the tests?');
      runHostMock.mockImplementationOnce(async (o: RunHostOptions) =>
        cleanRunWith('Tests are next.', o, 's1'),
      );
      expect(await runCli(['run', 'hi'])).toBe(0);

      // A new single-shot invocation: the same host, driven with the id of the
      // session just finished and the prompt the user typed.
      expect(runHostMock).toHaveBeenCalledTimes(2);
      const second = runHostMock.mock.calls[1]?.[0];
      expect(second?.prompt).toBe('and the tests?');
      expect(second?.extraArgs).toEqual(['--resume', 's1']);

      // Both answers reached stdout, so the follow-up is rendered like any run:
      // streamed, then finished with the newline the summary follows.
      expect(textOf('out')).toBe('The answer is 42. Done.\nTests are next. Done.\n');

      // The menu comes back once, and the second time it cannot nest again.
      expect(clackMock.select).toHaveBeenCalledTimes(2);
      expect(offeredActions()).not.toContain('resume');
    });

    it('does not continue when the prompt is left empty', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('resume');
      clackMock.text.mockResolvedValueOnce('   ');
      expect(await runCli(['run', 'hi'])).toBe(0);
      expect(runHostMock).toHaveBeenCalledTimes(1);
      expect(textOf('err')).toContain('the session was not continued');
    });

    it('reports a failed continuation without rewriting the run result', async () => {
      hostAnswers();
      clackMock.select.mockResolvedValueOnce('resume');
      clackMock.text.mockResolvedValueOnce('do it again');
      runHostMock.mockImplementationOnce(async (o: RunHostOptions) => {
        void o;
        return {
          exitCode: 1,
          usage: { inputTokens: 1, outputTokens: 0, totalCostUsd: 0, numTurns: 1 },
          eventCount: 1,
          stderr: '',
          isError: true,
          errorText: 'connection reset',
        };
      });
      // The first run succeeded, so the exit code stays 0 — the failure is of
      // the follow-up, and it is reported rather than swallowed.
      expect(await runCli(['run', 'hi'])).toBe(0);
      // Reported once — a failure that already printed its own diagnostic is
      // never echoed back a second time.
      expect(textOf('err').split('failed (exit 1)').length - 1).toBe(1);
      expect(textOf('err')).toContain('did not complete');
    });
  });
});

// The action set is one definition with two surfaces. The terminal prompt
// collects a follow-up prompt itself, so it can continue whenever the host
// reported a session id. A surface that continues in place — the dashboard's
// run screen starts another turn on the same screen — has no seam to hand over,
// and says so with `canContinue` instead.
describe('the shared action set', () => {
  const base = { answer: ANSWER, transcript: '/tmp/t.jsonl', host: 'claude', opts: {} };

  it('offers a continuation when the surface continues it itself', () => {
    const values = postRunActions({ ...base, sessionId: 's1', canContinue: true }).map(
      (o) => o.value,
    );
    expect(values).toContain('resume');
  });

  it('drops the continuation when the surface says there is none', () => {
    const values = postRunActions({
      ...base,
      sessionId: 's1',
      canContinue: false,
      resume: async () => {},
    }).map((o) => o.value);
    expect(values).not.toContain('resume');
  });

  it('offers nothing to save for a run that produced no answer', () => {
    const values = postRunActions({ ...base, answer: '   ' }).map((o) => o.value);
    expect(values).toEqual(['handoff', 'dismiss']);
  });
});
