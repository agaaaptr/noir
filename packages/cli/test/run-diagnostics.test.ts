// `noir run` credential diagnostics (spec 13). The auth branch used to key on
// `ANTHROPIC_API_KEY` alone, so a custom gateway (`ANTHROPIC_AUTH_TOKEN` +
// `ANTHROPIC_BASE_URL`) got a bare "run /login" — the wrong remedy for a
// non-interactive API-key setup. These tests pin the broadened shape, the
// source-naming (`.noir/.env` vs the environment, spec 13.2), the names-only
// rule (spec G4), and the uninitialized-project notice (spec 13.3).
//
// Offline: drives the real commander tree + run.ts with a mocked runHost — no
// host is ever spawned, and no network or key is needed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** The credential shapes `noir run` must know about — scrubbed per test. */
const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

describe('noir run — credential diagnostics', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  let stdout: MockInstance<typeof process.stdout.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let tmp: string;
  let prevExit: typeof process.exitCode;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    // The real process.env is shared across tests (and the bin's preAction
    // writes `.noir/.env` into it), so scrub + restore the credentials we touch.
    savedEnv = {};
    for (const name of CREDENTIAL_VARS) {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
    tmp = mkdtempSync(join(tmpdir(), 'noir-run-diag-'));
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    stdout.mockRestore();
    cwd.mockRestore();
    process.exitCode = prevExit;
    for (const name of CREDENTIAL_VARS) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    vi.clearAllMocks();
    rmSync(tmp, { recursive: true, force: true });
  });

  const stderrText = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');
  const stdoutText = (): string => stdout.mock.calls.map((c) => String(c[0])).join('');

  /** Queue ONE authentication failure on the host side (no host is spawned). */
  function hostAuthFailure(errorText = 'Invalid API key · Please run /login'): void {
    runHostMock.mockResolvedValueOnce({
      exitCode: 1,
      usage: { inputTokens: 0, outputTokens: 0, totalCostUsd: 0, numTurns: 1 },
      eventCount: 1,
      stderr: '',
      isError: true,
      errorCategory: 'authentication_failed',
      errorText,
    });
  }

  /** Run `noir run hi` expecting one auth failure; returns the exit code. */
  async function runExpectingFailure(argv: readonly string[] = ['run', 'hi']): Promise<number> {
    process.exitCode = undefined;
    hostAuthFailure();
    return runCli(argv);
  }

  /** Write `.noir/.env` the way `noir init` does — mode 0600, no advisory. */
  function writeNoirEnv(contents: string): void {
    mkdirSync(join(tmp, '.noir'), { recursive: true });
    writeFileSync(join(tmp, '.noir', '.env'), contents, { mode: 0o600 });
  }

  it('explains a gateway credential failure, not just ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_AUTH_TOKEN = 'sk-test';
    process.env.ANTHROPIC_BASE_URL = 'https://gw.example';
    expect(await runExpectingFailure()).toBe(1);
    const err = stderrText();
    expect(err).toMatch(/ANTHROPIC_AUTH_TOKEN/);
    expect(err).toMatch(/ANTHROPIC_BASE_URL/);
    // Still the auth story — the login hint is not replaced, it is completed.
    expect(err).toContain('claude /login');
  });

  it('names .noir/.env as the source when the credential came from there', async () => {
    writeNoirEnv('ANTHROPIC_AUTH_TOKEN=sk-test\n');
    expect(await runExpectingFailure()).toBe(1);
    // Pointing at the shell here would be actively misleading: applyNoirEnv
    // re-injects the file's key on every invocation.
    expect(stderrText()).toContain('ANTHROPIC_AUTH_TOKEN (from .noir/.env)');
  });

  it('names the environment as the source when the shell supplied it', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-present';
    expect(await runExpectingFailure()).toBe(1);
    expect(stderrText()).toContain('ANTHROPIC_API_KEY (from the environment)');
  });

  it('never prints a credential value — from the environment or from .noir/.env', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env-secret';
    expect(await runExpectingFailure()).toBe(1);
    expect(stderrText()).toContain('ANTHROPIC_API_KEY');
    expect(stderrText()).not.toContain('sk-env-secret');

    writeNoirEnv('ANTHROPIC_AUTH_TOKEN=sk-file-secret\n');
    expect(await runExpectingFailure()).toBe(1);
    expect(stderrText()).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(stderrText()).not.toContain('sk-file-secret');
    expect(stdoutText()).not.toContain('sk-file-secret');
  });

  it('says nothing extra when no credential shape is set', async () => {
    expect(await runExpectingFailure()).toBe(1);
    const err = stderrText();
    expect(err).toContain('claude /login');
    expect(err).not.toMatch(/ANTHROPIC_(API_KEY|AUTH_TOKEN|BASE_URL)/);
  });

  it('notices an uninitialized project on stderr, and never fails the run', async () => {
    // Default mock: the host succeeds — the notice is informational, so the
    // run still exits 0.
    expect(await runCli(['run', 'hi'])).toBe(0);
    const err = stderrText();
    expect(err).toMatch(/noir init/);
    expect(err).toContain('.noir/.env');
  });

  it('stays silent about the uninitialized project under --json', async () => {
    expect(await runCli(['run', 'hi', '--json'])).toBe(0);
    expect(stderrText()).not.toMatch(/noir init/);
    expect(stdoutText()).toContain('"ok":true');
  });

  it('says nothing about init when .noir/.env already exists', async () => {
    writeNoirEnv('# credentials go here\n');
    expect(await runCli(['run', 'hi'])).toBe(0);
    expect(stderrText()).not.toMatch(/noir init/);
  });
});
