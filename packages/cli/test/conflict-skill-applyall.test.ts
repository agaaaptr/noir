// Regression — the @clack conflict resolver must OFFER "apply to all" for the
// `skill` mode (skills emit via `emitSkillsToDir` with mode='skill'), not just
// `regenerate`. Before the fix the gate was `mode === 'regenerate'`, so a
// `noir init --upgrade` / `noir sync` re-emitting many divergent skills
// prompted per-file with NO "apply to all" escape hatch.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const selectMock = vi.fn();
const isCancelMock = vi.fn();

vi.mock('@clack/prompts', () => ({
  select: selectMock,
  isCancel: isCancelMock,
}));

import { buildConflictOpts } from '../src/conflict.js';

function resolver() {
  const opts = buildConflictOpts({ interactive: true });
  if (opts.onConflict === undefined) throw new Error('expected an interactive resolver');
  return opts.onConflict;
}

beforeEach(() => {
  selectMock.mockClear();
  isCancelMock.mockClear();
});

describe('clack conflict resolver — apply-to-all for skill mode', () => {
  it('returns applyToAll=true when the user picks Yes for mode=skill', async () => {
    selectMock.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith('Apply ')) return 'yes';
      return 'replace';
    });
    isCancelMock.mockReturnValue(false);

    const ret = await resolver()({
      relPath: '.claude/skills/noir-spec/SKILL.md',
      existing: 'old',
      proposed: 'new',
      mode: 'skill',
    });

    expect(ret).toEqual({ resolution: 'replace', applyToAll: true });
    // Two prompts: the resolution, then the apply-to-all confirmation.
    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it('returns a bare resolution for mode=skill when the user picks No', async () => {
    selectMock.mockImplementation(async (opts: { message: string }) => {
      if (opts.message.startsWith('Apply ')) return 'no';
      return 'preserve';
    });
    isCancelMock.mockReturnValue(false);

    const ret = await resolver()({
      relPath: '.claude/skills/noir-spec/SKILL.md',
      existing: 'old',
      proposed: 'new',
      mode: 'skill',
    });

    expect(ret).toBe('preserve');
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});
