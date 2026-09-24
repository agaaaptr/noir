import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostId } from '@noir-ai/adapters';
import { paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';
import { SEED_TEMPLATE_HISTORY } from '../src/template-history.js';
import { loadTemplate } from '../src/template-loader.js';

/**
 * `rules.enabled` in `.noir/config.yml` is the working-rules master switch.
 * With it off, the whole working-rules surface of a project is withheld:
 *
 *  - the seed (`.noir/rules/RULES.md`) is not emitted, and the one command that
 *    would backfill it into an already-initialized project
 *    (`noir init --upgrade`) does not backfill it;
 *  - no host artifact points at it — CLAUDE.md / GEMINI.md / AGENTS.md carry no
 *    rules `@`-import, and the `.noir/README.md` store map does not list a file
 *    that no command writes;
 *  - the upgrade's doc-seed refresh leaves an older copy of it alone, even when
 *    its bytes are an exact match for a seed Noir shipped at an earlier
 *    scaffold version (the one state in which the refresh would otherwise fire
 *    without the user's consent).
 *
 * Off does NOT mean delete. A `RULES.md` built while the switch was on stays
 * exactly as it is: the file is the user's to rewrite, and a configuration
 * toggle is not a request to destroy writing they may have done in it. The
 * same applies to a rules import already written into a host file — Noir stops
 * emitting it, it does not reach in and cut it out.
 *
 * With the switch on (the default, and the only state a config without a
 * `rules:` block can be in) every one of these artifacts is byte-identical to
 * the shipped template — the regression anchor for every existing project.
 */

/** `.noir/config.yml` with the working-rules switch off. */
const CONFIG_RULES_OFF = 'host: claude\nmode: full\nrules:\n  enabled: false\n';

/** `.noir/config.yml` with the switch spelled out as on. */
const CONFIG_RULES_ON = 'host: claude\nmode: full\nrules:\n  enabled: true\n';

/** The host file that carries each host's rules import. */
const HOST_CONTEXT_FILE: Record<HostId, string> = {
  claude: 'CLAUDE.md',
  gemini: 'GEMINI.md',
  'agents-md': 'AGENTS.md',
  cursor: 'AGENTS.md',
  opencode: 'AGENTS.md',
};

const ALL_HOSTS: readonly HostId[] = ['claude', 'gemini', 'agents-md', 'cursor', 'opencode'];

/** `.noir/rules/RULES.md` as scaffold version 1.1.0 shipped it — the bytes an
 *  old project really has on disk, and the fixture the doc-seed refresh keys
 *  on. Read from the append-only history rather than re-typed here, so this
 *  test breaks if that ledger is ever rewritten. */
const RECORDED_RULES_SEED = (() => {
  const entry = SEED_TEMPLATE_HISTORY.find((e) => e.scaffoldVersion === '1.1.0');
  if (entry === undefined) throw new Error('no 1.1.0 seed-template history entry');
  return entry.rulesSeed;
})();

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-rules-gate-'));
  // Deterministic MCP command across machines (a native install's absolute
  // shim path would otherwise vary) — mirrors scaffold.test.ts.
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fresh project dir with `.noir/config.yml` pre-seeded (init's own config
 *  write is `skipIfExists`, so the pre-seeded switch is what the run reads). */
function dirWithConfig(name: string, config?: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, '.noir'), { recursive: true });
  if (config !== undefined) writeFileSync(paths.config(dir), config, 'utf8');
  return dir;
}

/** A project stamped at scaffold 1.1.0 whose RULES.md holds the exact bytes
 *  that version shipped. This is the state the 1.1.0 → 1.2.0 doc-seed refresh
 *  exists to bring forward — the upgrade can tell it apart from a user edit
 *  only by that byte-for-byte match. */
function dirFromOneOneZero(name: string, config?: string): string {
  const dir = dirWithConfig(name, config);
  mkdirSync(join(dir, '.noir', 'rules'), { recursive: true });
  writeFileSync(join(dir, '.noir', 'rules', 'RULES.md'), RECORDED_RULES_SEED, 'utf8');
  writeFileSync(join(dir, '.noir', 'scaffold-version'), 'noir-scaffold=1.1.0\n', 'utf8');
  return dir;
}

