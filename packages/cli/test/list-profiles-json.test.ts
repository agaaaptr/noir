// `noir run --list-profiles --json` contract (S9): under --json, machine data
// goes to STDOUT as a JSON envelope — a table()/info() call is silenced in json
// mode, so the command used to print nothing at all. Regression for the
// verification pass (2026-08-19).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
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

describe('noir run --list-profiles --json', () => {
  let stdout: MockInstance<typeof process.stdout.write>;
  let stderr: MockInstance<typeof process.stderr.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let root: string;
  let prevExit: typeof process.exitCode;

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    root = mkdtempSync(join(tmpdir(), 'noir-lp-json-'));
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(join(root, '.noir', 'project.id'), 'proj-lp\n', 'utf8');
    writeFileSync(
      join(root, '.noir', 'config.yml'),
      'run:\n  defaultProfile: work\n  profiles:\n    work: { binary: /bin/claude-work }\n    lab: { binary: claude }\n',
      'utf8',
    );
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    cwd.mockRestore();
    process.exitCode = prevExit;
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('emits the profiles as one JSON envelope on stdout', async () => {
    const code = await runCli(['run', '--list-profiles', '--json']);
    expect(code).toBe(0);
    const out = stdout.mock.calls.map((c) => String(c[0])).join('');
    const parsed = JSON.parse(out) as {
      ok: boolean;
      data: Array<{ NAME: string; DEFAULT: string; BINARY: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]?.NAME).toBe('work');
    expect(parsed.data[0]?.DEFAULT).toBe('*');
    expect(parsed.data[1]?.NAME).toBe('lab');
  });

  it('emits an empty array (ok:true) when no profiles are configured', async () => {
    // Rewrite the config without a run block (outside-project behavior is the
    // same path — loadRunConfig falls back to the empty default config).
    writeFileSync(join(root, '.noir', 'config.yml'), 'host: claude\n', 'utf8');
    const code = await runCli(['run', '--list-profiles', '--json']);
    expect(code).toBe(0);
    const out = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(JSON.parse(out)).toEqual({ ok: true, data: [] });
  });
});
