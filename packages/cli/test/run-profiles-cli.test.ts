// CLI integration for run profiles (Slice D): a project with `run.profiles` in
// .noir/config.yml resolves the host binary + merged env through the real
// commander tree; `--list-profiles` prints the table. Drives the real run.ts
// with a mocked runHost (offline) and a temp project root.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function runCli(argv: readonly string[]): Promise<number> {
  const program = createProgram();
  try {
    await program.parseAsync([...argv], { from: 'user' });
  } catch (err) {
    handleError(err);
  }
  return typeof process.exitCode === 'number' ? process.exitCode : 0;
}

describe('noir run — run profiles (CLI)', () => {
  let stderr: MockInstance<typeof process.stderr.write>;
  let stdout: MockInstance<typeof process.stdout.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let root: string;
  let prevExit: typeof process.exitCode;

  function writeProject(configYaml: string): void {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(join(root, '.noir', 'project.id'), 'proj-run-profiles\n', 'utf8');
    writeFileSync(join(root, '.noir', 'config.yml'), configYaml, 'utf8');
  }

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    root = mkdtempSync(join(tmpdir(), 'noir-profiles-'));
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderr.mockRestore();
    stdout.mockRestore();
    cwd.mockRestore();
    process.exitCode = prevExit;
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const stderrText = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');
  const stdoutText = (): string => stdout.mock.calls.map((c) => String(c[0])).join('');

  it('--profile resolves the profile binary + merged env and passes them to runHost', async () => {
    writeProject(`run:
  profiles:
    work:
      binary: /usr/bin/claude-work
      env:
        CLAUDE_CONFIG_DIR: /tmp/cc-work
`);
    const code = await runCli(['run', '--profile', 'work', 'hello']);
    expect(code).toBe(0);
    expect(runHostMock).toHaveBeenCalledTimes(1);
    const arg = runHostMock.mock.calls[0]?.[0] as {
      customBinary?: string;
      env?: Record<string, string | undefined>;
    };
    expect(arg.customBinary).toBe('/usr/bin/claude-work');
    expect(arg.env?.CLAUDE_CONFIG_DIR).toBe('/tmp/cc-work');
  });

  it('NOIR_PROFILE env selects a profile when no --profile flag is given', async () => {
    writeProject(`run:
  defaultProfile: work
  profiles:
    work:
      binary: /usr/bin/claude-work
`);
    const prev = process.env.NOIR_PROFILE;
    process.env.NOIR_PROFILE = 'work';
    try {
      const code = await runCli(['run', 'hello']);
      expect(code).toBe(0);
      expect(runHostMock.mock.calls[0]?.[0]?.customBinary).toBe('/usr/bin/claude-work');
    } finally {
      if (prev === undefined) delete process.env.NOIR_PROFILE;
      else process.env.NOIR_PROFILE = prev;
    }
  });

  it('run.defaultProfile is used when nothing is requested', async () => {
    writeProject(`run:
  defaultProfile: work
  profiles:
    work:
      binary: /usr/bin/claude-work
`);
    const code = await runCli(['run', 'hello']);
    expect(code).toBe(0);
    expect(runHostMock.mock.calls[0]?.[0]?.customBinary).toBe('/usr/bin/claude-work');
  });

  it('an explicit --command wins over the profile binary', async () => {
    writeProject(`run:
  profiles:
    work: { binary: /usr/bin/claude-work }
`);
    const code = await runCli(['run', '--profile', 'work', '--command', 'claude-custom', 'hello']);
    expect(code).toBe(0);
    expect(runHostMock.mock.calls[0]?.[0]?.customBinary).toBe('claude-custom');
  });

  it('an unknown --profile exits 2 with a message listing available profiles', async () => {
    writeProject(`run:
  profiles:
    work: { binary: /usr/bin/claude-work }
    lab: { binary: claude }
`);
    const code = await runCli(['run', '--profile', 'nope', 'hello']);
    expect(code).toBe(2);
    const err = stderrText();
    expect(err).toContain('unknown run profile "nope"');
    expect(err).toContain('work');
    expect(err).toContain('lab');
    expect(runHostMock).not.toHaveBeenCalled();
  });

  it('--list-profiles prints NAME / DEFAULT / BINARY and does not run', async () => {
    writeProject(`run:
  defaultProfile: work
  profiles:
    work: { binary: /usr/bin/claude-work }
    lab: { binary: claude }
`);
    const code = await runCli(['run', '--list-profiles']);
    expect(code).toBe(0);
    // The table helper renders to stderr (S9 stream discipline).
    expect(stderrText()).toContain('NAME');
    expect(stderrText()).toContain('work');
    expect(stdoutText()).toBe('');
    expect(runHostMock).not.toHaveBeenCalled();
  });

  it('works outside a project (no .noir) with the built-in default', async () => {
    // No .noir in root — loadRunConfig returns null; run must still succeed.
    const code = await runCli(['run', 'hello']);
    expect(code).toBe(0);
    expect(runHostMock).toHaveBeenCalledTimes(1);
  });
});
