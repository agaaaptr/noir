// The `emitHooks` adapter seam: each host returns the thin per-host hook config
// that invokes the shared `noir hook` dispatcher. Hosts with no hook surface
// return none.
import { describe, expect, it } from 'vitest';
import {
  agentsMdAdapter,
  claudeAdapter,
  cursorAdapter,
  geminiAdapter,
  opencodeAdapter,
} from '../src/index.js';

const CMD = { command: 'noir' };

describe('emitHooks seam', () => {
  it('claude wires all four events into settings.local.json (mergeJson)', () => {
    const emissions = claudeAdapter.emitHooks?.(CMD) ?? [];
    expect(emissions).toHaveLength(1);
    const [e] = emissions;
    expect(e.path).toBe('.claude/settings.local.json');
    expect(e.mode).toBe('mergeJson');
    expect(e.dedupSubstring).toBe(' hook');
    const hooks = (e.content as { hooks: Record<string, unknown> }).hooks;
    expect(Object.keys(hooks).sort()).toEqual([
      'PreToolUse',
      'SessionStart',
      'Stop',
      'SubagentStart',
    ]);
    for (const key of ['SessionStart', 'SubagentStart', 'PreToolUse', 'Stop']) {
      const group = (hooks[key] as Array<{ hooks: Array<{ command: string }> }>)[0];
      expect(group.hooks[0].command).toBe('"noir" hook');
    }
  });

  it('gemini wires SessionStart + BeforeTool into settings.json (mergeJson)', () => {
    const emissions = geminiAdapter.emitHooks?.(CMD) ?? [];
    expect(emissions).toHaveLength(1);
    const [e] = emissions;
    expect(e.path).toBe('.gemini/settings.json');
    expect(e.mode).toBe('mergeJson');
    const hooks = (e.content as { hooks: Record<string, unknown> }).hooks;
    expect(Object.keys(hooks).sort()).toEqual(['BeforeTool', 'SessionStart']);
  });

  it('cursor writes a standalone hooks.json (regenerate) with failClosed deny', () => {
    const emissions = cursorAdapter.emitHooks?.(CMD) ?? [];
    expect(emissions).toHaveLength(1);
    const [e] = emissions;
    expect(e.path).toBe('.cursor/hooks.json');
    expect(e.mode).toBe('regenerate');
    const content = e.content as {
      version: number;
      hooks: Record<string, Array<Record<string, unknown>>>;
    };
    expect(content.version).toBe(1);
    expect(Object.keys(content.hooks).sort()).toEqual(['preToolUse', 'sessionStart']);
    expect(content.hooks.preToolUse[0].failClosed).toBe(true);
  });

  it('agents-md and opencode have no hook surface', () => {
    expect(agentsMdAdapter.emitHooks).toBeUndefined();
    expect(opencodeAdapter.emitHooks).toBeUndefined();
  });
});
