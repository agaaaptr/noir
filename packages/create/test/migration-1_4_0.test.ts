// The 1.4.0 → 1.5.0 migration: an existing claude hook gains the PreToolUse
// (deny-list) and Stop (verify gate) enforcement events. The hook entry is
// write-once, so an install created before enforcement shipped only has
// SessionStart + SubagentStart; this upgrade appends the two new events.
//
// Offline/free: no network, no API key, no embedder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/migrations/index.js';
import { writeScaffoldVersion } from '../src/scaffold-version.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mig-1-4-0-'));
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  delete process.env.NOIR_MCP_COMMAND;
  rmSync(root, { recursive: true, force: true });
});

const settingsPath = (): string => join(root, '.claude', 'settings.local.json');

function seedHook(): void {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(
    settingsPath(),
    JSON.stringify(
      {
        permissions: { allow: ['Bash(git *)'] },
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: '"noir" hook' }] }],
          SubagentStart: [{ hooks: [{ type: 'command', command: '"noir" hook' }] }],
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeScaffoldVersion(root, '1.4.0');
}

describe('migration 1.4.0 → 1.5.0 — the enforcement hook events', () => {
  it('appends PreToolUse + Stop and preserves the existing entries', () => {
    seedHook();
    const res = runMigrations(root, '1.4.0', '1.5.0');

    expect(res.ran).toContain('1.4.0→1.5.0');
    expect(res.conflicts).toEqual([]);
    expect(res.changed).toContain('.claude/settings.local.json');

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('"noir" hook');
    expect(settings.hooks.Stop[0].hooks[0].command).toBe('"noir" hook');
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('"noir" hook');
    expect(settings.permissions).toEqual({ allow: ['Bash(git *)'] });
  });

  it('is idempotent — a second run changes nothing', () => {
    seedHook();
    runMigrations(root, '1.4.0', '1.5.0');
    const once = readFileSync(settingsPath(), 'utf8');

    const again = runMigrations(root, '1.4.0', '1.5.0');

    expect(again.changed).toEqual([]);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(once);
  });

  it('reports the append as planned under --dry-run and touches nothing', () => {
    seedHook();
    const before = readFileSync(settingsPath(), 'utf8');

    const res = runMigrations(root, '1.4.0', '1.5.0', { dryRun: true });

    expect(res.changed).toContain('.claude/settings.local.json');
    expect(readFileSync(settingsPath(), 'utf8')).toBe(before);
  });

  it('no-ops when the project has no settings.local.json', () => {
    writeScaffoldVersion(root, '1.4.0');
    const res = runMigrations(root, '1.4.0', '1.5.0');
    expect(res.changed).toEqual([]);
  });
});

describe('migration 1.4.0 → 1.5.0 — the gemini hook backfill', () => {
  function seedGemini(): void {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(join(root, '.noir', 'config.yml'), 'host: gemini\nmode: full\n', 'utf8');
    writeScaffoldVersion(root, '1.4.0');
  }

  it('creates the gemini hook when the settings file is absent', () => {
    seedGemini();
    const res = runMigrations(root, '1.4.0', '1.5.0');

    expect(res.ran).toContain('1.4.0→1.5.0');
    expect(res.changed).toContain('.gemini/settings.json');

    const settings = JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('"noir" hook --host gemini');
    expect(settings.hooks.BeforeTool[0].matcher).toBe('.*');
  });

  it('preserves existing gemini settings while appending the hooks', () => {
    seedGemini();
    mkdirSync(join(root, '.gemini'), { recursive: true });
    writeFileSync(
      join(root, '.gemini', 'settings.json'),
      JSON.stringify({ model: { name: 'gemini-pro' } }, null, 2),
      'utf8',
    );

    runMigrations(root, '1.4.0', '1.5.0');

    const settings = JSON.parse(readFileSync(join(root, '.gemini', 'settings.json'), 'utf8'));
    expect(settings.model).toEqual({ name: 'gemini-pro' });
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.BeforeTool).toBeDefined();
  });
});
