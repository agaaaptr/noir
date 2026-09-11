// Task 14 — `noir env` + per-key provenance in `noir doctor`.
//
// Drives the REAL commander tree (`createProgram`) so the bin's `preAction` is
// part of what is under test: it captures the ambient baseline `noir env`
// reports `shadowed` from, and it applies `.noir/.env` to `process.env` exactly
// as a shipped `noir` invocation does.
//
// HARD RULE asserted throughout: the command prints NAMES and a redacted SHAPE
// (first three characters + length) — never a value. Every test that installs a
// fake secret asserts the full string is absent from stdout AND stderr.
//
// Offline + free: tmp roots, no daemon, no network, no ~/.noir.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from 'vitest';
import { createProgram } from '../src/bin.js';
import { type CheckResult, doctor } from '../src/commands/doctor.js';
import { CURATED_AMBIENT_KEYS, type EnvVarRow } from '../src/commands/env.js';
import { handleError } from '../src/output.js';

/**
 * Drive a FRESH commander program (mirroring bin.run's parse→handleError→exit
 * contract). A fresh program per invocation avoids commander global-option
 * leakage across parses on the singleton — e.g. a prior test's `--json` would
 * otherwise stay set on the shared `program`.
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

/** A fake ambient name the project config will name via `apiKeyEnv`. */
const CONFIG_KEY = 'NOIR_ENV_TEST_CONFIG_KEY';
/** A fake ambient name that appears in NO allowlist. */
const UNLISTED_KEY = 'NOIR_ENV_TEST_UNLISTED_KEY';
/** Every ambient name this file manipulates, restored verbatim afterwards. */
const MANAGED_KEYS: readonly string[] = [...CURATED_AMBIENT_KEYS, CONFIG_KEY, UNLISTED_KEY];

/** The value strings used by the tests — asserted absent from every stream. */
const FILE_SECRET = 'pk_secret_value_abcdefghij';
const AMBIENT_SECRET = 'sk-ambient-value-abcdefghij';

/** Find a row by key, failing loudly (with a type-narrowing guard) when absent. */
function rowOf(vars: readonly EnvVarRow[], key: string): EnvVarRow {
  const row = vars.find((v) => v.key === key);
  expect(row, `row '${key}' should be present`).toBeDefined();
  if (!row) throw new Error(`row '${key}' not found in the env payload`);
  return row;
}

/** The `doctor` check row with this name. */
function checkOf(checks: readonly CheckResult[], name: string): CheckResult {
  const row = checks.find((c) => c.name === name);
  expect(row, `check '${name}' should be present`).toBeDefined();
  if (!row) throw new Error(`check '${name}' not found in the doctor payload`);
  return row;
}

const gitAvailable = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Keep daemon-record lookups out of the developer's real ~/.noir (doctor reads
// it), and out of the tmp roots the tests delete.
const daemonDir = mkdtempSync(join(tmpdir(), 'noir-env-cmd-daemon-'));
process.env.NOIR_DAEMON_DIR = daemonDir;

