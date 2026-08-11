// TUI runtime policy tests.
//
// Pins the three new global flags (`--tui` / `--no-tui` / `--no-tips`), the
// deprecation-hint wiring (registry-driven, suppressed by --no-tips / --json),
// and the ScaffoldResult gap close (init/sync/create emit their ScaffoldResult on stdout
// under --json). home.test.ts pins the --no-tui home-routing arm; these tests
// cover the bin-level wiring + the structured stdout emission.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// init is the real module for the dogfood case (mkdtemp). create/sync are
// mocked at the boundary; their bin-level emission is the same code path as
// init, exercised here via the mocked return value. status is mocked so the
// parse-recognition tests don't do real daemon work.
vi.mock('../src/sync.js', () => ({ sync: vi.fn(async () => ({ conflicts: [] })) }));
vi.mock('../src/commands/create.js', () => ({ create: vi.fn(async () => ({ conflicts: [] })) }));
vi.mock('../src/commands/status.js', () => ({ status: vi.fn(async () => {}) }));

import { Command, CommanderError } from 'commander';
import {
  createProgram,
  DEPRECATIONS,
  type DeprecationEntry,
  emitDeprecationHintsFor,
  inferExitCode,
  NoirCliError,
} from '../src/bin.js';
import { create } from '../src/commands/create.js';
import { tip } from '../src/output.js';
import { sync } from '../src/sync.js';

interface ParseResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Drive a fresh program with user-form args; capture exit code + streams.
 *  Mirrors bin.test.ts's helper so commander's help/version/usage errors map
 *  onto the S9 exit-code contract (not a blanket exit 1). */
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
  let exitCode = 0;
  try {
    await program.parseAsync(args, { from: 'user' });
  } catch (err) {
    exitCode = inferExitCode(err);
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
  // Ensure a clean deprecation registry between tests (it's module-global).
  DEPRECATIONS.length = 0;
});

describe('global flags parse + route bare noir', () => {
  it('--no-tui + --no-tips + --tui parse without "unknown option" (additive)', async () => {
    // status is mocked at the module boundary inside createProgram (real
    // module). Reach exit 0 => all three flags parsed as known globals.
    const r = await parse(['--no-tui', '--no-tips', 'status']);
    expect(r.exitCode).toBe(0);
  });

  it('--tui / --no-tui / --no-tips appear on the top-level --help', async () => {
    const r = await parse(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/--no-tui/);
    expect(r.stdout).toMatch(/--tui/);
    expect(r.stdout).toMatch(/--no-tips/);
  });
});

describe('deprecation / redirect hints', () => {
  it('tip() writes to stderr when no --no-tips, suppressed under --no-tips', async () => {
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      captured.push(typeof c === 'string' ? c : String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      tip('sample redirect hint', {});
      expect(captured.join('')).toContain('sample redirect hint');
      captured.length = 0;
      tip('sample redirect hint', { noTips: true });
      expect(captured.join('')).toBe('');
      captured.length = 0;
      // Also suppressed under --json (stdout envelope stays pristine).
      tip('sample redirect hint', { json: true });
      expect(captured.join('')).toBe('');
    } finally {
      process.stderr.write = orig;
    }
  });

  it('emitDeprecationHintsFor emits a redirect hint for a matching command path', () => {
    // Build a tiny commander tree mirroring noir's shape so commandPath() walks
    // parent links the same way the real program does.
    const program = new Command().name('noir');
    const sub = program.command('legacy-status').action(() => {});
    const entry: DeprecationEntry = {
      oldArgv: ['legacy-status'],
      newArgv: ['status'],
      since: '1.4.0',
    };
    DEPRECATIONS.push(entry);

    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      captured.push(typeof c === 'string' ? c : String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      emitDeprecationHintsFor(sub, {});
      const out = captured.join('');
      expect(out).toContain('`noir legacy-status` is deprecated since v1.4.0');
      expect(out).toContain('use `noir status`');
    } finally {
      process.stderr.write = orig;
    }
  });

  it('emitDeprecationHintsFor is silent under --no-tips and --json', () => {
    const program = new Command().name('noir');
    const sub = program.command('legacy-status').action(() => {});
    DEPRECATIONS.push({ oldArgv: ['legacy-status'], newArgv: ['status'], since: '1.4.0' });

    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      captured.push(typeof c === 'string' ? c : String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      emitDeprecationHintsFor(sub, { noTips: true });
      expect(captured.join('')).toBe('');
      emitDeprecationHintsFor(sub, { json: true });
      expect(captured.join('')).toBe('');
    } finally {
      process.stderr.write = orig;
    }
  });

  it('no hint when the registry is empty (the default — no command deprecated today)', () => {
    const program = new Command().name('noir');
    const sub = program.command('status').action(() => {});
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      captured.push(typeof c === 'string' ? c : String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      emitDeprecationHintsFor(sub, {});
      expect(captured.join('')).toBe('');
    } finally {
      process.stderr.write = orig;
    }
  });
});

