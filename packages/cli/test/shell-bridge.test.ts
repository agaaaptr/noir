// Shell-bridge fallback (Slice C): when `noir run --command <name>` fails with
// ENOENT, resolve the name through the user's interactive shell — PATH entries
// exported in rc files, zsh/bash/fish aliases and functions. The name always
// travels via argv (never in the -c string) and the host prompt only as "$@",
// so no user-controlled text ever reaches the shell parser.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildBridgeArgs,
  classifyResolution,
  isEligibleForShellFallback,
  parseProbeOutput,
  resolveCommandViaShell,
} from '../src/shell-bridge.js';

const hasZsh = ((): boolean => {
  try {
    return spawnSync('zsh', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

const POSIX = { platform: 'darwin' as const };
const ENV = (shell: string, path: string, home: string): Record<string, string> => ({
  ...process.env,
  SHELL: shell,
  PATH: path,
  HOME: home,
  // zsh reads rc files from $ZDOTDIR (defaults to $HOME but can be set to
  // something else, as it is in this dev environment) — pin it to the temp dir
  // so the integration tests control exactly which .zshrc is sourced.
  ZDOTDIR: home,
});

describe('isEligibleForShellFallback — guards', () => {
  it('rejects a name containing a path separator (it is a path, not a shell name)', () => {
    expect(
      isEligibleForShellFallback('/usr/bin/claude', { env: ENV('/bin/zsh', '', ''), ...POSIX }),
    ).toBe(false);
    expect(isEligibleForShellFallback('./claude', { env: ENV('/bin/zsh', '', ''), ...POSIX })).toBe(
      false,
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(
      isEligibleForShellFallback('a;rm -rf /', { env: ENV('/bin/zsh', '', ''), ...POSIX }),
    ).toBe(false);
    expect(isEligibleForShellFallback('$(x)', { env: ENV('/bin/zsh', '', ''), ...POSIX })).toBe(
      false,
    );
    expect(isEligibleForShellFallback('a b', { env: ENV('/bin/zsh', '', ''), ...POSIX })).toBe(
      false,
    );
  });

  it('accepts a plain command name', () => {
    expect(
      isEligibleForShellFallback('claude-work', { env: ENV('/bin/zsh', '', ''), ...POSIX }),
    ).toBe(true);
    expect(
      isEligibleForShellFallback('git_2', { env: ENV('/usr/bin/bash', '', ''), ...POSIX }),
    ).toBe(true);
  });

  it('returns false when SHELL is unset, unknown, or non-POSIX platforms', () => {
    expect(
      isEligibleForShellFallback('x', { env: { ...process.env, SHELL: undefined }, ...POSIX }),
    ).toBe(false);
    expect(isEligibleForShellFallback('x', { env: ENV('/bin/dash', '', ''), ...POSIX })).toBe(
      false,
    );
    expect(
      isEligibleForShellFallback('x', { env: ENV('/bin/zsh', '', ''), platform: 'win32' }),
    ).toBe(false);
  });
});

describe('parseProbeOutput + classifyResolution — sentinel parsing', () => {
  it('parses a PATH executable (zsh whence format)', () => {
    const out = '\nN:/opt/homebrew/bin/claude\nK:claude: command\n';
    const { path, kind } = parseProbeOutput(out);
    expect(classifyResolution(path, kind)).toBe('path');
  });

  it('parses an alias (zsh format: "NAME: alias")', () => {
    const { path, kind } = parseProbeOutput('\nN:\nK:workpro: alias\n');
    expect(classifyResolution(path, kind)).toBe('alias');
  });

  it('parses a function (bash format: bare "function")', () => {
    const { path, kind } = parseProbeOutput(
      'bash: no job control in this shell\n\nN:\nK:function\n',
    );
    expect(classifyResolution(path, kind)).toBe('function');
  });

  it('parses "not found" as none, ignoring rc noise lines', () => {
    const { path, kind } = parseProbeOutput('random rc banner\n\nN:\nK:zzz: none\n');
    expect(classifyResolution(path, kind)).toBe('none');
  });

  it('uses the LAST sentinel pair (rc noise may contain N:/K: lookalikes)', () => {
    const { path, kind } = parseProbeOutput(
      'N:noise\nK:noise\n\nN:/usr/local/bin/x\nK:x: command\n',
    );
    expect(path).toBe('/usr/local/bin/x');
    expect(classifyResolution(path, kind)).toBe('path');
  });
});

describe('buildBridgeArgs — prompt travels only via "$@" / $argv', () => {
  it('zsh bridge: -lic script, name literal, then hostArgs after the dummy $0', () => {
    const b = buildBridgeArgs(
      'claude-work',
      ['-p', '--output-format', 'stream-json', 'hi there'],
      '/bin/zsh',
    );
    expect(b.binary).toBe('/bin/zsh');
    expect(b.args[0]).toBe('-lic');
    expect(b.args[1]).toContain('claude-work "$@"');
    expect(b.args[2]).toBe('noirbridge');
    expect(b.args.slice(3)).toEqual(['-p', '--output-format', 'stream-json', 'hi there']);
  });

  it('bash bridge sources .bashrc explicitly (bash login shells skip it)', () => {
    const b = buildBridgeArgs('workpro', ['x'], '/bin/bash');
    expect(b.args[1]).toContain('.bashrc');
    expect(b.args[1]).toContain('workpro "$@"');
  });

  it('fish bridge uses $argv', () => {
    const b = buildBridgeArgs('workfn', ['x'], '/usr/local/bin/fish');
    expect(b.args[0]).toBe('-ic');
    expect(b.args[1]).toContain('workfn $argv');
  });
});

describe('resolveCommandViaShell — real-shell integration (gated on zsh/bash)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!hasZsh)(
    'resolves a PATH-only executable (exported PATH in rc is visible)',
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'noir-bridge-path-'));
      writeFileSync(join(dir, 'myprobe'), '#!/bin/sh\necho "ran $0"\n', { mode: 0o755 });
      const res = await resolveCommandViaShell('myprobe', {
        env: ENV('/bin/zsh', `${dir}:/usr/bin:/bin:/usr/sbin:/sbin`, dir),
      });
      expect(res.kind).toBe('path');
    },
  );

  it.skipIf(!hasZsh)('resolves a zsh alias defined in a temp .zshrc', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bridge-alias-'));
    writeFileSync(join(dir, '.zshrc'), 'alias workpro="echo alias-hit"\n', { mode: 0o644 });
    const res = await resolveCommandViaShell('workpro', {
      env: ENV('/bin/zsh', '/usr/bin:/bin:/usr/sbin:/sbin', dir),
    });
    expect(res.kind).toBe('alias');
  });

  it.skipIf(!hasZsh)('resolves a zsh function defined in a temp .zshrc', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bridge-fn-'));
    writeFileSync(join(dir, '.zshrc'), 'workfn() { echo "fn-hit"; }\n', { mode: 0o644 });
    const res = await resolveCommandViaShell('workfn', {
      env: ENV('/bin/zsh', '/usr/bin:/bin:/usr/sbin:/sbin', dir),
    });
    expect(res.kind).toBe('function');
  });

  it.skipIf(!hasZsh)('returns none for an unknown name', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bridge-none-'));
    const res = await resolveCommandViaShell('definitely-not-a-real-command-xyz', {
      env: ENV('/bin/zsh', '/usr/bin:/bin:/usr/sbin:/sbin', dir),
    });
    expect(res.kind).toBe('none');
  });
});
