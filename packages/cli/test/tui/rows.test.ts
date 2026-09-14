// v2 — buildPaletteRows dedup (recents vs curated quick-actions vs full list).
// Pure function tests: a command must never render twice on one palette screen.
import { describe, expect, it } from 'vitest';
import type { HomeSection } from '../../src/tui/commands/sections.js';
import { handRolledMatcher } from '../../src/tui/palette/matcher.js';
import { buildPaletteRows } from '../../src/tui/palette/rows.js';
import type { PaletteCommand } from '../../src/tui/palette/types.js';

function cmd(id: string, category = 'x', needsArg?: string): PaletteCommand {
  return {
    id,
    label: id,
    argv: id.split(' '),
    category,
    keywords: id.split(' '),
    description: id,
    destructive: false,
    needsArg,
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

describe('buildPaletteRows — argument requirements', () => {
  /** A curated action for `prompt`, declaring a value the CLI leaves optional. */
  const PROMPT_SECTION: HomeSection = {
    id: 'workflow',
    label: 'Workflow',
    hint: 'run',
    items: [
      {
        id: 'prompt',
        label: 'Ask the host',
        hint: 'ask the host',
        needsArg: { label: 'prompt', prompt: 'Prompt:', placeholder: 'x' },
      },
    ],
  };

  function rows(input: {
    query?: string;
    commands: readonly PaletteCommand[];
    recent?: readonly PaletteCommand[];
    homeSections?: readonly HomeSection[];
  }) {
    return buildPaletteRows({
      corpus: 'commands',
      query: input.query ?? '',
      commands: input.commands,
      matcher: handRolledMatcher,
      recent: input.recent ?? [],
      homeSections: input.homeSections ?? [],
      outputLines: [],
    });
  }

  it('carries the command-declared requirement onto full-list rows', () => {
    const rowsList = rows({ commands: [cmd('context search', 'context', 'query'), cmd('status')] });
    expect(rowsList.find((r) => r.key === 'cmd:context search')?.needsArg).toBe('query');
    expect(rowsList.find((r) => r.key === 'cmd:status')?.needsArg).toBeUndefined();
  });

  it('carries it onto fuzzy-filtered rows too', () => {
    const rowsList = rows({
      query: 'sea',
      commands: [cmd('context search', 'context', 'query'), cmd('status')],
    });
    expect(rowsList[0]?.key).toBe('cmd:context search');
    expect(rowsList[0]?.needsArg).toBe('query');
  });

  it('carries it onto recent rows', () => {
    const commands = [cmd('context search', 'context', 'query')];
    const rowsList = rows({ commands, recent: commands });
    expect(rowsList.find((r) => r.key === 'recent:context search')?.needsArg).toBe('query');
  });

  it('takes the curated label for an action the CLI declares no requirement for', () => {
    const commands = [cmd('prompt'), cmd('status')];
    const rowsList = rows({ commands, homeSections: [PROMPT_SECTION] });
    // The curated row itself …
    expect(rowsList.find((r) => r.key === 'home:prompt')?.needsArg).toBe('prompt');
    // … and the same command reached by fuzzy search behaves identically.
    const filtered = rows({ query: 'prompt', commands, homeSections: [PROMPT_SECTION] });
    expect(filtered[0]?.needsArg).toBe('prompt');
  });

  /**
   * The curated `memory save` action passes its value behind the `--content`
   * flag, so it dispatches a DIFFERENT argv than the registry entry for the same
   * command. Only the row carrying that flag can accept the value — a row that
   * dispatches `memory save` bare would swallow it (commander ignores the extra
   * operand and the command re-prompts).
   */
  const MEMORY_SAVE_SECTION: HomeSection = {
    id: 'memory',
    label: 'Memory',
    hint: 'save · recall',
    items: [
      {
        id: 'memory save',
        label: 'Save memory',
        hint: 'save an observation',
        destructive: true,
        dispatch: ['memory', 'save', '--content'],
        needsArg: { label: 'content', prompt: 'Memory content:', placeholder: 'x' },
      },
    ],
  };

  it('still asks on the curated row that dispatches the value flag', () => {
    const rowsList = rows({ commands: [cmd('memory save')], homeSections: [MEMORY_SAVE_SECTION] });
    expect(rowsList.find((r) => r.key === 'home:memory save')?.needsArg).toBe('content');
  });

  it('never asks a fuzzy row for a value its bare dispatch would drop', () => {
    const rowsList = rows({
      query: 'memory',
      commands: [cmd('memory save')],
      homeSections: [MEMORY_SAVE_SECTION],
    });
    const row = rowsList.find((r) => r.key === 'cmd:memory save');
    expect(row?.argv).toEqual(['memory', 'save']);
    expect(row?.needsArg).toBeUndefined();
  });

  it('never asks a recent row for a value its bare dispatch would drop', () => {
    const commands = [cmd('memory save')];
    const rowsList = rows({
      commands,
      recent: commands,
      homeSections: [MEMORY_SAVE_SECTION],
    });
    const row = rowsList.find((r) => r.key === 'recent:memory save');
    expect(row?.argv).toEqual(['memory', 'save']);
    expect(row?.needsArg).toBeUndefined();
  });
});
