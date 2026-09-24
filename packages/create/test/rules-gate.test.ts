import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';
import { loadTemplate } from '../src/template-loader.js';

/**
 * `rules.enabled` in `.noir/config.yml` is the working-rules master switch.
 * Its consumer is the scaffold: with the switch off, the working-rules seed
 * (`.noir/rules/RULES.md`) is not emitted — and, on the one command that would
 * backfill it into an already-initialized project (`noir init --upgrade`),
 * not backfilled either.
 *
 * Off does NOT mean delete. A `RULES.md` built while the switch was on stays
 * exactly as it is: the file is the user's to rewrite, and a configuration
 * toggle is not a request to destroy writing they may have done in it.
 *
 * With the switch on (the default, and the only state a config without a
 * `rules:` block can be in) the seed is byte-identical to the shipped
 * template — the regression anchor for every existing project.
 */

/** `.noir/config.yml` with the working-rules switch off. */
const CONFIG_RULES_OFF = 'host: claude\nmode: full\nrules:\n  enabled: false\n';

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

describe('rules.enabled — the switch gates the working-rules seed', () => {
  it('is on when the config has no rules block: the seed is the shipped template', async () => {
    const dir = dirWithConfig('default');
    await scaffold({ root: dir, mode: 'init', transport: 'stdio', host: 'claude' });

    expect(existsSync(paths.rulesMd(dir))).toBe(true);
    expect(readFileSync(paths.rulesMd(dir), 'utf8')).toBe(loadTemplate('rules-seed.md.tmpl'));
  });

  it('is on when explicitly true: same bytes as the default', async () => {
    const explicit = dirWithConfig(
      'explicit-on',
      'host: claude\nmode: full\nrules:\n  enabled: true\n',
    );
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
});
