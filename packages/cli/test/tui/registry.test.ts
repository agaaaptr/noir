// A1 — palette command derivation from a commander program.
//
// `buildPaletteCommands(program)` walks the commander tree and collects LEAF
// commands only (an action handler AND no child commands), skipping bare groups
// (which carry a usage-throwing fallback action but own children). These tests
// drive a FRESH `new Command()` program (not `createProgram`) so the registry is
// exercised in isolation — the real `noir` tree shape is irrelevant here; what
// matters is that the walker honors the leaf/destructive/group contract.

import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { createProgram } from '../../src/bin.js';
import { buildPaletteCommands } from '../../src/tui/commands/registry.js';
import type { PaletteCommand } from '../../src/tui/palette/types.js';

/** Build a small, isolated program mirroring the relevant `noir` shapes. */
function sampleProgram(): Command {
  const program = new Command();

  // `noir context {search,index,status}` — a group with three leaves.
  const contextGrp = program.command('context').description('context engine (S6)');
  contextGrp
    .command('search')
    .description('search the context index')
    .argument('<query>', 'search query')
    .action(() => {});
  contextGrp
    .command('index')
    .description('(re)index the project into the context store')
    .action(() => {});
  contextGrp
    .command('status')
    .description('show context index status')
    .action(() => {});
  // Groups carry a fallback usage action in the real CLI; this must NOT turn
  // the group into a palette entry.
  contextGrp.action(() => {
    throw new Error('Usage: noir context search|index|status');
  });

  // `noir memory recall` — a leaf under a group, non-destructive.
  const memoryGrp = program.command('memory').description('memory engine');
  memoryGrp
    .command('recall')
    .description('recall memories for a query')
    .argument('<query>', 'recall query')
    .action(() => {});
  memoryGrp
    .command('save')
    .description('save a memory')
    .action(() => {});
  memoryGrp.action(() => {
    throw new Error('Usage: noir memory recall|save');
  });

  // A bare top-level leaf with no description (falls back to argv label).
  program.command('doctor').action(() => {});

  // A bare group with children but NO action handler at all — still skipped
  // (it owns children, so it is not a leaf regardless of its action state).
  const taskGrp = program.command('task').description('workflow task control');
  taskGrp
    .command('new')
    .description('create a new task')
    .action(() => {});
  taskGrp
    .command('status')
    .description('show task status')
    .action(() => {});

  return program;
}