describe('noir env', () => {
  let root: string;
  let envPath: string;
  let stderr: MockInstance<typeof process.stderr.write>;
  let stdout: MockInstance<typeof process.stdout.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let prevExit: typeof process.exitCode;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    root = mkdtempSync(join(tmpdir(), 'noir-env-cmd-'));
    mkdirSync(join(root, '.noir'), { recursive: true });
    envPath = join(root, '.noir', '.env');
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // The developer's own shell must not decide these assertions: clear every
    // name the command can report, and restore it afterwards.
    saved = {};
    for (const key of MANAGED_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    stderr.mockRestore();
    stdout.mockRestore();
    cwd.mockRestore();
    process.exitCode = prevExit;
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const stderrText = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');
  const stdoutText = (): string => stdout.mock.calls.map((c) => String(c[0])).join('');

  it('reports the winning source per key and never prints a value', async () => {
    writeFileSync(envPath, `CLICKUP_API_TOKEN=${FILE_SECRET}\n`, 'utf8');
    process.env.ANTHROPIC_API_KEY = AMBIENT_SECRET;

    const code = await runCli(['env', '--json']);

    expect(code).toBe(0);
    const data = JSON.parse(stdoutText()).data;
    expect(rowOf(data.vars, 'CLICKUP_API_TOKEN').source).toBe('file');
    expect(rowOf(data.vars, 'ANTHROPIC_API_KEY').source).toBe('env');
    const all = stdoutText() + stderrText();
    expect(all).not.toContain(FILE_SECRET);
    expect(all).not.toContain(AMBIENT_SECRET);
  });

  it('--json is a pure projection: key/source/valueLength, never a shape', async () => {
    writeFileSync(envPath, `CLICKUP_API_TOKEN=${FILE_SECRET}\n`, 'utf8');

    const code = await runCli(['env', '--json']);

    expect(code).toBe(0);
    const row = rowOf(JSON.parse(stdoutText()).data.vars, 'CLICKUP_API_TOKEN');
    expect(Object.keys(row).sort()).toEqual(['key', 'source', 'valueLength']);
    expect(row.valueLength).toBe(FILE_SECRET.length);
    // The redacted shape (which carries the first three characters) is
    // human-table-only — it must not appear in the machine payload.
    expect(stdoutText()).not.toContain('pk_');
  });

  it('never enumerates the ambient environment — unlisted names are not reported', async () => {
    process.env[UNLISTED_KEY] = 'pk_unlisted_value';

    const code = await runCli(['env', '--json']);

    expect(code).toBe(0);
    const vars: EnvVarRow[] = JSON.parse(stdoutText()).data.vars;
    expect(vars.find((v) => v.key === UNLISTED_KEY)).toBeUndefined();
    // `sources` records EVERY ambient name ('env'); PATH is the canary that the
    // curated allowlist — not a dump — decides what is rendered.
    expect(vars.find((v) => v.key === 'PATH')).toBeUndefined();
    expect(stdoutText()).not.toContain('pk_unlisted_value');
  });

  it('reports curated ambient keys even when there is no .noir/.env at all', async () => {
    expect(existsSync(envPath)).toBe(false);
    process.env.ANTHROPIC_API_KEY = AMBIENT_SECRET;

    const code = await runCli(['env', '--json']);

    expect(code).toBe(0);
    expect(rowOf(JSON.parse(stdoutText()).data.vars, 'ANTHROPIC_API_KEY').source).toBe('env');
    expect(stdoutText() + stderrText()).not.toContain(AMBIENT_SECRET);
  });

  it('marks a file key that overrides a DIFFERENT ambient value as shadowed', async () => {
    writeFileSync(envPath, `CLICKUP_API_TOKEN=${FILE_SECRET}\n`, 'utf8');
    process.env.CLICKUP_API_TOKEN = 'pk_from_shell_value';

    const code = await runCli(['env', '--json']);

    expect(code).toBe(0);
    const row = rowOf(JSON.parse(stdoutText()).data.vars, 'CLICKUP_API_TOKEN');
    expect(row.source).toBe('file');
    expect(row.shadowed).toBe(true);
    expect(row.valueLength).toBe(FILE_SECRET.length);
    const all = stdoutText() + stderrText();
    expect(all).not.toContain(FILE_SECRET);
    expect(all).not.toContain('pk_from_shell_value');
  });

  it('does not mark a file key shadowed when the ambient value agrees', async () => {
    writeFileSync(envPath, `CLICKUP_API_TOKEN=${FILE_SECRET}\n`, 'utf8');
    process.env.CLICKUP_API_TOKEN = FILE_SECRET;

    const code = await runCli(['env', '--json']);

    expect(code).toBe(0);
    const row = rowOf(JSON.parse(stdoutText()).data.vars, 'CLICKUP_API_TOKEN');
    expect(row.source).toBe('file');
    expect(row.shadowed).toBeUndefined();
  });

  it('reports an ambient key the project config names via apiKeyEnv', async () => {
    writeFileSync(paths.projectId(root), 'env-cmd-proj\n', 'utf8');
    process.env[CONFIG_KEY] = AMBIENT_SECRET;

    // Without a config naming it, the key is just an unlisted ambient name.
    expect(await runCli(['env', '--json'])).toBe(0);
    expect(
      (JSON.parse(stdoutText()).data.vars as EnvVarRow[]).find((v) => v.key === CONFIG_KEY),
    ).toBeUndefined();

    stdout.mockClear();
    stderr.mockClear();
    process.exitCode = undefined;
    writeFileSync(
      paths.config(root),
      `host: claude\nmode: full\nmodel:\n  providers:\n    anthropic:\n      model: claude-sonnet-4\n      apiKeyEnv: ${CONFIG_KEY}\n`,
      'utf8',
    );

    expect(await runCli(['env', '--json'])).toBe(0);
    expect(rowOf(JSON.parse(stdoutText()).data.vars, CONFIG_KEY).source).toBe('env');
    expect(stdoutText() + stderrText()).not.toContain(AMBIENT_SECRET);
  });

  it('renders the KEY/SOURCE/VALUE table on STDERR with a redacted shape only', async () => {
    writeFileSync(envPath, `CLICKUP_API_TOKEN=${FILE_SECRET}\n`, 'utf8');

    const code = await runCli(['env']);

    expect(code).toBe(0);
    expect(stdoutText()).toBe(''); // data → stdout is the --json contract only
    const err = stderrText();
    expect(err).toContain('KEY');
    expect(err).toContain('SOURCE');
    expect(err).toContain('VALUE');
    expect(err).toContain('CLICKUP_API_TOKEN');
    expect(err).toContain('.noir/.env');
    expect(err).toContain(`pk_…(${FILE_SECRET.length})`); // shape, not the value
    expect(err).not.toContain(FILE_SECRET);
  });

  it.skipIf(!gitAvailable)(
    'reports a git-tracked .noir/.env as refused, with nothing from the file in effect',
    async () => {
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
      writeFileSync(envPath, `CLICKUP_API_TOKEN=${FILE_SECRET}\n`, 'utf8');
      execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: root, stdio: 'ignore' });
      // A refused file contributes NOTHING — so an exported Noir key is
      // un-shadowed and still in effect.
      process.env.ANTHROPIC_API_KEY = AMBIENT_SECRET;

      const code = await runCli(['env', '--json']);

      expect(code).toBe(0);
      const data = JSON.parse(stdoutText()).data;
      expect((data.vars as EnvVarRow[]).find((v) => v.key === 'CLICKUP_API_TOKEN')).toBeUndefined();
      expect(rowOf(data.vars, 'ANTHROPIC_API_KEY').source).toBe('env');
      expect(data.warnings.join('\n')).toMatch(/refusing to load/);
      // The refusal means nothing was applied to this process either.
      expect(process.env.CLICKUP_API_TOKEN).toBeUndefined();
      expect(stdoutText() + stderrText()).not.toContain(FILE_SECRET);
    },
  );
});