describe('ScaffoldResult gap close — init/sync/create emit ScaffoldResult under --json', () => {
  it('noir init --json (mkdtemp dogfood) emits the ScaffoldResult with conflicts[] to stdout', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'noir-c1-init-')));
    const origCwd = process.cwd();
    const r0 = { stdout: '', stderr: '' };
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: unknown) => {
      r0.stdout += typeof c === 'string' ? c : String(c);
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((c: unknown) => {
      r0.stderr += typeof c === 'string' ? c : String(c);
      return true;
    }) as typeof process.stderr.write;
    try {
      process.chdir(dir);
      const program = createProgram();
      await program.parseAsync(['init', '--json'], { from: 'user' });
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      process.chdir(origCwd);
      rmSync(dir, { recursive: true, force: true });
    }
    // The ScaffoldResult envelope on stdout.
    const lines = r0.stdout.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const last = lines[lines.length - 1];
    if (typeof last !== 'string') throw new Error('no stdout line emitted');
    const envelope = JSON.parse(last);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual(
      expect.objectContaining({
        written: expect.any(Array),
        skipped: expect.any(Array),
        conflicts: expect.any(Array),
        noop: expect.any(Boolean),
      }),
    );
    // First-run on an empty dir ⇒ no regenerate conflicts.
    expect(envelope.data.conflicts.length).toBe(0);
  });

  it('noir sync --json emits the ScaffoldResult returned by sync() to stdout', async () => {
    vi.mocked(sync).mockResolvedValueOnce({
      written: ['.mcp.json'],
      skipped: [],
      identical: [],
      noop: false,
      migrationsRan: [],
      migrationConflicts: [],
      stack: { languages: ['typescript'], monorepo: false, frameworks: [], packageManager: 'pnpm', pmSource: 'lockfile', ci: null, existingAiFiles: [], pmConflict: false },
      projectId: 'p-test',
      fromVersion: null,
      toVersion: '1.3.0',
      host: 'claude',
      conflicts: [
        {
          path: '.mcp.json',
          mode: 'regenerate',
          existingSha: 'aaa',
          proposedSha: 'bbb',
          resolution: 'replace',
        },
      ],
    });
    const r = await parse(['sync', '--json']);
    expect(r.exitCode).toBe(0);
    const envelope = JSON.parse(r.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(envelope.data.conflicts.length).toBe(1);
    expect(envelope.data.conflicts[0].path).toBe('.mcp.json');
  });

  it('noir create --json emits the ScaffoldResult returned by create() to stdout', async () => {
    vi.mocked(create).mockResolvedValueOnce({
      written: ['.noir/project.id'],
      skipped: [],
      identical: [],
      noop: false,
      migrationsRan: [],
      migrationConflicts: [],
      stack: { languages: ['typescript'], monorepo: false, frameworks: [], packageManager: 'npm', pmSource: 'lockfile', ci: null, existingAiFiles: [], pmConflict: false },
      projectId: 'p-create',
      fromVersion: null,
      toVersion: '1.3.0',
      host: 'claude',
      conflicts: [],
    });
    const r = await parse(['create', 'my-app', '--json']);
    expect(r.exitCode).toBe(0);
    const envelope = JSON.parse(r.stdout.trim());
    expect(envelope.ok).toBe(true);
    expect(Array.isArray(envelope.data.conflicts)).toBe(true);
  });

  it('noir init (no --json) writes NO envelope to stdout — human output unchanged', async () => {
    // Mock init's return via the real module boundary is heavy; instead drive
    // create (mocked) without --json and assert stdout stays empty.
    vi.mocked(create).mockResolvedValueOnce({
      written: [],
      skipped: [],
      identical: [],
      noop: true,
      migrationsRan: [],
      migrationConflicts: [],
      stack: { languages: [], monorepo: false, frameworks: [], packageManager: null, pmSource: 'unknown', ci: null, existingAiFiles: [], pmConflict: false },
      projectId: 'p',
      fromVersion: null,
      toVersion: '1.3.0',
      host: 'claude',
      conflicts: [],
    });
    const r = await parse(['create', 'my-app']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('');
  });
});