describe('buildPaletteCommands', () => {
  it('derives one palette entry per leaf command with id/label/argv/category', () => {
    const cmds = buildPaletteCommands(sampleProgram());
    const ids = cmds.map((c) => c.id).sort();

    // Six leaves: context {search,index,status}, memory {recall,save}, doctor, task {new,status}.
    expect(ids).toEqual([
      'context index',
      'context search',
      'context status',
      'doctor',
      'memory recall',
      'memory save',
      'task new',
      'task status',
    ]);

    // Groups (context, memory, task) are NOT leaves — they own children — so
    // they must never appear, even though context/memory carry a fallback action.
    expect(cmds.find((c) => c.id === 'context')).toBeUndefined();
    expect(cmds.find((c) => c.id === 'memory')).toBeUndefined();
    expect(cmds.find((c) => c.id === 'task')).toBeUndefined();

    // Spot-check the derived fields for a multi-segment leaf.
    const search = cmds.find((c) => c.id === 'context search') as PaletteCommand;
    expect(search.label).toBe('Context: Search');
    expect(search.argv).toEqual(['context', 'search']);
    expect(search.category).toBe('context');
    expect(search.keywords).toEqual(['context', 'search']);
    expect(search.description).toBe('search the context index');
    expect(search.destructive).toBe(false);

    // A bare leaf with no description falls back to its argv as the description.
    const doctor = cmds.find((c) => c.id === 'doctor') as PaletteCommand;
    expect(doctor.description).toBe('doctor');
    expect(doctor.label).toBe('Doctor');
    expect(doctor.category).toBe('doctor');
  });

  it('marks destructive argv-prefixes and leaves reads non-destructive', () => {
    const cmds = buildPaletteCommands(sampleProgram());
    const byId = new Map(cmds.map((c) => [c.id, c]));

    // `context index` is destructive per the prefix table; `context search` /
    // `context status` are reads and stay non-destructive.
    expect((byId.get('context index') as PaletteCommand).destructive).toBe(true);
    expect((byId.get('context search') as PaletteCommand).destructive).toBe(false);
    expect((byId.get('context status') as PaletteCommand).destructive).toBe(false);

    // `memory save` mutates the store → destructive; `memory recall` is a read.
    expect((byId.get('memory save') as PaletteCommand).destructive).toBe(true);
    expect((byId.get('memory recall') as PaletteCommand).destructive).toBe(false);

    // `task new` advances workflow state → destructive.
    expect((byId.get('task new') as PaletteCommand).destructive).toBe(true);
  });

  it('skips bare groups (command containers that own children)', () => {
    const cmds = buildPaletteCommands(sampleProgram());
    const ids = cmds.map((c) => c.id);

    // `task` is a bare group: it has children and no fallback action, yet it is
    // still excluded because it owns children (not a leaf). The same applies to
    // `context` and `memory` which DO have a fallback action — owning children
    // disqualifies a node regardless of its action handler.
    expect(ids).not.toContain('task');
    expect(ids).not.toContain('context');
    expect(ids).not.toContain('memory');

    // The group's children ARE surfaced as leaves.
    expect(ids).toContain('task new');
    expect(ids).toContain('task status');
  });
});

/** A program covering each argument-declaration shape the CLI uses. */
function argProgram(): Command {
  const program = new Command();
  program
    .command('query')
    .argument('<query>', 'a required value')
    .action(() => {});
  program
    .command('forget')
    .argument('<ids...>', 'one or more required values')
    .action(() => {});
  program
    .command('advance')
    .argument('[id]', 'an optional value')
    .action(() => {});
  program.command('status').action(() => {});
  return program;
}

describe('buildPaletteCommands — argument requirements', () => {
  it('marks a required argument and leaves optional/argless commands unset', () => {
    const byId = new Map(buildPaletteCommands(argProgram()).map((c) => [c.id, c]));

    // `<query>` must be supplied — the label is the argument name, without the
    // angle brackets.
    expect((byId.get('query') as PaletteCommand).needsArg).toBe('query');
    // A variadic `<ids...>` still needs at least one value, and its label drops
    // the ellipsis.
    expect((byId.get('forget') as PaletteCommand).needsArg).toBe('ids');
    // An optional `[id]` may be omitted, so the command runs bare.
    expect((byId.get('advance') as PaletteCommand).needsArg).toBeUndefined();
    expect((byId.get('status') as PaletteCommand).needsArg).toBeUndefined();
  });

  it('covers exactly the real noir commands that cannot run bare', () => {
    const commands = buildPaletteCommands(createProgram());
    const required = commands
      .filter((c) => c.needsArg !== undefined)
      .map((c) => `${c.id}=${c.needsArg}`)
      .sort();

    // Every leaf whose argument is declared `<...>` in the CLI. Selected commands
    // that fail without a value but declare it as optional in commander (e.g.
    // `run`, which also takes flag-only invocations) are out of reach here — the
    // curated quick actions declare those instead.
    expect(required).toEqual([
      'context search=query',
      'daemon join=name',
      'memory forget=ids',
      'memory recall=query',
      'task block=reason',
      'task decompose=capability',
    ]);

    // Pinned deliberately: the prompt stays an optional `[prompt...]` so
    // `noir run --list-profiles` keeps working without one, which is why the
    // palette learns about the prompt from the curated quick actions.
    expect(commands.find((c) => c.id === 'run')?.needsArg).toBeUndefined();
  });
});