describe('rules.enabled — the switch gates the working-rules seed', () => {
  it('is on when the config has no rules block: the seed is the shipped template', async () => {
    const dir = dirWithConfig('default');
    await scaffold({ root: dir, mode: 'init', transport: 'stdio', host: 'claude' });

    expect(existsSync(paths.rulesMd(dir))).toBe(true);
    expect(readFileSync(paths.rulesMd(dir), 'utf8')).toBe(loadTemplate('rules-seed.md.tmpl'));
  });

  it('is on when explicitly true: same bytes as the default', async () => {
    const explicit = dirWithConfig('explicit-on', CONFIG_RULES_ON);
    await scaffold({ root: explicit, mode: 'init', transport: 'stdio', host: 'claude' });

    expect(readFileSync(paths.rulesMd(explicit), 'utf8')).toBe(loadTemplate('rules-seed.md.tmpl'));
  });

  it('off: no RULES.md is emitted, and the rest of the scaffold is untouched', async () => {
    const dir = dirWithConfig('off', CONFIG_RULES_OFF);
    await scaffold({ root: dir, mode: 'init', transport: 'stdio', host: 'claude' });

    expect(existsSync(paths.rulesMd(dir))).toBe(false);
    // The run did not merely fail: the canonical store seeds are all there.
    expect(existsSync(paths.projectId(dir))).toBe(true);
    expect(existsSync(paths.config(dir))).toBe(true);
    expect(existsSync(paths.noirMd(dir))).toBe(true);
  });

  it('off: an upgrade does not backfill the seed', async () => {
    const dir = dirWithConfig('off-upgrade', CONFIG_RULES_OFF);
    await scaffold({ root: dir, mode: 'init', transport: 'stdio', host: 'claude' });
    await scaffold({ root: dir, mode: 'init', transport: 'stdio', host: 'claude', upgrade: true });

    expect(existsSync(paths.rulesMd(dir))).toBe(false);
  });

  it('off: a RULES.md written while the switch was on is left alone', async () => {
    const dir = dirWithConfig('off-existing');
    await scaffold({ root: dir, mode: 'init', transport: 'stdio', host: 'claude' });
    const written = readFileSync(paths.rulesMd(dir), 'utf8');

    // The user turns the switch off, then re-runs the seed-emitting commands.
    writeFileSync(paths.config(dir), CONFIG_RULES_OFF, 'utf8');
    const upgrade = await scaffold({
      root: dir,
      mode: 'init',
      transport: 'stdio',
      host: 'claude',
      upgrade: true,
    });
    const sync = await scaffold({ root: dir, mode: 'sync', transport: 'stdio', host: 'claude' });

    expect(readFileSync(paths.rulesMd(dir), 'utf8')).toBe(written);
    expect(upgrade.written).not.toContain('.noir/rules/RULES.md');
    expect(upgrade.refreshed).not.toContain('.noir/rules/RULES.md');
    expect(sync.written).not.toContain('.noir/rules/RULES.md');
  });

  it('off: an upgrade leaves an OLDER recorded seed byte-unchanged', async () => {
    // The harder half of the contract above. The file holds bytes Noir itself
    // shipped at scaffold 1.1.0, which is exactly what the upgrade's doc-seed
    // refresh treats as evidence that nobody ever edited it. A switch-off
    // project must not have its rules text silently rewritten on that basis:
    // the whole point of the switch is that this project has no working rules
    // for Noir to maintain.
    const dir = dirFromOneOneZero('off-old-seed', CONFIG_RULES_OFF);
    const upgrade = await scaffold({
      root: dir,
      mode: 'init',
      transport: 'stdio',
      host: 'claude',
      upgrade: true,
    });

    expect(readFileSync(paths.rulesMd(dir), 'utf8')).toBe(RECORDED_RULES_SEED);
    expect(upgrade.migrationChanged).not.toContain('.noir/rules/RULES.md');
    expect(upgrade.refreshed).not.toContain('.noir/rules/RULES.md');
    expect(upgrade.written).not.toContain('.noir/rules/RULES.md');
  });

  it('on: the same 1.1.0 fixture HAS its seed brought forward', async () => {
    // The control for the test above. Identical fixture, switch on: the seed is
    // a never-edited leftover of a version Noir shipped, so the upgrade replaces
    // it with the current text. If this stops refreshing, the switch-off test
    // above stops proving anything.
    const dir = dirFromOneOneZero('on-old-seed', CONFIG_RULES_ON);
    const upgrade = await scaffold({
      root: dir,
      mode: 'init',
      transport: 'stdio',
      host: 'claude',
      upgrade: true,
    });

    expect(readFileSync(paths.rulesMd(dir), 'utf8')).toBe(loadTemplate('rules-seed.md.tmpl'));
    expect(upgrade.migrationChanged).toContain('.noir/rules/RULES.md');
  });
});

describe('rules.enabled — the switch also gates where rules are LOADED from', () => {
  it('off: no host artifact and no store map points at RULES.md', async () => {
    for (const host of ALL_HOSTS) {
      const dir = dirWithConfig(`off-load-${host}`, CONFIG_RULES_OFF);
      await scaffold({ root: dir, mode: 'init', transport: 'stdio', host });

      // The host file that carries this host's imports, plus the store map every
      // host gets. Both are read by the host or the user, and both would be
      // pointing at a file that does not exist.
      for (const rel of [HOST_CONTEXT_FILE[host], '.noir/README.md']) {
        const abs = join(dir, rel);
        expect(existsSync(abs), `${host}: ${rel} was not emitted at all`).toBe(true);
        expect(readFileSync(abs, 'utf8'), `${host}: ${rel} still points at RULES.md`).not.toMatch(
          /RULES\.md/,
        );
      }

      // The file that IS part of the project is still imported — the gating
      // removed the rules pointer, not the whole context import.
      expect(readFileSync(join(dir, HOST_CONTEXT_FILE[host]), 'utf8')).toMatch(/NOIR\.md/);
    }
  });

  it('on: the emitted artifacts are byte-identical to a project with no rules block', async () => {
    // Two project dirs share a basename so the project-name-derived AGENTS.md
    // heading is comparable; the only difference between them is the switch.
    for (const host of ALL_HOSTS) {
      const implicit = join('implicit', host);
      const explicit = join('explicit', host);
      const a = dirWithConfig(implicit);
      const b = dirWithConfig(explicit, CONFIG_RULES_ON);
      await scaffold({ root: a, mode: 'init', transport: 'stdio', host });
      await scaffold({ root: b, mode: 'init', transport: 'stdio', host });

      for (const rel of [HOST_CONTEXT_FILE[host], '.noir/README.md']) {
        expect(
          readFileSync(join(b, rel), 'utf8'),
          `${host}: ${rel} differs when the switch is spelled out`,
        ).toBe(readFileSync(join(a, rel), 'utf8'));
      }
    }
  });
});
