// `noir run` host-failure contract: a failed host run must exit non-zero, emit
// an actionable stderr message (not a "usage" success line), and report
// {ok:false} under --json — the shipped v1.11.2 behavior returned exit 0 with
// {ok:true} and streamed the auth error as if it were the answer. Drives the
// real commander tree + run.ts with a mocked runHost (offline, no host spawn).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import type { RunHostResult } from '../src/orchestrator.js';

const { runHostMock } = vi.hoisted(() => ({
  runHostMock: vi.fn(
    async (): Promise<RunHostResult> => ({
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

/**
 * Drive a FRESH commander program (mirroring bin.run's parse→handleError→exit
 * contract). A fresh program per invocation avoids commander global-option
 * leakage across parses on the singleton — e.g. a prior test's `--json` would
 * otherwise stay set on the shared `program` and change fail()'s routing.
 */
async function runCli(argv: readonly string[]): Promise<number> {
  const program = createProgram();
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    handleError(err);
  }
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

describe('noir run — host-failure contract', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  let stdout: MockInstance<typeof process.stdout.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let tmp: string;
  let prevExit: typeof process.exitCode;

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    tmp = mkdtempSync(join(tmpdir(), 'noir-run-test-'));
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    stdout.mockRestore();
    cwd.mockRestore();
    process.exitCode = prevExit;
    vi.clearAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const stderrText = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');
  const stdoutText = (): string => stdout.mock.calls.map((c) => String(c[0])).join('');

  it('exits 1, emits an actionable message, and prints NO usage line when the host fails', async () => {
    runHostMock.mockResolvedValueOnce({
      exitCode: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, numTurns: 1 },
      eventCount: 1,
      stderr: '',
      isError: true,
      errorText: 'Not logged in · Please run /login',
    });
    const code = await runCli(['run', 'test']);
    expect(code).toBe(1);
    expect(process.exitCode).toBe(1);
    const err = stderrText();
    expect(err).toContain("host 'claude' failed (exit 1)");
    expect(err).toContain('Not logged in · Please run /login');
    expect(err).toContain('claude /login');
    expect(err).toContain('--command');
    expect(err).not.toContain('usage:');
  });

  it('exits 1 via isError alone (host exited 0 but stream signalled is_error)', async () => {
    runHostMock.mockResolvedValueOnce({
      exitCode: 0,
      usage: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, numTurns: 1 },
      eventCount: 1,
      stderr: '',
      isError: true,
      errorText: 'overloaded, retry',
    });
    const code = await runCli(['run', 'test']);
    expect(code).toBe(1);
    expect(stderrText()).toContain('host');
    expect(stderrText()).not.toContain('usage:');
  });

  it('--json reports {ok:false,error} with exit 1 on host failure', async () => {
    runHostMock.mockResolvedValueOnce({
      exitCode: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, numTurns: 1 },
      eventCount: 1,
      stderr: '',
      isError: true,
      errorText: 'Not logged in · Please run /login',
    });
    const code = await runCli(['run', 'test', '--json']);
    expect(code).toBe(1);
    const out = stdoutText();
    expect(out).toContain('"ok":false');
    expect(out).toContain('Not logged in · Please run /login');
    // No ok:true envelope anywhere.
    expect(out).not.toContain('"ok":true');
    expect(stderrText()).toBe('');
  });

  it('a clean run still exits 0 with the usage line (success path unchanged)', async () => {
    runHostMock.mockResolvedValueOnce({
      exitCode: 0,
      usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0, numTurns: 1 },
      eventCount: 1,
      stderr: '',
      isError: false,
      errorText: undefined,
    });
    const code = await runCli(['run', 'test']);
    expect(code).toBe(0);
    expect(stderrText()).toContain('usage:');
  });

  it('a missing --command binary fails with a message naming the custom binary, not the host', async () => {
    runHostMock.mockRejectedValueOnce(
      Object.assign(new Error('spawn claude-work ENOENT'), { code: 'ENOENT' }),
    );
    const code = await runCli(['run', 'test', '--command', 'claude-work']);
    expect(code).toBe(1);
    const err = stderrText();
    expect(err).toContain('claude-work');
    expect(err).toContain('ENOENT');
    // The misleading "failed to run host 'claude'" wording is gone.
    expect(err).not.toContain("failed to run host 'claude'");
  });

  it('the empty-prompt usage message echoes a configured --command', async () => {
    const code = await runCli(['run', '--command', 'claude-work']);
    expect(code).toBe(2);
    expect(stderrText()).toContain('--command claude-work');
  });
});
