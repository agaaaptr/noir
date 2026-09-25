// `.noir/.env` must be owner-only (0600) after every command that can touch it,
// not only when it is created.
//
// The manifest seeds the file with `fileMode: 0o600` and `skipIfExists`, and
// that writer never opens an existing file — so the mode is applied at creation
// and never again. A `.noir/.env` seeded by an earlier Noir, or rewritten by an
// editor that saves by rename, therefore sits at 0644 for good and makes the
// environment diagnostic complain on every command. The scaffold now re-asserts
// the mode on every run, mirroring how the install shim re-asserts its
// executable bit, and records the outcome so the command can say what it did.
//
// This suite pins that contract: the mode is healed on init, on sync, on
// `create` and on `init --upgrade` / `init --force`; a file that is already
// owner-only is reported unchanged rather than healed; and a platform with no
// POSIX mode bits degrades to a no-op instead of throwing.
//
// Offline/free: no network, no API key, no embedder.
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';
import { CURRENT_SCAFFOLD_VERSION, writeScaffoldVersion } from '../src/scaffold-version.js';
import { ensureOwnerOnly } from '../src/writers.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-env-mode-'));
  // Pin the MCP command so this suite is deterministic across machines (a
  // native install's absolute shim path would otherwise land in `.mcp.json`).
  process.env.NOIR_MCP_COMMAND = 'noir';
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** POSIX-only assertions: Windows permissions are ACL-based and a mode there
 *  would assert something the platform cannot express. */
const posixIt = it.skipIf(process.platform === 'win32');

const envPath = (): string => join(root, '.noir', '.env');
const modeOf = (): number => statSync(envPath()).mode & 0o777;

/** Write `.noir/.env` at exactly `mode` — the state an older Noir, or an editor
 *  that saves by rename, leaves behind. */
function seedEnv(mode: number): void {
  mkdirSync(join(root, '.noir'), { recursive: true });
  const env = envPath();
  writeFileSync(env, '# seeded by an older Noir\n', 'utf8');
  chmodSync(env, mode);
}

/** `seedEnv` plus the identity a sync or an upgrade needs: a valid project id
 *  and a current scaffold stamp (current so the upgrade path re-emits the
 *  manifest instead of running the migration chain). */
function seedInitializedProject(mode: number): void {
  seedEnv(mode);
  writeFileSync(
    join(root, '.noir', 'project.id'),
    '9f1c0b7e-0000-4000-8000-000000000000\n',
    'utf8',
  );
  writeScaffoldVersion(root, CURRENT_SCAFFOLD_VERSION);
}

describe('.noir/.env owner-only mode is re-asserted on every path', () => {
  posixIt('heals a pre-existing 0644 file on init', async () => {
    seedEnv(0o644);

    const res = await scaffold({ root, mode: 'init', host: 'claude' });

    expect(modeOf()).toBe(0o600);
    expect(res.envMode).toBe('healed');
  });

  posixIt('heals a pre-existing 0644 file on a bare init of an initialized project', async () => {
    // The reported state: the project is already initialized, so plain `noir
    // init` re-emits nothing — it must still re-assert the mode, and say so.
    seedInitializedProject(0o644);

    const res = await scaffold({ root, mode: 'init', host: 'claude' });

    expect(res.noop).toBe(true);
    expect(modeOf()).toBe(0o600);
    expect(res.envMode).toBe('healed');
  });

  posixIt('heals a pre-existing 0644 file on sync', async () => {
    seedInitializedProject(0o644);

    const res = await scaffold({ root, mode: 'sync', host: 'claude' });

    expect(modeOf()).toBe(0o600);
    expect(res.envMode).toBe('healed');
  });

  posixIt('heals a pre-existing 0644 file on init --upgrade', async () => {
    seedInitializedProject(0o644);

    const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });

    expect(modeOf()).toBe(0o600);
    expect(res.envMode).toBe('healed');
  });

  posixIt('heals a pre-existing 0644 file on init --force', async () => {
    seedInitializedProject(0o644);

    const res = await scaffold({ root, mode: 'init', host: 'claude', force: true });

    expect(modeOf()).toBe(0o600);
    expect(res.envMode).toBe('healed');
  });

  posixIt('heals a pre-existing 0644 file on create --force', async () => {
    // `create` over an EXISTING tree is the case the old gate missed: its
    // rationale ("the seed is written 0600 in the same run") only holds for a
    // fresh tree, so a forced re-scaffold left the pre-existing file at 0644.
    seedInitializedProject(0o644);

    const res = await scaffold({ root, mode: 'create', host: 'claude', force: true });

    expect(res.noop).toBe(false);
    expect(modeOf()).toBe(0o600);
    expect(res.envMode).toBe('healed');
  });

  it('reports unchanged, not healed, for a fresh create — the writer already made it 0600', async () => {
    // Including `create` in the heal must not change what a fresh tree looks
    // like: the seed writer creates the file 0600, so the heal finds nothing to
    // do and says so rather than claiming a fix it did not make.
    const res = await scaffold({ root, mode: 'create', host: 'claude' });

    expect(modeOf()).toBe(0o600);
    expect(res.envMode).toBe('unchanged');
  });

  posixIt('reports an already-0600 file as unchanged, not healed', async () => {
    seedInitializedProject(0o600);

    const res = await scaffold({ root, mode: 'sync', host: 'claude' });

    // "unchanged" is the classification the helper returns without touching the
    // file; it must be distinguishable from "healed", which means a chmod ran.
    expect(res.envMode).toBe('unchanged');
    expect(modeOf()).toBe(0o600);
  });

  posixIt('heals a 0640 file too — group access is still other-reader access', async () => {
    seedInitializedProject(0o640);

    const res = await scaffold({ root, mode: 'sync', host: 'claude' });

    expect(modeOf()).toBe(0o600);
    expect(res.envMode).toBe('healed');
  });

  it('keeps the 0600 creation mode of a fresh project', async () => {
    // The re-assert must not replace the writer's creation contract: a file the
    // run itself creates is 0600 from the moment it exists.
    await scaffold({ root, mode: 'init', host: 'claude' });
    expect(modeOf()).toBe(0o600);
  });
});

describe('ensureOwnerOnly', () => {
  posixIt('returns unchanged for an already-owner-only file, without chmodding it', () => {
    seedEnv(0o600);

    expect(ensureOwnerOnly(envPath())).toBe('unchanged');
    expect(modeOf()).toBe(0o600);
  });

  posixIt('returns healed for a group-readable file and tightens it to 0600', () => {
    seedEnv(0o640);

    expect(ensureOwnerOnly(envPath())).toBe('healed');
    expect(modeOf()).toBe(0o600);
  });

  posixIt('returns unchanged for a file that is not there — nothing to heal', () => {
    expect(ensureOwnerOnly(envPath())).toBe('unchanged');
  });

  it('returns unsupported, and never throws, where the platform has no POSIX bits', () => {
    // Faked: a POSIX CI runner always has mode bits, so the platform is the
    // only way to reach this branch. Windows permissions are ACL-based, and the
    // helper must degrade to a no-op rather than assert a mode that means
    // nothing there.
    seedEnv(0o644);
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      expect(ensureOwnerOnly(envPath())).toBe('unsupported');
      expect(ensureOwnerOnly(envPath())).toBe('unsupported'); // still no throw
    } finally {
      Object.defineProperty(process, 'platform', { value: real });
    }
    expect(modeOf()).toBe(0o644); // degraded to a no-op — the mode is untouched
  });
});
