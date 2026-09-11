// bin.run applies .noir/.env at process start (Slice E wiring): the CLI entry
// loads project-local env vars into process.env before any command runs, so
// tokens reach the host spawn and the daemon regardless of launch context.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { run as runCli } from '../src/bin.js';

describe('bin.run — applies .noir/.env at process start', () => {
  let root: string;
  let cwd: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'noir-env-cli-'));
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(join(root, '.noir', '.env'), 'CLI_ENV_TEST=from-file\n', 'utf8');
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
  });

  afterEach(() => {
    cwd.mockRestore();
    delete process.env.CLI_ENV_TEST;
    delete process.env.CLI_ENV_PROFILE_TEST;
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('loads .noir/.env into process.env before the command runs', async () => {
    expect(process.env.CLI_ENV_TEST).toBeUndefined();
    const code = await runCli(['run', 'hello']);
    expect(code).toBe(0);
    expect(process.env.CLI_ENV_TEST).toBe('from-file');
    expect(runHostMock).toHaveBeenCalledTimes(1);
  });

  it('a run profile env still merges OVER .noir/.env and the ambient env (F7)', async () => {
    // The one documented carve-out from the spec 12.1 precedence ladder: a
    // profile's `env` is applied last, to the spawned child only.
    process.env.CLI_ENV_PROFILE_TEST = 'from_shell';
    writeFileSync(join(root, '.noir', '.env'), 'CLI_ENV_PROFILE_TEST=from_file\n', 'utf8');
    // `loadRunConfig` reads the project record, so the profile only resolves in
    // an initialized project (mirrors run-profiles-cli.test.ts).
    writeFileSync(join(root, '.noir', 'project.id'), 'env-file-cli-profile\n', 'utf8');
    writeFileSync(
      join(root, '.noir', 'config.yml'),
      [
        'run:',
        '  profiles:',
        '    lab:',
        '      binary: claude',
        '      env:',
        '        CLI_ENV_PROFILE_TEST: from_profile',
        '',
      ].join('\n'),
      'utf8',
    );
    const code = await runCli(['run', '--profile', 'lab', 'hello']);
    expect(code).toBe(0);
    // The file beat the shell in Noir's own env...
    expect(process.env.CLI_ENV_PROFILE_TEST).toBe('from_file');
    // ...and the profile overlay beat both, in the child's env.
    expect(runHostMock).toHaveBeenCalledTimes(1);
    expect(runHostMock.mock.calls[0]?.[0].env?.CLI_ENV_PROFILE_TEST).toBe('from_profile');
  });
});
