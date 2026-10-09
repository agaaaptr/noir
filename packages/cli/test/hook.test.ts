// The `noir hook` output contract. Claude Code validates `hookSpecificOutput`
// strictly: `hookEventName` is REQUIRED and `additionalContext` is the field
// that injects the router + anti-slop text. This pins both, plus the empty
// case and the upward `.noir/` search — the exact schema whose absence broke
// SessionStart with "missing required field hookEventName".
//
// Offline/free: no network, no API key, no daemon.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookOutput } from '../src/commands/hook.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-hook-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('noir hook output', () => {
  it('emits hookEventName + additionalContext when both files are present', () => {
    mkdirSync(join(root, '.noir', 'rules'), { recursive: true });
    writeFileSync(join(root, '.noir', 'router.md'), '# Noir skill router\n', 'utf8');
    writeFileSync(join(root, '.noir', 'rules', 'anti-slop.md'), 'noir-debt: be lazy\n', 'utf8');

    const out = hookOutput('SessionStart', root);

    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '# Noir skill router\n\nnoir-debt: be lazy',
      },
    });
  });

  it('echoes the SubagentStart event name through', () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(join(root, '.noir', 'router.md'), 'route me', 'utf8');

    const out = hookOutput('SubagentStart', root);

    expect((out.hookSpecificOutput as { hookEventName: string }).hookEventName).toBe(
      'SubagentStart',
    );
  });

  it('keeps hookEventName but omits additionalContext when no files exist', () => {
    const out = hookOutput('SessionStart', root);

    expect(out).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart' } });
  });

  it('finds .noir/ by walking up from a subdirectory', () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeFileSync(join(root, '.noir', 'router.md'), 'from root', 'utf8');
    const sub = join(root, 'a', 'b');
    mkdirSync(sub, { recursive: true });

    const out = hookOutput('SessionStart', sub);

    expect((out.hookSpecificOutput as { additionalContext: string }).additionalContext).toContain(
      'from root',
    );
  });
});
