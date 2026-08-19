// bin.run applies .noir/.env at process start (Slice E wiring): the CLI entry
// loads project-local env vars into process.env before any command runs, so
// tokens reach the host spawn and the daemon regardless of launch context.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});
