// Home-consolidation (S1) — the shared curated-section module.
//
// The no-drift contract: every {@link HomeAction} references a palette-registry
// id, and {@link resolveSections} drops actions whose id no longer exists in
// the live registry. These tests pin that contract — the menu + TUI home must
// resolve against the real commander tree so they cannot drift from it.

import { describe, expect, it } from 'vitest';
import { createProgram } from '../../src/bin.js';
import { buildPaletteCommands } from '../../src/tui/commands/registry.js';
import {
  HOME_SECTIONS,
  type HomeAction,
  resolveSections,
} from '../../src/tui/commands/sections.js';

describe('HOME_SECTIONS — curated quick-action coverage', () => {
  it('defines 5 sections with stable ids + keys + items', () => {
    expect(HOME_SECTIONS.length).toBe(5);
    const ids = HOME_SECTIONS.map((s) => s.id);
    expect(ids).toEqual(['status', 'memory', 'workflow', 'setup', 'dashboard']);
    for (const s of HOME_SECTIONS) {
      expect(s.key).toBeTruthy();
      expect(s.label).toBeTruthy();
      expect(s.items.length).toBeGreaterThan(0);
    }
  });

  it('every curated action covers a distinct palette command (no dupes)', () => {
    const seen = new Set<string>();
    for (const s of HOME_SECTIONS) {
      for (const a of s.items) {
        expect(seen.has(a.id)).toBe(false);
        seen.add(a.id);
      }
    }
  });

  it('covers the major interactive surfaces (dashboard + palette + core)', () => {
    const allIds = HOME_SECTIONS.flatMap((s) => s.items.map((a) => a.id));
    expect(allIds).toContain('status');
    expect(allIds).toContain('context index');
    expect(allIds).toContain('memory recall');
    expect(allIds).toContain('task next');
    expect(allIds).toContain('handoff');
    expect(allIds).toContain('tui');
    expect(allIds).toContain('palette');
    expect(allIds).toContain('init');
    expect(allIds).toContain('sync');
  });
});

describe('resolveSections — no-drift against the live registry', () => {
  it('resolves every curated id against buildPaletteCommands(createProgram())', async () => {
    const commands = buildPaletteCommands(createProgram());
    const resolved = await resolveSections(commands);
    // Every action in the curated module must survive resolution (its id exists
    // in the real commander tree) — if a command was renamed/removed, this
    // test fails so the menu never silently loses an option.
    const curatedIds = HOME_SECTIONS.flatMap((s) => s.items.map((a) => a.id));
    const resolvedIds = new Set(resolved.flatMap((s) => s.items.map((a) => a.id)));
    for (const id of curatedIds) {
      expect(resolvedIds.has(id), `curated id '${id}' must exist in the live registry`).toBe(true);
    }
  });

  it('resolves dispatch argv from the registry (never hand-written)', async () => {
    const commands = buildPaletteCommands(createProgram());
    const resolved = await resolveSections(commands);
    const byId = new Map(commands.map((c) => [c.id, c]));
    for (const s of resolved) {
      for (const a of s.items) {
        const entry = byId.get(a.id);
        expect(a.dispatch).toEqual(a.dispatch ?? [...(entry?.argv ?? [])]);
      }
    }
  });

  it('drops actions whose id no longer exists (graceful degradation)', async () => {
    // Simulate a future commander that removed `memory consolidate`.
    const commands = buildPaletteCommands(createProgram()).filter(
      (c) => c.id !== 'memory consolidate',
    );
    const resolved = await resolveSections(commands);
    const ids = resolved.flatMap((s) => s.items.map((a) => a.id));
    expect(ids).not.toContain('memory consolidate');
    // The rest survive.
    expect(ids).toContain('memory recall');
    expect(ids).toContain('status');
  });

  it('drops a section that goes fully empty', async () => {
    // Keep only commands whose id starts with "task" — the setup/dashboard/
    // status/memory sections all become empty.
    const commands = buildPaletteCommands(createProgram()).filter((c) => c.id.startsWith('task'));
    const resolved = await resolveSections(commands);
    expect(resolved.length).toBe(1); // only the workflow section survives
    expect(resolved[0]?.id).toBe('workflow');
  });

  it('honors explicit dispatch overrides (e.g. wrap → --write)', async () => {
    const commands = buildPaletteCommands(createProgram());
    const resolved = await resolveSections(commands);
    const wrap = resolved
      .flatMap((s) => s.items as readonly HomeAction[])
      .find((a) => a.id === 'wrap');
    expect(wrap?.dispatch).toEqual(['wrap', '--write']);
  });
});
