// The 1.3.0 → 1.4.0 migration: an existing project's SessionStart hook command
// is moved off the directly-executed `.noir/hooks/noir-session-start.mjs` runner
// and onto `"<noir>" hook`, and the orphaned runner file is removed.
//
// The `.mjs` runner needed the file's exec bit and `node` on PATH; `noir hook`
// routes through the shim, which resolves the managed Node absolutely. The
// command lives in `.claude/settings.local.json`, which the manifest never
// re-emits (the user may have removed the hook), so only this upgrade path can
// repair an existing project's entry.
//
// Offline/free: no network, no API key, no embedder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrations/index.js';
import { writeScaffoldVersion } from '../src/scaffold-version.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mig-1-3-0-'));
  // Pin the MCP command so the rewritten hook command is machine-independent.
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  delete process.env.NOIR_MCP_COMMAND;
  rmSync(root, { recursive: true, force: true });
});

const settingsPath = (): string => join(root, '.claude', 'settings.local.json');
const runnerPath = (): string => join(root, '.noir', 'hooks', 'noir-session-start.mjs');

/** A project stamped 1.3.0 that still carries the old `.mjs` hook command. */
function seedOldHook(): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  mkdirSync(join(root, '.noir', 'hooks'), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        permissions: { allow: ['Bash(git *)'] },
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `"${join(root, '.noir', 'hooks', 'noir-session-start.mjs')}"`,
                },
              ],
            },
          ],
          SubagentStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: `"${join(root, '.noir', 'hooks', 'noir-session-start.mjs')}"`,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(runnerPath(), '#!/usr/bin/env node\n', 'utf8');
  writeScaffoldVersion(root, '1.3.0');
}

describe('migration 1.3.0 → 1.4.0 — the SessionStart hook command', () => {
  it('rewrites the .mjs command to `noir hook` and removes the runner', () => {
    seedOldHook();

    const res = runMigrations(root, '1.3.0', '1.4.0');

    expect(res.ran).toContain('1.3.0→1.4.0');
    expect(res.conflicts).toEqual([]);
    expect(res.changed).toContain('.claude/settings.local.json');
    expect(res.changed).toContain('.noir/hooks/noir-session-start.mjs');

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    // Both events now route through `noir hook`.
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('"noir" hook');
    expect(settings.hooks.SubagentStart[0].hooks[0].command).toBe('"noir" hook');
    // The user's permissions block survived.
    expect(settings.permissions).toEqual({ allow: ['Bash(git *)'] });
    // The orphaned runner is gone.
    expect(existsSync(runnerPath())).toBe(false);
  });

  it('is idempotent — a second run changes nothing', () => {
    seedOldHook();
    runMigrations(root, '1.3.0', '1.4.0');
    const once = readFileSync(settingsPath(), 'utf8');

    const again = runMigrations(root, '1.3.0', '1.4.0');

    expect(again.changed).toEqual([]);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(once);
  });

  it('leaves a hook command already routed through ` hook` alone', () => {
    seedOldHook();
    runMigrations(root, '1.3.0', '1.4.0');
    const alreadyRouted = readFileSync(settingsPath(), 'utf8');

    const res = runMigrations(root, '1.3.0', '1.4.0');

    expect(res.changed).toEqual([]);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(alreadyRouted);
  });

  it('reports the rewrite as planned under --dry-run and touches nothing', () => {
    seedOldHook();
    const beforeSettings = readFileSync(settingsPath(), 'utf8');

    const res = runMigrations(root, '1.3.0', '1.4.0', { dryRun: true });

    expect(res.changed).toContain('.claude/settings.local.json');
    expect(res.changed).toContain('.noir/hooks/noir-session-start.mjs');
    expect(readFileSync(settingsPath(), 'utf8')).toBe(beforeSettings);
  });
});
