// S9 t1 — commander migration tests. Drives `createProgram()` (a fresh program
// per case, since commander parse state is mutable) and asserts the S9 exit-code
// contract + stream discipline (data→stdout, diagnostics→stderr) + behavior
// preservation of the migrated commands. Side-effecting modules are mocked.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommanderError } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/init.js', () => ({ init: vi.fn(async () => {}) }));
vi.mock('../src/sync.js', () => ({ sync: vi.fn(async () => {}) }));
vi.mock('../src/serve.js', () => ({ serve: vi.fn(async () => {}) }));
// doctor/daemon/skills are real modules now; mock them at the boundary so
// the bin dispatch tests stay focused on wiring (argv → action → module).
// Their dedicated behavior (--json shape, exit codes, foreground honesty,
// health checks) is covered in doctor.test / daemon.test / skills.test.
vi.mock('../src/commands/doctor.js', () => ({ doctor: vi.fn(async () => {}) }));
vi.mock('../src/commands/daemon.js', () => ({
  daemonStart: vi.fn(async () => {}),
  daemonStop: vi.fn(async () => {}),
  daemonStatus: vi.fn(async () => {}),
  daemonRestart: vi.fn(async () => {}),
}));
vi.mock('../src/commands/skills.js', () => ({
  skillsList: vi.fn(async () => {}),
  skillsSync: vi.fn(async () => {}),
}));
// Slice S-T2: `noir create` is a new command; mock it at the boundary like the
// other commands. Its dedicated behavior (engine delegation, dir creation) is
// covered by an integration-style test in create.test.ts.
vi.mock('../src/commands/create.js', () => ({ create: vi.fn(async () => {}) }));
// t4: status + home are real modules now; mock them at the boundary so the bin
// dispatch tests stay focused on wiring (argv → action → module) without a
// daemon. Their dedicated behavior is covered in status.test / home.test.
vi.mock('../src/commands/status.js', () => ({ status: vi.fn(async () => {}) }));
vi.mock('../src/commands/home.js', () => ({ home: vi.fn(async () => {}) }));
// context/memory/task are real modules now; same boundary mock. Their
// dedicated behavior (--json shape, daemon envelopes, prompts) is covered in
// context.test / memory.test / task.test; here we only assert argv → module.
vi.mock('../src/commands/context.js', () => ({
  contextSearch: vi.fn(async () => {}),
  contextIndex: vi.fn(async () => {}),
  contextStatus: vi.fn(async () => {}),
}));
vi.mock('../src/commands/memory.js', () => ({
  memoryRecall: vi.fn(async () => {}),
  memorySave: vi.fn(async () => {}),
  memorySessions: vi.fn(async () => {}),
  memoryForget: vi.fn(async () => {}),
  memoryConsolidate: vi.fn(async () => {}),
}));
vi.mock('../src/commands/task.js', () => ({
  taskNew: vi.fn(async () => {}),
  taskStatus: vi.fn(async () => {}),
  taskAdvance: vi.fn(async () => {}),
  taskNext: vi.fn(async () => {}),
}));

import { createProgram, EXIT, inferExitCode, NoirCliError } from '../src/bin.js';
import { contextIndex, contextSearch, contextStatus } from '../src/commands/context.js';
import { create } from '../src/commands/create.js';
import { daemonRestart, daemonStart, daemonStatus, daemonStop } from '../src/commands/daemon.js';
import { doctor } from '../src/commands/doctor.js';
import { home } from '../src/commands/home.js';
import {
  memoryConsolidate,
  memoryForget,
  memoryRecall,
  memorySave,
  memorySessions,
} from '../src/commands/memory.js';
import { skillsList, skillsSync } from '../src/commands/skills.js';
import { status } from '../src/commands/status.js';
import { taskAdvance, taskNew, taskNext, taskStatus } from '../src/commands/task.js';
import { init } from '../src/init.js';
import { serve } from '../src/serve.js';
import { sync } from '../src/sync.js';

