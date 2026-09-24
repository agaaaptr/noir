import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter, resolveAdapter, SUPPORTED_HOSTS } from '@noir-ai/adapters';
import { paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';

/**
 * The working-rules seed (`.noir/rules/RULES.md`) is a HOST-AGNOSTIC manifest
 * entry: every host writes the same bytes, and the host-specific pointer into
 * it is emitted by the host's own adapter block. That makes the seed's text a
 * promise to every host reader, so this file pins two things:
 *
 *  1. the seed never assumes a host — no Claude-only import syntax, no mention
 *     of the Claude host, and no path that belongs to the Noir repository
 *     itself (an initialized project's own layout is unknown to Noir);
 *  2. the seed still carries the core hygiene rules, briefly, inside the
 *     budget `noir doctor` measures against.
 *
 * The seed cannot import `checkHygiene` (`@noir-ai/create` does not depend on
 * `@noir-ai/skills`, and this task adds no runtime dependency), so the rules
 * themselves are asserted as content here.
 */

/** `noir doctor`'s default RULES.md budget: 6 KB / 150 lines — see
 *  `checkRulesMdBudget` in @noir-ai/cli. Asserted against the same
 *  measurement so a seed that passes here cannot trip the doctor. */
const BUDGET_BYTES = 6 * 1024;
const BUDGET_LINES = 150;

/** Text that only makes sense inside the Noir repository itself, or only for
 *  one host. A seed shipped to an arbitrary project must contain none of it. */
const FORBIDDEN_IN_SEED = [
  // Claude-only importer syntax / Claude host naming.
  '@import',
  'CLAUDE.md',
  'claude',
  // Paths out of the Noir repository's own layout. A user's project is not
  // this monorepo, so none of these exist for them.
  'docs/roadmap',
  'docs/specs',
  'docs/internal',
  'docs/decisions',
  'packages/',
];

/** The mechanical defect families the seed must name, so a reader knows what
 *  the gate reports before reaching for the full skill. */
const NAMED_DEFECTS = ['banner', 'narration', 'emoji'];

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-rules-seed-'));
  // Deterministic MCP command across machines (a native install's absolute
  // shim path would otherwise vary) — mirrors scaffold.test.ts.
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Initialize a throwaway project for `host` and return the seed bytes the
 *  scaffold wrote to `.noir/rules/RULES.md`. Reading the file the run actually
 *  produced is what makes "rendered for this host" a real assertion rather
 *  than a re-render of the template in the test. */
async function seedFor(host: (typeof SUPPORTED_HOSTS)[number], dir: string): Promise<string> {
  await scaffold({ root: dir, mode: 'init', transport: 'stdio', host });
  return readFileSync(paths.rulesMd(dir), 'utf8');
}

describe('rules seed — host-neutral text (every supported host)', () => {
  it('writes the same host-agnostic bytes for all five hosts', async () => {
    const seeds: string[] = [];
    for (const host of SUPPORTED_HOSTS) {
      const dir = join(root, host);
      seeds.push(await seedFor(host, dir));
    }
    // One seed body, five hosts: a per-host difference would mean the seed
    // gained a host token (the manifest entry is deliberately host-agnostic).
    expect(new Set(seeds).size).toBe(1);
  });

  it.each([...SUPPORTED_HOSTS])('is free of Claude-only syntax for host %s', async (host) => {
    const seed = await seedFor(host, join(root, host));
    expect(seed).not.toContain('@import');
    expect(seed).not.toContain('CLAUDE.md');
    expect(seed.toLowerCase()).not.toContain('claude');
  });

  it.each([...SUPPORTED_HOSTS])(
    'references no path from the Noir repository for host %s',
    async (host) => {
      const seed = await seedFor(host, join(root, host));
      for (const needle of FORBIDDEN_IN_SEED) {
        expect(seed, `seed must not contain "${needle}"`).not.toContain(needle);
      }
    },
  );

  it('keeps the headings the scaffold suite already relies on', async () => {
    const seed = await seedFor('claude', root);
    expect(seed).toContain('# Noir working rules');
    expect(seed).toContain('Anti-assumption contract');
  });
});

describe('rules seed — carries the core hygiene rules', () => {
  it.each([...SUPPORTED_HOSTS])('names the skill and the two tiers for host %s', async (host) => {
    const seed = await seedFor(host, join(root, host));
    expect(seed).toContain('noir-code-hygiene');
    expect(seed).toContain('noir doctor');
    // The tiers are what make a finding actionable: fail means remove it,
    // warn means look at it. Both have to be named for that to land.
    expect(seed).toContain('fail');
    expect(seed).toContain('warn');
  });

  it('names the mechanical defect families a reader will meet', async () => {
    const seed = await seedFor('claude', root);
    for (const defect of NAMED_DEFECTS) {
      expect(seed, `seed must name the "${defect}" defect`).toContain(defect);
    }
  });
});

describe('rules seed — stays inside the doctor budget', () => {
  it.each([...SUPPORTED_HOSTS])(
    'is within the 6 KB / 150-line budget for host %s',
    async (host) => {
      const seed = await seedFor(host, join(root, host));
      // Same measurement `checkRulesMdBudget` applies: UTF-8 byte length for the
      // KB cap, wc-style line count for the line ceiling.
      const bytes = Buffer.byteLength(seed, 'utf8');
      const lines = seed.length === 0 ? 0 : seed.split('\n').length - (seed.endsWith('\n') ? 1 : 0);
      expect(bytes).toBeLessThanOrEqual(BUDGET_BYTES);
      expect(lines).toBeLessThanOrEqual(BUDGET_LINES);
    },
  );
});

describe('rules seed — the importer pointer lives in the host adapter', () => {
  it('is emitted by the Claude adapter’s own rules block, not by the seed', () => {
    const block = claudeAdapter.emitRules?.({ root }) ?? '';
    expect(block).toContain('@import ".noir/rules/RULES.md"');
  });

  it.each([...SUPPORTED_HOSTS])(
    'points every host at the same seed without Claude syntax (%s)',
    (host) => {
      const adapter = resolveAdapter(host);
      const emitted = `${adapter.emitRules?.({ root }) ?? ''}${adapter.emitContext?.({ root }) ?? ''}`;
      // Every host reaches the same canonical file...
      expect(emitted).toContain('.noir/rules/RULES.md');
      // ...but the `@import "…"` keyword+quotes form is Claude's alone; gemini
      // and the AGENTS.md hosts use their own bare `@` spelling.
      if (host !== 'claude') {
        expect(emitted, `host ${host} must not emit Claude's @import syntax`).not.toContain(
          '@import',
        );
      }
    },
  );
});
