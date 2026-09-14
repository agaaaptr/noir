// `noir run` under an interrupt: what Ctrl+C, or a SIGTERM from whatever
// started Noir, actually does.
//
// The command drives a host child, so an interrupt has to stop the CHILD and
// then report the run as interrupted — never exit with the host still running,
// and never report a deliberately stopped host as a failure. Offline: runHost is
// replaced by a stand-in that hands over a fake child and settles when that
// child is signalled, so the exit codes, the message and the transcript are
// asserted without a host, a TTY, or a real signal.

import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { HostChild, RunHostOptions, RunHostResult } from '../src/orchestrator.js';

/** The child the stubbed spawn produces: it records signals and dies. */
class FakeChild extends EventEmitter implements HostChild {
  readonly signals: NodeJS.Signals[] = [];
  readonly pid = 4242;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    // A real child dies a moment later, and that close is what ends the run.
    queueMicrotask(() => this.emit('exit'));
    return true;
  }
}

let current: FakeChild | undefined;

const { runHostMock } = vi.hoisted(() => ({ runHostMock: vi.fn() }));
vi.mock('../src/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/orchestrator.js')>();
  return { ...actual, runHost: runHostMock };
});

import { createProgram } from '../src/bin.js';
import { handleError } from '../src/output.js';

/** Drive a fresh commander program, exactly as the bin entry does. */
async function runCli(argv: readonly string[]): Promise<number> {
  const program = createProgram();
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    handleError(err);
  }
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

/** Let the run get as far as its spawn, and no further. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('noir run — the interrupt contract', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  let stdout: MockInstance<typeof process.stdout.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let tmp: string;
  let prevExit: typeof process.exitCode;

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    current = undefined;
    tmp = mkdtempSync(join(tmpdir(), 'noir-run-interrupt-'));
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    runHostMock.mockReset();
    // A host that runs until something stops it, and reports the kill the way
    // the real orchestrator does (128 + the signal that ended it).
    runHostMock.mockImplementation(async (opts: RunHostOptions): Promise<RunHostResult> => {
      const child = new FakeChild();
      current = child;
      opts.onChild?.(child);
      opts.onLine?.('{"type":"system","subtype":"init","session_id":"s1"}');
      await new Promise<void>((resolve) => child.once('exit', resolve));
      return {
        exitCode: 143,
        usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0, numTurns: 1 },
        eventCount: 1,
        stderr: '',
        isError: true,
        errorText: 'terminated by signal SIGTERM',
      };
    });
  });

  afterEach(() => {
    stderr.mockRestore();
    stdout.mockRestore();
    cwd.mockRestore();
    process.exitCode = prevExit;
    runHostMock.mockReset();
    rmSync(tmp, { recursive: true, force: true });
  });

  const stderrText = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');
  const stdoutText = (): string => stdout.mock.calls.map((c) => String(c[0])).join('');
  const transcripts = (): { name: string; body: string }[] =>
    readdirSync(join(tmp, '.noir', 'transcripts')).map((name) => ({
      name,
      body: readFileSync(join(tmp, '.noir', 'transcripts', name), 'utf8'),
    }));

  it('stops the host on SIGINT, keeps the transcript, and exits 130', async () => {
    const listenersBefore = process.listenerCount('SIGINT');
    const done = runCli(['run', 'why is the build slow']);
    await flush();
    expect(current).toBeDefined();

    process.emit('SIGINT');
    const code = await done;

    // 128 + 2: the conventional report of "a SIGINT ended this".
    expect(code).toBe(130);
    expect(current?.signals).toEqual(['SIGTERM']);

    // The record of the run survives the interrupt, and the message says where.
    const written = transcripts();
    expect(written).toHaveLength(1);
    expect(written[0]?.body).toContain('"subtype":"init"');
    expect(stderrText()).toContain(
      `interrupted · transcript: ${join(tmp, '.noir', 'transcripts', written[0]?.name ?? '')}`,
    );

    // Interrupted is not failed: the host did as it was told.
    expect(stderrText()).not.toContain('failed (exit');
    expect(stderrText()).not.toContain('usage:');

    // And the run does not leave the process's signal handling changed.
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
  });

  it('stops the host on SIGTERM and exits 143', async () => {
    const listenersBefore = process.listenerCount('SIGTERM');
    const done = runCli(['run', 'why is the build slow']);
    await flush();

    process.emit('SIGTERM');
    const code = await done;

    expect(code).toBe(143);
    expect(current?.signals).toEqual(['SIGTERM']);
    expect(stderrText()).toContain('interrupted · transcript: ');
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore);
  });

  it('reports the interrupt under --json as one clean envelope, never stray text', async () => {
    const done = runCli(['run', 'why is the build slow', '--json']);
    await flush();

    process.emit('SIGINT');
    const code = await done;

    expect(code).toBe(130);
    // One line on stdout, and it is the envelope — a scripted consumer reads a
    // machine answer, not a human sentence about a keystroke.
    const lines = stdoutText()
      .split('\n')
      .filter((line) => line.length > 0);
    expect(lines).toHaveLength(1);
    const envelope = JSON.parse(lines[0] as string) as {
      ok: boolean;
      error: { code: number; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe(130);
    expect(envelope.error.message).toContain('interrupted · transcript: ');
  });

  it('reports the interrupt under --quiet — the verdict carries signal', async () => {
    const done = runCli(['run', 'why is the build slow', '--quiet']);
    await flush();

    process.emit('SIGINT');
    const code = await done;

    expect(code).toBe(130);
    // --quiet silences progress and the summary, not a terminal verdict: the run
    // was stopped on purpose and the record of it must still be named.
    expect(stderrText()).toContain('interrupted · transcript: ');
    expect(stdoutText()).toBe('');
  });

  it('reports the stop, not a failure, when the spawn fails while stopping', async () => {
    // The host never got going (its binary is gone), and the stop landed anyway.
    // The user asked for the run to end; blaming the host for that would be wrong.
    runHostMock.mockImplementationOnce(async (opts: RunHostOptions): Promise<RunHostResult> => {
      const child = new FakeChild();
      current = child;
      opts.onChild?.(child);
      await new Promise<void>((resolve) => child.once('exit', resolve));
      const err = new Error('spawn claude ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    const done = runCli(['run', 'why is the build slow']);
    await flush();

    process.emit('SIGINT');
    const code = await done;

    expect(code).toBe(130);
    expect(stderrText()).toContain('interrupted · transcript: ');
    expect(stderrText()).not.toContain('failed to run');
    expect(stderrText()).not.toContain('No executable');
  });

  it('leaves a run that is never interrupted exactly as it was', async () => {
    // The interrupt handlers must not change an ordinary run: the same exit
    // code, the same summary, and no transcript copy in the message.
    runHostMock.mockImplementationOnce(async (opts: RunHostOptions): Promise<RunHostResult> => {
      opts.onChild?.(new FakeChild());
      return {
        exitCode: 0,
        usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0, numTurns: 1 },
        eventCount: 1,
        stderr: '',
        isError: false,
      };
    });
    const code = await runCli(['run', 'why is the build slow']);

    expect(code).toBe(0);
    expect(stderrText()).toContain('usage:');
    expect(stderrText()).not.toContain('interrupted');
  });
});