describe('noir doctor — env provenance rows', () => {
  let root: string;
  let envPath: string;
  let stderr: MockInstance<typeof process.stderr.write>;
  let stdout: MockInstance<typeof process.stdout.write>;
  let cwd: MockInstance<typeof process.cwd>;
  let prevExit: typeof process.exitCode;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    prevExit = process.exitCode;
    process.exitCode = undefined;
    root = mkdtempSync(join(tmpdir(), 'noir-doctor-env-'));
    mkdirSync(join(root, '.noir'), { recursive: true });
    envPath = join(root, '.noir', '.env');
    writeFileSync(paths.projectId(root), 'doctor-env-provenance\n', 'utf8');
    cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    saved = {};
    for (const key of MANAGED_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of MANAGED_KEYS) {
      const prev = saved[key];
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
    }
    stderr.mockRestore();
    stdout.mockRestore();
    cwd.mockRestore();
    process.exitCode = prevExit;
    vi.clearAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  const stderrText = (): string => stderr.mock.calls.map((c) => String(c[0])).join('');
  const stdoutText = (): string => stdout.mock.calls.map((c) => String(c[0])).join('');

  it('adds one row per key .noir/.env defines, naming the winning source', async () => {
    writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
    writeFileSync(envPath, `CLICKUP_API_TOKEN=${FILE_SECRET}\n`, 'utf8');

    // Called in-process so the payload is read directly (doctor's --json envelope
    // is written before the exit-1 throw on a critical check).
    const payload = await captureDoctorJson();

    expect(checkOf(payload.checks, 'noir-env').status).not.toBe('fail');
    const provenance = checkOf(payload.checks, 'noir-env:CLICKUP_API_TOKEN');
    expect(provenance.status).toBe('ok');
    expect(provenance.detail).toContain('.noir/.env');
    // Names only: the value never reaches a detail string.
    expect(payload.checks.map((c) => c.detail).join('\n')).not.toContain(FILE_SECRET);
    expect(stdoutText() + stderrText()).not.toContain(FILE_SECRET);
  });

  it('names .noir/.env as the provider key source, and omits it when the env supplies it', async () => {
    writeFileSync(
      paths.config(root),
      `host: claude\nmode: full\nmodel:\n  providers:\n    anthropic:\n      model: claude-sonnet-4\n      apiKeyEnv: ${CONFIG_KEY}\n`,
      'utf8',
    );
    // From the file: the bin's preAction applies the overlay, so the key really
    // is present AND its winning source is the file.
    writeFileSync(envPath, `${CONFIG_KEY}=${FILE_SECRET}\n`, 'utf8');
    await runCli(['doctor', '--json']);
    const payloadFromFile = JSON.parse(stdoutText());
    expect(checkOf(payloadFromFile.data.checks, 'provider').detail).toContain(
      'key present (from .noir/.env)',
    );

    // From the ambient environment: a bare "key present", no provenance suffix.
    stdout.mockClear();
    stderr.mockClear();
    process.exitCode = undefined;
    rmSync(envPath);
    process.env[CONFIG_KEY] = AMBIENT_SECRET;
    await runCli(['doctor', '--json']);
    const payloadFromEnv = JSON.parse(stdoutText());
    const provider = checkOf(payloadFromEnv.data.checks, 'provider');
    expect(provider.detail).toContain('key present');
    expect(provider.detail).not.toContain('from .noir/.env');
  });

  /** Run `doctor({json:true})` in-process and return the parsed `data` payload. */
  async function captureDoctorJson(): Promise<{
    checks: CheckResult[];
    summary: { ok: number; warn: number; fail: number };
  }> {
    try {
      await doctor({ json: true });
    } catch {
      /* doctor throws exit-1 after writing the envelope — the payload is what matters */
    }
    return JSON.parse(stdoutText()).data;
  }
});

afterAll(() => {
  rmSync(daemonDir, { recursive: true, force: true });
});
