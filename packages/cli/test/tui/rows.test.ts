// v2 — buildPaletteRows dedup (recents vs curated quick-actions vs full list).
// Pure function tests: a command must never render twice on one palette screen.
import { describe, expect, it } from 'vitest';
import type { HomeSection } from '../../src/tui/commands/sections.js';
import { handRolledMatcher } from '../../src/tui/palette/matcher.js';
import { buildPaletteRows } from '../../src/tui/palette/rows.js';
import type { PaletteCommand } from '../../src/tui/palette/types.js';

function cmd(id: string, category = 'x'): PaletteCommand {
  return {
    id,
    label: id,
    argv: id.split(' '),
    category,
    keywords: id.split(' '),
    description: id,
    destructive: false,
  };
}

describe('buildPaletteRows — dedup', () => {
  it('a command in both recents and a curated home section renders once (recents wins)', () => {
    const commands = [cmd('status'), cmd('context index'), cmd('doctor')];
    const recent = [cmd('status')];
    const homeSections: HomeSection[] = [
      {
        id: 'status',
        label: 'Status & context',
        hint: 'x',
        items: [{ id: 'status', label: 'Status', hint: 'snapshot' }],
      },
    ];
    const rows = buildPaletteRows({
      corpus: 'commands',
      query: '',
      commands,
      matcher: handRolledMatcher,
      recent,
      homeSections,
      outputLines: [],
    });
    const statusRows = rows.filter((r) => r.key === 'recent:status' || r.key === 'home:status');
    expect(statusRows.length).toBe(1);
    expect(statusRows[0]?.key).toBe('recent:status');
  });

  it('a recent command is skipped from the full command list', () => {
    const commands = [cmd('status'), cmd('doctor')];
    const recent = [cmd('status')];
    const rows = buildPaletteRows({
      corpus: 'commands',
      query: '',
      commands,
      matcher: handRolledMatcher,
      recent,
      homeSections: [],
      outputLines: [],
    });
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('recent:status');
    expect(keys).not.toContain('cmd:status'); // deduped out of the full list
    expect(keys).toContain('cmd:doctor');
  });

  it('a curated home action is skipped from the full command list', () => {
    const commands = [cmd('status'), cmd('doctor')];
    const homeSections: HomeSection[] = [
      {
        id: 'status',
        label: 'Status & context',
        hint: 'x',
        items: [{ id: 'status', label: 'Status', hint: 'snapshot' }],
      },
    ];
    const rows = buildPaletteRows({
      corpus: 'commands',
      query: '',
      commands,
      matcher: handRolledMatcher,
      recent: [],
      homeSections,
      outputLines: [],
    });
    const keys = rows.map((r) => r.key);
    expect(keys).toContain('home:status');
    expect(keys).not.toContain('cmd:status');
    expect(keys).toContain('cmd:doctor');
  });
});