interface ParseResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Drive a fresh program with user-form args; capture exit code + streams. */
async function parse(args: string[]): Promise<ParseResult> {
  const program = createProgram();
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exitCode: number = EXIT.OK;
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err) {
    exitCode = inferExitCode(err);
    // Mirror run()'s handleError so stderr assertions reflect real bin output.
    // (CommanderError messages are already written during parseAsync via
    // configureOutput.writeErr → captured above; don't double-write.)
    if (err instanceof NoirCliError) {
      if (err.message.length > 0) errChunks.push(`${err.message}\n`);
    } else if (!(err instanceof CommanderError)) {
      errChunks.push(`noir: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { exitCode, stdout: outChunks.join(''), stderr: errChunks.join('') };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('commander migration — exit codes + stream discipline', () => {
  it('--help writes to stdout (conventional; users pipe it) and exits 0', async () => {
    const r = await parse(['--help']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(r.stdout).toMatch(/Usage:|Commands:|noir/);
    expect(r.stderr).toBe('');
  });

  it('unknown command → exit 3 (not-found)', async () => {
    const r = await parse(['nonexistent-command']);
    expect(r.exitCode).toBe(EXIT.NOT_FOUND);
  });

  it('bare `noir` (non-TTY) → routes through home(), exit 0', async () => {
    // The test env is non-TTY (stdin/stdout not TTY) → home's non-interactive
    // arm runs (dispatches to `status`). home is mocked → no-op; the wiring
    // under test is "bare noir dispatches to home with the global opts".
    const r = await parse([]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(home).toHaveBeenCalledTimes(1);
    expect(home).toHaveBeenCalledWith(
      expect.objectContaining({ json: false, quiet: false, verbose: false, input: true }),
      expect.objectContaining({ dispatch: expect.any(Function) }),
    );
  });

  it('bare `noir --json` → home receives json:true', async () => {
    const r = await parse(['--json']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(home).toHaveBeenLastCalledWith(
      expect.objectContaining({ json: true }),
      expect.any(Object),
    );
  });

  it('`noir mcp` (bare group) → exit 2 + legacy usage line', async () => {
    const r = await parse(['mcp']);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toContain('Usage: noir mcp serve [--stdio]');
  });

  it('`noir daemon` (bare group) → exit 2 + usage line', async () => {
    const r = await parse(['daemon']);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/Usage: noir daemon/);
  });
});

describe('commander migration — global flags', () => {
  it('global flags parse without "unknown option" and reach the command', async () => {
    // status is mocked (no-op success). If any global flag were unrecognized,
    // commander would exit 2 (usage) BEFORE dispatching — so reaching the
    // action + exit 0 proves all globals parsed.
    const r = await parse(['--json', '--quiet', '--verbose', '--no-input', 'status']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(
      expect.objectContaining({ json: true, quiet: true, verbose: true, input: false }),
    );
  });

  it('--cwd <dir> changes the working directory before the action runs', async () => {
    // realpath: macOS `os.tmpdir()` is `/var/folders/...` (symlink to
    // `/private/var/folders/...`); process.cwd() resolves through it after
    // chdir, and init() receives process.cwd() — so normalize the fixture.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'noir-bin-cwd-')));
    const origCwd = process.cwd();
    try {
      const r = await parse(['--cwd', dir, 'init']);
      expect(r.exitCode).toBe(EXIT.OK);
      expect(init).toHaveBeenCalledWith(dir, { transport: 'stdio', url: undefined });
    } finally {
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--cwd on a nonexistent dir → exit 2 (usage)', async () => {
    const origCwd = process.cwd();
    try {
      const r = await parse(['--cwd', '/no/such/noir/dir/xyz', 'init']);
      expect(r.exitCode).toBe(EXIT.USAGE);
      expect(r.stderr).toContain('--cwd:');
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe('commander migration — behavior preservation (migrated commands)', () => {
  it('init defaults to stdio transport', async () => {
    const r = await parse(['init']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith(process.cwd(), { transport: 'stdio', url: undefined });
  });

  it('init --transport streamable-http --url passes them through', async () => {
    const r = await parse([
      'init',
      '--transport',
      'streamable-http',
      '--url',
      'http://127.0.0.1:4321/mcp',
    ]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(init).toHaveBeenCalledWith(process.cwd(), {
      transport: 'streamable-http',
      url: 'http://127.0.0.1:4321/mcp',
    });
  });

  it('init coerces an unknown transport back to stdio (parseArgs parity)', async () => {
    const r = await parse(['init', '--transport', 'bogus']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(init).toHaveBeenCalledWith(process.cwd(), { transport: 'stdio', url: undefined });
  });

  it('sync dispatches to sync()', async () => {
    const r = await parse(['sync']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(sync).toHaveBeenCalledWith(process.cwd());
  });

  it('sync --no-merge-regions passes mergeManagedRegions:false through to sync()', async () => {
    const r = await parse(['sync', '--no-merge-regions']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(sync).toHaveBeenCalledWith(process.cwd(), { mergeManagedRegions: false });
  });

  it('sync --merge still passes merge:true (backward-compat no-op, merge is the default)', async () => {
    const r = await parse(['sync', '--merge']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(sync).toHaveBeenCalledWith(process.cwd(), { merge: true });
  });

  it('init --upgrade passes upgrade:true through to init()', async () => {
    const r = await parse(['init', '--upgrade']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(init).toHaveBeenCalledWith(process.cwd(), {
      transport: 'stdio',
      url: undefined,
      upgrade: true,
    });
  });

  it('init without --upgrade omits the upgrade key (arg-shape parity)', async () => {
    // Regression guard: the conditional-spread must NOT add `upgrade: false`,
    // which would break the exact-arg assertions used elsewhere in this suite.
    await parse(['init']);
    // `noUncheckedIndexedAccess`: calls[0] is `[args, opts] | undefined`; guard
    // explicitly so the destructure type-narrows without a non-null assertion.
    const call = vi.mocked(init).mock.calls[0];
    if (!call) throw new Error('init was not called');
    const [, opts] = call;
    expect(opts).toEqual({ transport: 'stdio', url: undefined });
    expect('upgrade' in opts).toBe(false);
  });

  describe('noir create [dir] (slice S-T2)', () => {
    it('create with no dir defaults transport=stdio and calls create(undefined, …)', async () => {
      const r = await parse(['create']);
      expect(r.exitCode).toBe(EXIT.OK);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(undefined, { transport: 'stdio', url: undefined });
    });

    it('create <dir> passes the positional through', async () => {
      const r = await parse(['create', './my-app']);
      expect(r.exitCode).toBe(EXIT.OK);
      expect(create).toHaveBeenCalledWith('./my-app', { transport: 'stdio', url: undefined });
    });

    it('create --transport streamable-http --url passes them through (stdio coercion parity)', async () => {
      const r = await parse([
        'create',
        'my-app',
        '--transport',
        'streamable-http',
        '--url',
        'http://127.0.0.1:4321/mcp',
      ]);
      expect(r.exitCode).toBe(EXIT.OK);
      expect(create).toHaveBeenCalledWith('my-app', {
        transport: 'streamable-http',
        url: 'http://127.0.0.1:4321/mcp',
      });
    });

    it('create coerces an unknown transport back to stdio (parseArgs parity with init)', async () => {
      const r = await parse(['create', '--transport', 'bogus']);
      expect(r.exitCode).toBe(EXIT.OK);
      expect(create).toHaveBeenCalledWith(undefined, { transport: 'stdio', url: undefined });
    });
  });

  it('mcp serve --stdio → serve({stdio:true})', async () => {
    const r = await parse(['mcp', 'serve', '--stdio']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(serve).toHaveBeenCalledWith({ stdio: true });
  });

  it('mcp serve (no flag) → serve({stdio:false})', async () => {
    const r = await parse(['mcp', 'serve']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(serve).toHaveBeenCalledWith({ stdio: false });
  });

  it('daemon start / stop dispatch with globals', async () => {
    expect((await parse(['daemon', 'start'])).exitCode).toBe(EXIT.OK);
    expect(daemonStart).toHaveBeenCalledWith(
      expect.objectContaining({ json: false, quiet: false, verbose: false, input: true }),
    );
    expect(daemonStart).not.toHaveBeenCalledWith(expect.objectContaining({ detach: true }));
    expect((await parse(['daemon', 'stop'])).exitCode).toBe(EXIT.OK);
    expect(daemonStop).toHaveBeenCalledWith(expect.objectContaining({ json: false, input: true }));
  });

  it('daemon start --detach forwards the flag (the refusal lives in daemon.test)', async () => {
    const r = await parse(['daemon', 'start', '--detach']);
    expect(r.exitCode).toBe(EXIT.OK); // mocked — real exit-2 covered in daemon.test
    expect(daemonStart).toHaveBeenLastCalledWith(expect.objectContaining({ detach: true }));
  });

  it('doctor dispatches with globals', async () => {
    const r = await parse(['doctor']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(doctor).toHaveBeenCalledTimes(1);
    expect(doctor).toHaveBeenLastCalledWith(expect.objectContaining({ json: false, input: true }));
  });

  it('doctor --json forwards the global json flag', async () => {
    const r = await parse(['doctor', '--json']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(doctor).toHaveBeenLastCalledWith(expect.objectContaining({ json: true }));
  });

  it('noir status dispatches to status()', async () => {
    const r = await parse(['status']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ json: false }));
  });

  it('noir status --json forwards the global json flag', async () => {
    const r = await parse(['status', '--json']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(status).toHaveBeenCalledWith(expect.objectContaining({ json: true }));
  });

  it('an action throwing a plain Error → exit 1 + "noir: <msg>"', async () => {
    vi.mocked(init).mockRejectedValueOnce(new Error('boom'));
    const r = await parse(['init']);
    expect(r.exitCode).toBe(EXIT.ERROR);
    expect(r.stderr).toContain('noir: boom');
  });
});

describe('commander migration — wired subcommands (context/memory/task → module)', () => {
  it.each([
    ['context search', ['context', 'search', 'how do I configure x'], contextSearch],
    ['context index', ['context', 'index'], contextIndex],
    ['context status', ['context', 'status'], contextStatus],
    ['memory recall', ['memory', 'recall', 'auth flow'], memoryRecall],
    ['memory sessions', ['memory', 'sessions'], memorySessions],
    ['memory forget', ['memory', 'forget', 'mem-123'], memoryForget],
    ['memory consolidate', ['memory', 'consolidate'], memoryConsolidate],
    ['task status', ['task', 'status'], taskStatus],
    ['task next', ['task', 'next'], taskNext],
  ])('%s dispatches to its module (exit 0)', async (_label, args, fn) => {
    const r = await parse([...args]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('context search forwards the positional query + globals + --limit', async () => {
    await parse(['context', 'search', 'how do I configure x', '--json', '--limit', '5']);
    expect(contextSearch).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'how do I configure x', json: true, limit: '5' }),
    );
  });

  it('context index collects repeated --path into an array', async () => {
    await parse(['context', 'index', '--path', 'a', '--path', 'b']);
    expect(contextIndex).toHaveBeenCalledWith(expect.objectContaining({ paths: ['a', 'b'] }));
  });

  it('memory save forwards content/type/files (now optional — module owns prompt/exit-2)', async () => {
    await parse(['memory', 'save', '--content', 'hi', '--type', 'fact', '--files', 'a.ts,b.ts']);
    expect(memorySave).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'hi', type: 'fact', files: 'a.ts,b.ts' }),
    );
  });

  it("memory save with no flags still dispatches (exit-2/prompt is the module's job)", async () => {
    const r = await parse(['memory', 'save']);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(memorySave).toHaveBeenCalledTimes(1);
  });

  it('memory forget forwards variadic ids', async () => {
    await parse(['memory', 'forget', 'a', 'b']);
    expect(memoryForget).toHaveBeenCalledWith(expect.objectContaining({ ids: ['a', 'b'] }));
  });

  it('memory consolidate forwards --types/--limit', async () => {
    await parse(['memory', 'consolidate', '--types', 'pattern,bug', '--limit', '20']);
    expect(memoryConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({ types: 'pattern,bug', limit: '20' }),
    );
  });

  it('task new requires --slug (exit 2; commander, before the action)', async () => {
    const r = await parse(['task', 'new']);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(taskNew).not.toHaveBeenCalled();
  });

  it('task new --slug forwards slug + optional mode', async () => {
    await parse(['task', 'new', '--slug', 'auth', '--mode', 'full']);
    expect(taskNew).toHaveBeenCalledWith(expect.objectContaining({ slug: 'auth', mode: 'full' }));
  });

  it('task status forwards an optional positional id', async () => {
    await parse(['task', 'status', 't-9']);
    expect(taskStatus).toHaveBeenCalledWith(expect.objectContaining({ id: 't-9' }));
  });

  it('task advance forwards --to/--force', async () => {
    await parse(['task', 'advance', '--to', 'spec', '--force', 'because']);
    expect(taskAdvance).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'spec', force: 'because' }),
    );
  });
});

describe('commander migration — wired subcommands (skills/daemon → module)', () => {
  it.each([
    ['skills list', ['skills', 'list'], skillsList],
    ['skills sync', ['skills', 'sync'], skillsSync],
    ['daemon status', ['daemon', 'status'], daemonStatus],
    ['daemon restart', ['daemon', 'restart'], daemonRestart],
  ])('%s dispatches to its module (exit 0)', async (_label, args, fn) => {
    const r = await parse([...args]);
    expect(r.exitCode).toBe(EXIT.OK);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('skills list --json forwards the global json flag', async () => {
    await parse(['skills', 'list', '--json']);
    expect(skillsList).toHaveBeenLastCalledWith(expect.objectContaining({ json: true }));
  });

  it('daemon status forwards globals', async () => {
    await parse(['daemon', 'status', '--json', '--verbose']);
    expect(daemonStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ json: true, verbose: true }),
    );
  });

  it('bare `context` group → exit 2 + usage', async () => {
    const r = await parse(['context']);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/Usage: noir context/);
  });

  it('bare `skills` group → exit 2 + usage', async () => {
    const r = await parse(['skills']);
    expect(r.exitCode).toBe(EXIT.USAGE);
    expect(r.stderr).toMatch(/Usage: noir skills/);
  });
});

describe('global-install symlink invocation (regression)', () => {
  // Reproduces the npm-global-install layout: .../bin/noir is a SYMLINK to
  // .../lib/node_modules/@noir-ai/cli/dist/bin.js. Guards two regressions:
  //   1. the isMainModule guard must realpath(process.argv[1]) so main() runs
  //      under symlinked invocation (else a global `noir` install silently
  //      exits 0 — main() never runs; this broke every published beta).
  //   2. --version exits 0 (commander v12 throws code 'commander.version').
  it('runs the bin via a symlink + --version exits 0 with output', () => {
    const distBin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'noir-symlink-regression-'));
    const link = join(dir, 'noir');
    symlinkSync(distBin, link);
    try {
      const r = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
      expect(r.status).toBe(0); // was 0-with-no-output (silent no-op) before the realpath fix
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/); // version printed, NOT empty
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
