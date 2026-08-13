import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBuiltin } from '../src/discover.js';
import { artifactPathDrift } from '../src/quality.js';

let fixture: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'noir-drift-'));
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

/** Write a single valid-frontmatter skill whose body carries the given prose,
 *  discover it, and return it for the drift check. */
async function skillWith(body: string) {
  const dir = join(fixture, 'noir-drift');
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---
name: noir-drift
description: Use when drafting a spec — write the artifact.
metadata:
  category: spec
  version: 1.0.0
license: MIT
compatibility: claude
---
${body}`,
    'utf8',
  );
  const found = discoverBuiltin(fixture);
  const skill = found[0];
  if (!skill) throw new Error('no skill discovered');
  return skill;
}

describe('artifactPathDrift (C3 generated-artifact standard)', () => {
  it('flags an unknown .noir/ directory', async () => {
    const skill = await skillWith('Write to `.noir/sdd/task-N-brief.md`.');
    expect(artifactPathDrift(skill)).toContain(
      '.noir/sdd/ is not a canonical artifact directory (C3 artifact standard)',
    );
  });

  it('flags an old-style filename in a canonical directory', async () => {
    const skill = await skillWith('Write to `.noir/plans/<date>-<slug>.md`.');
    expect(artifactPathDrift(skill).some((d) => d.includes('PL-'))).toBe(true);
  });

  it('accepts a correct type-code filename', async () => {
    const skill = await skillWith('Write to `.noir/plans/PL-<NNNN>-<taskId>-<slug>.md`.');
    expect(artifactPathDrift(skill)).toEqual([]);
  });

  it('accepts both codes of a shared directory (subagents: BR + RP)', async () => {
    const skill = await skillWith(
      'Write to `.noir/subagents/BR-<NNNN>-<slug>.md` and `.noir/subagents/RP-<NNNN>-<slug>.md`.',
    );
    expect(artifactPathDrift(skill)).toEqual([]);
  });

  it('ignores non-artifact .noir/ directories (rules)', async () => {
    const skill = await skillWith('Edit the rules at `.noir/rules/RULES.md`.');
    expect(artifactPathDrift(skill)).toEqual([]);
  });
});
