// Task 10 / spec §11.1 — `noir init --upgrade` emits EVERY manifest mode.
//
// The §1.6 regression, exactly as observed on the maintainer's machine:
// `.noir/.env.example` is `skipIfExists` (`manifest.ts`), so a FRESH `noir init`
// creates it — but `--upgrade` filtered the manifest down to the runtime subset
// (`regenerate` + `managedBlock`) and skipped `skipIfExists` entirely. A seed
// added to the manifest after a project was initialized was therefore never
// created, by any command.
//
// Running `skipIfExists` on upgrade is safe by construction: the writer creates
// the file ONLY when it is absent and never opens an existing one, so a user's
// own file (and its mode) is untouchable. That invariant is what this suite
// pins alongside the backfill itself.
//
// The widening is NARROW. `mergeJson` (`.claude/settings.local.json`) stays
// init/create-only: it re-appends the SessionStart hook whenever the dedup
// substring is gone, so re-emitting it on an upgrade would resurrect a hook the
// user deliberately removed — the same "never surprise the user" invariant, from
// the other side. Both halves are pinned below.
//
// Offline/free: no network, no API key, no embedder.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CURRENT_SCAFFOLD_VERSION,
  readScaffoldVersion,
  scaffold,
  writeScaffoldVersion,
} from '../src/index.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-upgrade-backfill-'));
  // Pin the MCP command so this suite is deterministic across machines (a
  // native install's absolute shim path would otherwise bleed into .mcp.json).
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 0600 is a POSIX permission; Windows drops it (ACL-based), so mode
 *  assertions are skipped there rather than asserting what the platform
 *  cannot express. */
const posixIt = it.skipIf(process.platform === 'win32');

const envPath = (): string => join(root, '.noir', '.env');
const examplePath = (): string => join(root, '.noir', '.env.example');

const sha256 = (abs: string): string =>
  createHash('sha256').update(readFileSync(abs)).digest('hex');

/** The maintainer's real shape (§1.6): a project stamped at the OLD scaffold
 *  version with `.noir/.env` already present and `.noir/.env.example` absent —
 *  i.e. a seed the user owns next to a seed the manifest gained later. */
function seedLegacyProject(envBody: string): void {
  writeScaffoldVersion(root, '1.0.0');
  writeFileSync(envPath(), envBody, 'utf8');
}

describe('noir init --upgrade — skipIfExists backfill (spec §11.1, closes §1.6)', () => {
  it('backfills a skipIfExists seed added after initialization', async () => {
    seedLegacyProject('CLICKUP_API_TOKEN=pk_keepme\n');
    const before = sha256(envPath());

    const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });

    // The seed the manifest gained AFTER this project was initialized now exists.
    expect(existsSync(examplePath())).toBe(true);
    expect(res.written).toContain('.noir/.env.example');
    // …and the user's own seed was not merely preserved, it was never opened:
    // its bytes are identical, file hash before === after.
    expect(res.written).not.toContain('.noir/.env');
    expect(res.skipped).toContain('.noir/.env');
    expect(sha256(envPath())).toBe(before);
    expect(readFileSync(envPath(), 'utf8')).toBe('CLICKUP_API_TOKEN=pk_keepme\n');
    // The upgrade stamps the CURRENT version, so doctor stops reporting drift.
    // Asserted against the imported constant (not a literal) so this test is
    // true both before and after the 1.1.0 bump.
    expect(readScaffoldVersion(root)).toBe(CURRENT_SCAFFOLD_VERSION);
  });

  it('never modifies an already-present skipIfExists seed', async () => {
    seedLegacyProject('# user-edited\nCLICKUP_API_TOKEN=pk_keepme\n');
    // The example seed is ALSO already present, hand-edited by the user.
    const exampleBefore = '# my own notes — not the generated body\n';
    writeFileSync(examplePath(), exampleBefore, 'utf8');

    const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });

    expect(res.written).not.toContain('.noir/.env.example');
    expect(res.skipped).toContain('.noir/.env.example');
    expect(readFileSync(examplePath(), 'utf8')).toBe(exampleBefore);
  });

  it('dry-run reports the backfill as a planned write and touches nothing', async () => {
    seedLegacyProject('CLICKUP_API_TOKEN=pk_keepme\n');
    const before = sha256(envPath());

    const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true, dryRun: true });

    expect(res.written).toContain('.noir/.env.example'); // planned
    expect(existsSync(examplePath())).toBe(false); // …but not written
    // An already-present skipIfExists file is reported as skipped, never as a
    // planned write — nothing to backfill there.
    expect(res.written).not.toContain('.noir/.env');
    expect(res.skipped).toContain('.noir/.env');
    expect(sha256(envPath())).toBe(before);
  });

  posixIt('applies the entry-declared mode to a BACKFILLED .noir/.env', async () => {
    // The fileMode contract reaches the upgrade path too: a `.noir/.env` the
    // upgrade creates is 0600 from the moment it exists (the manifest declares
    // it), while an existing one keeps the user's own mode.
    writeScaffoldVersion(root, '1.0.0');
    const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });
    expect(res.written).toContain('.noir/.env');
    expect(statSync(envPath()).mode & 0o777).toBe(0o600);
  });
});

describe('noir init --upgrade — mergeJson stays init/create-only', () => {
  const settingsRel = '.claude/settings.local.json';
  const settingsPath = (): string => join(root, '.claude', 'settings.local.json');
  /** The user's own settings WITHOUT a SessionStart hook entry — i.e. a hook
   *  the user deliberately removed after init wrote it. */
  const hookless = (): string =>
    JSON.stringify({ permissions: { allow: ['Bash(git *)'] } }, null, 2);

  function seedHooklessSettings(body: string): void {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(settingsPath(), body, 'utf8');
  }

  it('--upgrade does not resurrect a hook the user removed', async () => {
    writeScaffoldVersion(root, '1.0.0');
    seedHooklessSettings(hookless());
    const before = sha256(settingsPath());

    const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });

    // Byte-identical: the mergeJson entry was filtered out, not no-op'd — it is
    // reported in NEITHER list (an absent entry, not a skipped one).
    expect(sha256(settingsPath())).toBe(before);
    expect(res.written).not.toContain(settingsRel);
    expect(res.skipped).not.toContain(settingsRel);
    // The exclusion is narrowly `mergeJson`: the seed backfill this upgrade
    // exists for still happens in the same run.
    expect(res.written).toContain('.noir/.env.example');
  });

  it('a fresh init still writes the hook entry (init/create-only, not never)', async () => {
    seedHooklessSettings(hookless());

    const res = await scaffold({ root, mode: 'init', host: 'claude' });

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(settings.hooks.SessionStart[0]?.hooks?.[0]?.command).toContain('noir-session-start');
    expect(settings.permissions).toEqual({ allow: ['Bash(git *)'] }); // user content preserved
    expect(res.written).toContain(settingsRel);
  });
});
