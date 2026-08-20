// S9 — `noir skills {list,sync}` behavior tests.
//
// Both sub-commands are in-process (no daemon), so these are plain unit tests
// over the module functions: stdout/stderr stream discipline + --json schema +
// the discover/emit primitives. `skills list` is project-independent (reads the
// builtin pack); `skills sync` requires an initialized project.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { skillsLint, skillsList, skillsRegistry, skillsSync } from '../src/commands/skills.js';
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
  it('discovers every builtin (26) + integration (1) skill (27 total) and emits a --json envelope to stdout', async () => {
    const r = await run(() => skillsList({ json: true }));
    expect(r.err).toBeUndefined();
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data.count).toBe(27); // 26 builtins + noir-clickup
    expect(Array.isArray(envelope.data.skills)).toBe(true);
    expect(envelope.data.skills.length).toBe(27);
    const first = envelope.data.skills[0];
    expect(first).toEqual(
      expect.objectContaining({
        name: expect.any(String),
        category: expect.any(String),
        description: expect.any(String),
        kind: expect.stringMatching(/^(builtin|integration)$/),
      }),
    );
  });

  it('includes the noir-clickup integration tagged kind:"integration"', async () => {
    const r = await run(() => skillsList({ json: true }));
    const skills = JSON.parse(r.stdout).data.skills as Array<{
      name: string;
      kind: string;
      category: string;
    }>;
    const clickup = skills.find((s) => s.name === 'noir-clickup');
    expect(clickup).toBeDefined();
    expect(clickup?.kind).toBe('integration');
    // Builtins stay tagged builtin.
    const brainstorm = skills.find((s) => s.name === 'noir-brainstorming');
    expect(brainstorm?.kind).toBe('builtin');
  });

  it('derives a category per skill (no empty cells)', async () => {
    const r = await run(() => skillsList({ json: true }));
    const skills = JSON.parse(r.stdout).data.skills as Array<{ name: string; category: string }>;
    for (const s of skills) {
      expect(s.category.length).toBeGreaterThan(0);
    }
    const brainstorm = skills.find((s) => s.name === 'noir-brainstorming');
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

  it('human mode renders a table (with Kind column) to stderr and keeps stdout empty', async () => {
    const r = await run(() => skillsList({}));
    expect(r.err).toBeUndefined();
    expect(r.stdout).toBe('');
    // Banner reports 27 skills (26 builtin + 1 integration).
    expect(r.stderr).toMatch(/noir skills — 27 skills \(26 builtin, 1 integration\)/);
    expect(r.stderr).toMatch(/Skill.*Kind.*Category.*Description/);
    expect(r.stderr).toMatch(/noir-brainstorming/);
    expect(r.stderr).toMatch(/noir-clickup/);
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
      expect(envelope.data.emitted.length).toBe(27); // 26 builtins + 1 integration (noir-clickup)
      expect(envelope.data.dir).toBe(join(root, '.claude', 'skills'));
      const names = readdirSync(join(root, '.claude', 'skills'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith('noir-'))
        .map((e) => e.name);
      expect(names.length).toBe(27); // 26 builtins + 1 integration (noir-clickup)
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
      expect(r.stderr).toMatch(/Synced 27 Noir skills to .*\.claude\/skills\./);
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
      // S9 contract: --json emits the canonical {ok:false,error} envelope on
      // stdout (a plain Error would leave it empty — the iter-3 fix).
      const env = JSON.parse(r.stdout) as { ok: boolean; error: { code: number; message: string } };
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe(1);
      expect(env.error.message).toMatch(/noir init/);
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe('noir skills lint', () => {
  it('reports per-skill errors+warnings with a --json envelope', async () => {
    const r = await run(() => skillsLint({ json: true }));
    expect(r.err).toBeUndefined();
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: {
        count: number;
        errored: number;
        skills: Array<{ name: string; errors: string[]; warnings: string[] }>;
      };
    };
    expect(env.data.count).toBe(27); // 26 builtins + 1 integration
    expect(Array.isArray(env.data.skills)).toBe(true);
    // Every skill has a name + errors/warnings arrays.
    for (const s of env.data.skills) {
      expect(typeof s.name).toBe('string');
      expect(Array.isArray(s.errors)).toBe(true);
      expect(Array.isArray(s.warnings)).toBe(true);
    }
    // The shipped pack validates clean (0 errored), so the clean path emits
    // ok:true + exit 0. `ok` is asserted boolean (the failure path — exit 1 +
    // {ok:false,error} — is exercised by the code contract in skillsLint, but a
    // forced-error test would need to mock @noir-ai/skills).
    expect(typeof env.ok).toBe('boolean');
  });

  it('is project-independent (no init required)', async () => {
    // skills lint reads the shipped pack only — works outside any project.
    const r = await run(() => skillsLint({ json: true }));
    expect(r.err).toBeUndefined();
    expect(r.stderr).toBe('');
  });
});

describe('noir skills registry', () => {
  it('emits the runtime-derived registry with a --json envelope', async () => {
    const r = await run(() => skillsRegistry({ json: true }));
    expect(r.err).toBeUndefined();
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: {
        count: number;
        skills: Array<{
          name: string;
          kind: string;
          category: string;
          version: string;
          status: string;
          referenceCount: number;
          lines: number;
        }>;
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.count).toBe(27); // 26 builtins + 1 integration
    for (const s of env.data.skills) {
      expect(s.name.startsWith('noir-')).toBe(true);
      expect(['builtin', 'integration']).toContain(s.kind);
      expect(typeof s.category).toBe('string');
      expect(typeof s.version).toBe('string');
      expect(['full', 'stub']).toContain(s.status);
      expect(typeof s.referenceCount).toBe('number');
      expect(typeof s.lines).toBe('number');
    }
    // ClickUp is the integration entry.
    expect(env.data.skills.find((s) => s.name === 'noir-clickup')?.kind).toBe('integration');
  });

  it('is project-independent (no init required)', async () => {
    const r = await run(() => skillsRegistry({ json: true }));
    expect(r.err).toBeUndefined();
    expect(r.stderr).toBe('');
  });
});
