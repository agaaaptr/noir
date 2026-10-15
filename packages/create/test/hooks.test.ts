import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emitHooksToFile } from '../src/hooks.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-create-hooks-'));
  // Pin the resolved `noir` command so hook contents are deterministic (the
  // production path would read the install record; the env override is the test seam).
  process.env.NOIR_MCP_COMMAND = 'noir';
});
afterEach(() => {
  delete process.env.NOIR_MCP_COMMAND;
  rmSync(dir, { recursive: true, force: true });
});

describe('emitHooksToFile', () => {
  it('writes the claude hook mergeJson file once, then is a no-op', () => {
    const res1 = emitHooksToFile(dir, 'claude');
    expect(res1.outcomes).toHaveLength(1);
    expect(res1.outcomes[0]).toMatchObject({
      path: '.claude/settings.local.json',
      mode: 'mergeJson',
      written: true,
    });

    const written = JSON.parse(readFileSync(join(dir, '.claude/settings.local.json'), 'utf8'));
    expect(Object.keys(written.hooks).sort()).toEqual([
      'PreToolUse',
      'SessionStart',
      'Stop',
      'SubagentStart',
    ]);

    const res2 = emitHooksToFile(dir, 'claude');
    expect(res2.outcomes[0].written).toBe(false);
  });

  it('re-adds the claude hook after the file is removed, preserving user keys', () => {
    emitHooksToFile(dir, 'claude');
    const f = join(dir, '.claude/settings.local.json');
    const withUser = {
      permissions: { allow: ['Bash(git *)'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"noir" hook' }] }] },
    };
    writeFileSync(f, JSON.stringify(withUser), 'utf8');

    // Simulate the user removing the hook entry (leaving only their permissions).
    writeFileSync(f, JSON.stringify({ permissions: withUser.permissions }), 'utf8');
    const res = emitHooksToFile(dir, 'claude');
    expect(res.outcomes[0].written).toBe(true);

    const merged = JSON.parse(readFileSync(f, 'utf8'));
    expect(merged.permissions).toEqual({ allow: ['Bash(git *)'] });
    expect(Object.keys(merged.hooks)).toHaveLength(4);
  });

  it('force refreshes a drifted claude command', () => {
    emitHooksToFile(dir, 'claude');
    const res = emitHooksToFile(dir, 'claude', { force: true });
    // The command is already current, so force is still a no-op byte-wise.
    expect(res.outcomes[0].written).toBe(false);

    const f = join(dir, '.claude/settings.local.json');
    writeFileSync(
      f,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '"old" hook' }] }] },
      }),
      'utf8',
    );
    const forced = emitHooksToFile(dir, 'claude', { force: true });
    expect(forced.outcomes[0].written).toBe(true);
    const merged = JSON.parse(readFileSync(f, 'utf8'));
    expect(merged.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: '"noir" hook' }] },
    ]);
    expect(merged.hooks.PreToolUse).toBeDefined();
  });

  it('writes the gemini hook into .gemini/settings.json', () => {
    const res = emitHooksToFile(dir, 'gemini');
    expect(res.outcomes[0]).toMatchObject({
      path: '.gemini/settings.json',
      mode: 'mergeJson',
      written: true,
    });
    const written = JSON.parse(readFileSync(join(dir, '.gemini/settings.json'), 'utf8'));
    expect(Object.keys(written.hooks).sort()).toEqual(['BeforeTool', 'SessionStart']);
  });

  it('regenerates the cursor hook file, then is a no-op', () => {
    const res = emitHooksToFile(dir, 'cursor');
    expect(res.outcomes[0]).toMatchObject({
      path: '.cursor/hooks.json',
      mode: 'regenerate',
      written: true,
    });
    const written = JSON.parse(readFileSync(join(dir, '.cursor/hooks.json'), 'utf8'));
    expect(written.version).toBe(1);
    expect(written.hooks.sessionStart).toBeDefined();

    const again = emitHooksToFile(dir, 'cursor');
    expect(again.outcomes[0].written).toBe(false);
  });

  it('returns no outcomes for a host with no hook surface', () => {
    const res = emitHooksToFile(dir, 'agents-md');
    expect(res.outcomes).toEqual([]);
    expect(existsSync(join(dir, '.claude/settings.local.json'))).toBe(false);
  });
});
