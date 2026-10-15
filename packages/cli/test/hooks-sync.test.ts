// `noir hooks sync` behavior tests.
//
// In-process (no daemon): the hook entry is a host config file. These are plain
// unit tests over the module function, mirroring skills.test.ts: stdout/stderr
// discipline + --json schema + the restore/no-op/force paths. `hooks sync`
// requires an initialized project and reads the host from `.noir/config.yml`.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hooksSync } from '../src/commands/hooks.js';
import { init } from '../src/init.js';
import { inferExitCode } from '../src/output.js';

/** Capture stdout/stderr around `fn`. */
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'noir-hooks-')));
  // Pin the resolved `noir` command (the test seam) so hook contents and the
  // --force rewrite assertion are deterministic on any machine.
  process.env.NOIR_MCP_COMMAND = 'noir';
});
afterEach(() => {
  delete process.env.NOIR_MCP_COMMAND;
  rmSync(root, { recursive: true, force: true });
});

const settingsPath = () => join(root, '.claude', 'settings.local.json');

describe('noir hooks sync', () => {
  it('restores a removed claude hook and reports it on stderr', async () => {
    const origCwd = process.cwd();
    try {
      process.chdir(root);
      await init(root, { transport: 'stdio' });
      // Simulate the user removing the hook: drop the `hooks` key entirely.
      writeFileSync(settingsPath(), JSON.stringify({ permissions: { allow: [] } }), 'utf8');

      const r = await run(() => hooksSync({}));
      expect(r.err).toBeUndefined();
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/re-installed/);

      const merged = JSON.parse(readFileSync(settingsPath(), 'utf8'));
      expect(merged.permissions).toEqual({ allow: [] });
      expect(Object.keys(merged.hooks)).toHaveLength(4);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('is a no-op when the hook is already present', async () => {
    const origCwd = process.cwd();
    try {
      process.chdir(root);
      await init(root, { transport: 'stdio' });
      const r = await run(() => hooksSync({ json: true }));
      expect(r.err).toBeUndefined();
      const envelope = JSON.parse(r.stdout) as {
        ok: boolean;
        data: { host: string; outcomes: Array<{ path: string; mode: string; written: boolean }> };
      };
      expect(envelope.ok).toBe(true);
      expect(envelope.data.host).toBe('claude');
      expect(envelope.data.outcomes).toEqual([
        { path: '.claude/settings.local.json', mode: 'mergeJson', written: false },
      ]);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('force rewrites a drifted command to the current one', async () => {
    const origCwd = process.cwd();
    try {
      process.chdir(root);
      await init(root, { transport: 'stdio' });
      const stale = {
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"old" hook' }] }] },
      };
      writeFileSync(settingsPath(), JSON.stringify(stale), 'utf8');

      const r = await run(() => hooksSync({ force: true }));
      expect(r.err).toBeUndefined();
      const merged = JSON.parse(readFileSync(settingsPath(), 'utf8'));
      expect(merged.hooks.SessionStart).toEqual([
        { hooks: [{ type: 'command', command: '"noir" hook' }] },
      ]);
      // Force re-adds the other three events too.
      expect(Object.keys(merged.hooks)).toHaveLength(4);
    } finally {
      process.chdir(origCwd);
    }
  });

  it('fails exit 1 with the init hint when the project is not initialized', async () => {
    const origCwd = process.cwd();
    try {
      process.chdir(root);
      const r = await run(() => hooksSync({ json: true }));
      expect(r.err).toBeDefined();
      expect(inferExitCode(r.err)).toBe(1);
      const env = JSON.parse(r.stdout) as { ok: boolean; error: { code: number; message: string } };
      expect(env.ok).toBe(false);
      expect(env.error.message).toMatch(/noir init/);
    } finally {
      process.chdir(origCwd);
    }
  });
});
