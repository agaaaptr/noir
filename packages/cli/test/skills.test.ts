// S9 t6 — `noir skills {list,sync}` behavior tests.
//
// Both sub-commands are in-process (no daemon), so these are plain unit tests
// over the module functions: stdout/stderr stream discipline + --json schema +
// the discover/emit primitives. `skills list` is project-independent (reads the
// builtin pack); `skills sync` requires an initialized project.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { skillsList, skillsSync } from '../src/commands/skills.js';
import { init } from '../src/init.js';
import { inferExitCode } from '../src/output.js';

/** Capture stdout/stderr around `fn`, returning the streams + any thrown value. */
async function run(fn: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  err: unknown;
}> {
  const out: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => {
    out.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    errChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: errChunks.join(''), err };
}

let root: string;
beforeEach(() => {
  // realpath: on macOS `os.tmpdir()` is `/var/folders/...` (a symlink to
  // `/private/var/folders/...`), and `process.cwd()` resolves through it. The
  // impl computes the skills dir from process.cwd(), so normalize the fixture
  // root the same way or the path-equality assertion flips on this host.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'noir-skills-')));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('noir skills list', () => {
  it('discovers every builtin skill (31) and emits a --json envelope to stdout', async () => {
    const r = await run(() => skillsList({ json: true }));
    expect(r.err).toBeUndefined();
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.count).toBe(31);
    expect(Array.isArray(envelope.data.skills)).toBe(true);
    expect(envelope.data.skills.length).toBe(31);
    const first = envelope.data.skills[0];
    expect(first).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        category: expect.any(String),
        description: expect.any(String),
      }),
    );
  });

  it('derives a category per skill (no empty cells)', async () => {
    const r = await run(() => skillsList({ json: true }));
    const skills = JSON.parse(r.stdout).data.skills as Array<{ name: string; category: string }>;
    for (const s of skills) {
      expect(s.category.length).toBeGreaterThan(0);
    }
    const brainstorm = skills.find((s) => s.name === 'noir-brainstorm');
    expect(brainstorm?.category).toBe('discovery');
  });

  it('carries the FULL description in --json (display truncation does not leak)', async () => {
    const r = await run(() => skillsList({ json: true }));
    const skills = JSON.parse(r.stdout).data.skills as Array<{ description: string }>;
    // At least one builtin description is longer than the 80-char display cap.
    expect(skills.some((s) => s.description.length > 80)).toBe(true);
    // …and none of them are display-truncated with the ellipsis in the payload.
    expect(skills.some((s) => s.description.endsWith('…'))).toBe(false);
  });

  it('human mode renders a table to stderr and keeps stdout empty', async () => {
    const r = await run(() => skillsList({}));
    expect(r.err).toBeUndefined();
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/noir skills — 31 builtin skills/);
    expect(r.stderr).toMatch(/Skill.*Category.*Description/);
    expect(r.stderr).toMatch(/noir-brainstorm/);
  });
});

describe('noir skills sync', () => {
  it('writes the builtin pack to .claude/skills and emits a --json envelope', async () => {
    // init establishes the project + the adapter skills dir layout.
    const origCwd = process.cwd();
    try {
      process.chdir(root);
      await init(root, { transport: 'stdio' });
      const r = await run(() => skillsSync({ json: true }));
      expect(r.err).toBeUndefined();
      const envelope = JSON.parse(r.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.emitted.length).toBe(31);
      expect(envelope.data.dir).toBe(join(root, '.claude', 'skills'));
      const names = readdirSync(join(root, '.claude', 'skills'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('noir-'))
        .map((e) => e.name);
      expect(names.length).toBe(31);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('human mode reports the synced count on stderr', async () => {
    const origCwd = process.cwd();
    try {
      process.chdir(root);
      await init(root, { transport: 'stdio' });
      const r = await run(() => skillsSync({}));
      expect(r.err).toBeUndefined();
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/Synced 31 Noir skills to .*\.claude\/skills\./);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('fails exit 1 with the init hint when the project is not initialized', async () => {
    const origCwd = process.cwd();
    try {
      process.chdir(root);
      const r = await run(() => skillsSync({ json: true }));
      expect(r.err).toBeDefined();
      expect(inferExitCode(r.err)).toBe(1);
      // No partial data envelope on a failure path — stdout stays empty.
      expect(r.stdout).toBe('');
    } finally {
      process.chdir(origCwd);
    }
  });
});
