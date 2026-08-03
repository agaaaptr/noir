# C1 Native Installer + Migration + Self-Update — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the managed-Node native installer, `noir install`/`migrate` (settings-preserving), `noir update` + cached async version check, `install.ps1` + Scoop + real Homebrew formula, and the trust/release pipeline — all commits local on `develop`.

**Architecture:** The native path is a **managed-Node runtime** — a pinned Node LTS in `~/.noir/runtime/<v>`, `@noir-ai/cli` installed into an isolated npm prefix `~/.noir/cli`, and a shim `~/.noir/bin/noir` as the only PATH contract. `~/.noir/install.json` is the single source of truth for install method; `~/.noir/update-cache.json` for version-check caching. The CLI gains `install`/`migrate`/`update` commands + a doctor `install` row; the release pipeline gains pinned installers + `SHA256SUMS` + attestations + a Windows CI matrix + install smoke test.

**Tech Stack:** Node ≥ 22, TypeScript, commander (CLI tree), Zod (config), pnpm, vitest (tests), bash + PowerShell (installers), GitHub Actions (CI/release).

## Global Constraints

- **Commits stay LOCAL on `develop`.** No push. Publish is a separate later phase.
- Full gate before "done": `pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm docs:validate`.
- Test suite is offline/free — no network calls, no paid keys. Mock all subprocess/network.
- Single source of truth: `~/.noir/install.json` (install method) + `~/.noir/update-cache.json` (version check). Re-derive from filesystem truth; never trust stale config.
- Data dir (`~/.noir/` + project `.noir/`) is NEVER touched by install/update/migrate. Migrate the bin, leave data alone.
- Never auto-uninstall a prior manager. Offer `--uninstall-prev` explicitly; rollback = reinstall from the previous manager.
- Version-assert: never downgrade (unless explicitly pinned, with warning).
- Atomic writes: all binary/shim writes → temp → atomic rename. Never in-place overwrite.
- Doctor severity: install row is `ok`/`warn` only, never `fail`. Doctor never makes a live network call (reads the cache).
- `update.minVersion` floor; env kill-switches `NOIR_DISABLE_UPDATE_CHECK` and `NOIR_DISABLE_UPDATES`.
- Use the existing additive config-block pattern (`.default({})`, e.g. `daemon:`/`rules:`/`prd:`).
- Follow the existing CLI patterns: commander `.command()`, lazy `await import('./commands/x.js')`, S9 `EXIT` codes + output helpers, `{ok,data}` JSON envelope.
- CLI test dir: `packages/cli/test/*.test.ts`; isolate `~/.noir/` via env overrides (like `NOIR_DAEMON_JSON`).
- Offline-safe installer smoke tests run in CI only (real install), never in the unit suite.

---

### Task 1: `~/.noir/install.json` + atomic-write helper (core)

**Files:**
- Create: `packages/core/src/install-method.ts`
- Modify: `packages/core/src/index.ts` (export new module)
- Modify: `packages/daemon/src/lifecycle.ts` (`writeDaemonRecord` → atomic)
- Test: `packages/core/test/install-method.test.ts`

**Interfaces:**
- Consumes: `NOIR_DAEMON_JSON` env override pattern from `packages/daemon/src/lifecycle.ts`; `noirHome()` from `packages/core/src/layout.ts`.
- Produces:
  - `type InstallMethod = 'native' | 'npm' | 'pnpm' | 'yarn' | 'bun' | 'homebrew' | 'scoop' | 'unknown'`
  - `interface InstallRecord { method: InstallMethod; version: string; channel: string; installedAt: string; managedRuntimeVersion?: string }`
  - `installJsonPath(): string` — `NOIR_INSTALL_JSON` override ?? `join(noirHome(), 'install.json')`
  - `readInstallRecord(): InstallRecord | null`
  - `writeInstallRecord(rec: InstallRecord): void` (atomic: temp → rename)
  - `clearInstallRecord(): void`
  - `atomicWriteFile(path: string, data: string): void` — exported shared helper (temp in same dir → rename)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/install-method.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atomicWriteFile,
  clearInstallRecord,
  installJsonPath,
  readInstallRecord,
  writeInstallRecord,
} from '../src/install-method.js';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-install-method-'));
  prev = process.env.NOIR_INSTALL_JSON;
  process.env.NOIR_INSTALL_JSON = join(dir, 'install.json');
});

afterEach(() => {
  if (prev === undefined) delete process.env.NOIR_INSTALL_JSON;
  else process.env.NOIR_INSTALL_JSON = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('install record', () => {
  it('read/write round-trips and clear removes', () => {
    expect(readInstallRecord()).toBeNull();
    writeInstallRecord({ method: 'native', version: '1.6.0', channel: 'latest', installedAt: '2026-08-03T00:00:00.000Z' });
    const rec = readInstallRecord();
    expect(rec).not.toBeNull();
    expect(rec!.method).toBe('native');
    expect(rec!.version).toBe('1.6.0');
    clearInstallRecord();
    expect(readInstallRecord()).toBeNull();
  });

  it('ignores a malformed or missing file', () => {
    writeFileSync(installJsonPath(), '{not json', 'utf8');
    expect(readInstallRecord()).toBeNull();
  });
});

describe('atomicWriteFile', () => {
  it('writes via temp-then-rename (no temp file left behind)', () => {
    const target = join(dir, 'out.txt');
    atomicWriteFile(target, 'hello');
    expect(readFileSync(target, 'utf8')).toBe('hello');
    // After rename there should be no `out.txt.tmp-*` leftover.
    const leftovers = require('node:fs').readdirSync(dir).filter((f) => f !== 'install.json');
    expect(leftovers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/install-method.test.ts`
Expected: FAIL — `Cannot find module '../src/install-method.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/install-method.ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { noirHome } from './layout.js';

export type InstallMethod =
  | 'native' | 'npm' | 'pnpm' | 'yarn' | 'bun' | 'homebrew' | 'scoop' | 'unknown';

export interface InstallRecord {
  method: InstallMethod;
  version: string;
  channel: string;
  installedAt: string;
  managedRuntimeVersion?: string;
}

export function installJsonPath(): string {
  return process.env.NOIR_INSTALL_JSON ?? join(noirHome(), 'install.json');
}

/** Write a file atomically: write to a temp sibling, fsync, then rename. Never
 *  in-place overwrite (macOS code-sign inode-taint → SIGKILL; Windows locks). */
export function atomicWriteFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

export function writeInstallRecord(rec: InstallRecord): void {
  atomicWriteFile(installJsonPath(), `${JSON.stringify(rec, null, 2)}\n`);
}

export function readInstallRecord(): InstallRecord | null {
  try {
    const raw = readFileSync(installJsonPath(), 'utf8');
    const rec = JSON.parse(raw) as InstallRecord;
    if (typeof rec.method === 'string' && typeof rec.version === 'string') return rec;
    return null;
  } catch {
    return null;
  }
}

export function clearInstallRecord(): void {
  const p = installJsonPath();
  if (existsSync(p)) rmSync(p, { force: true });
}
```

```ts
// packages/core/src/index.ts — add to the existing export block
export {
  type InstallMethod,
  type InstallRecord,
  installJsonPath,
  readInstallRecord,
  writeInstallRecord,
  clearInstallRecord,
  atomicWriteFile,
} from './install-method.js';
```

- [ ] **Step 4: Make `writeDaemonRecord` atomic**

In `packages/daemon/src/lifecycle.ts`, replace the direct write with the shared helper:

```ts
import { atomicWriteFile, noirHome } from '@noir-ai/core';
// ...
export function writeDaemonRecord(rec: DaemonRecord): void {
  mkdirSync(noirHome(), { recursive: true });
  atomicWriteFile(daemonJsonPath(), `${JSON.stringify(rec)}\n`);
}
```

> Check `@noir-ai/daemon` already depends on `@noir-ai/core` (it does — `noirHome` is re-exported there). Remove the now-unused `writeFileSync` import if biome flags it.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/core/test/install-method.test.ts packages/daemon/test`
Expected: PASS (new + existing daemon lifecycle tests still green).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/install-method.ts packages/core/src/index.ts packages/daemon/src/lifecycle.ts packages/core/test/install-method.test.ts
git commit -m "feat(core): ~/.noir/install.json + atomic-write helper"
```

---

### Task 2: `update:` config block (core)

**Files:**
- Modify: `packages/core/src/config.ts` (add `update:` block after `prd:`/`integrations:`)
- Test: `packages/core/test/config.test.ts`

**Interfaces:**
- Consumes: the additive block pattern (`daemon:`/`rules:`/`prd:`).
- Produces: `NoirConfig.update` with shape:
  ```ts
  {
    checkEnabled: boolean;   // default true
    checkIntervalHours: number; // default 24
    channel: 'latest' | 'beta'; // default 'latest'
    minVersion: string;      // default '1.6.0'
    display: 'notice' | 'silent'; // default 'notice'
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/config.test.ts — add
import { parseConfig } from '../src/config.js';
// ...
it('parses update: block with defaults', () => {
  const cfg = parseConfig({});
  expect(cfg.update).toEqual({
    checkEnabled: true,
    checkIntervalHours: 24,
    channel: 'latest',
    minVersion: '1.6.0',
    display: 'notice',
  });
});

it('update: block overrides honored', () => {
  const cfg = parseConfig({
    update: { checkEnabled: false, channel: 'beta', checkIntervalHours: 6, minVersion: '1.5.0', display: 'silent' },
  });
  expect(cfg.update.channel).toBe('beta');
  expect(cfg.update.checkEnabled).toBe(false);
  expect(cfg.update.checkIntervalHours).toBe(6);
  expect(cfg.update.display).toBe('silent');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/test/config.test.ts`
Expected: FAIL — `cfg.update` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/core/src/config.ts`, add after the `integrations:` block:

```ts
  // C1 — `update:` block. Additive, no-op when absent (defaults make it a
  // pass-through). Configures the async startup version check + self-update
  // surface (`noir update`). Mirrors the `daemon:`/`rules:`/`prd:` idiom: an
  // absent `update:` block resolves to enabled/24h/latest/notice — the safe
  // defaults. `minVersion` is a floor: update never installs below it. The
  // env kill-switches NOIR_DISABLE_UPDATE_CHECK / NOIR_DISABLE_UPDATES are
  // honored OUTSIDE config (process-level), so enterprise users can disable
  // without a project file.
  update: z
    .object({
      checkEnabled: z.boolean().default(true),
      checkIntervalHours: z.number().int().positive().default(24),
      channel: z.enum(['latest', 'beta']).default('latest'),
      minVersion: z.string().default('1.6.0'),
      display: z.enum(['notice', 'silent']).default('notice'),
    })
    .default({ checkEnabled: true, checkIntervalHours: 24, channel: 'latest', minVersion: '1.6.0', display: 'notice' }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/test/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/test/config.test.ts
git commit -m "feat(core): update: config block"
```

---

### Task 3: Update-check module (cached, async, offline-safe) + `update-cache.json`

**Files:**
- Create: `packages/core/src/update-check.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/update-check.test.ts`

**Interfaces:**
- Consumes: `atomicWriteFile` (Task 1), `readInstallRecord` (Task 1), `noirHome`.
- Produces:
  - `interface UpdateCache { lastCheckAt: string | null; latestVersion: string | null; channel: string | null }`
  - `updateCachePath(): string` — `NOIR_UPDATE_CACHE_JSON` ?? `join(noirHome(), 'update-cache.json')`
  - `readUpdateCache(): UpdateCache`
  - `writeUpdateCache(cache: UpdateCache): void`
  - `isUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean` — true when `NOIR_DISABLE_UPDATE_CHECK` or `CI`
  - `isUpdateStale(cache: UpdateCache, intervalHours: number): boolean` — true when no lastCheckAt, or elapsed ≥ interval
  - `shouldCheckForUpdate(opts: { env: NodeJS.ProcessEnv; configUpdate: UpdateConfigLike; cache: UpdateCache }): boolean`
  - `latestVersionFromCache(cache: UpdateCache, channel: string): string | null`
  - `fetchLatestVersion(channel: string, signal?: AbortSignal): Promise<string | null>` — hits npm registry `/@noir-ai/cli` dist-tag, offline-safe (returns null on any failure)

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/update-check.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isUpdateCheckDisabled,
  isUpdateStale,
  readUpdateCache,
  shouldCheckForUpdate,
  updateCachePath,
  writeUpdateCache,
} from '../src/update-check.js';

let dir: string; let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-update-cache-'));
  prev = process.env.NOIR_UPDATE_CACHE_JSON;
  process.env.NOIR_UPDATE_CACHE_JSON = join(dir, 'update-cache.json');
});
afterEach(() => {
  if (prev === undefined) delete process.env.NOIR_UPDATE_CACHE_JSON;
  else process.env.NOIR_UPDATE_CACHE_JSON = prev;
  rmSync(dir, { recursive: true, force: true });
});

const UPDATE = { checkEnabled: true, checkIntervalHours: 24, channel: 'latest' as const, minVersion: '1.6.0', display: 'notice' as const };

describe('update cache', () => {
  it('defaults to empty', () => {
    expect(readUpdateCache()).toEqual({ lastCheckAt: null, latestVersion: null, channel: null });
  });
  it('round-trips', () => {
    writeUpdateCache({ lastCheckAt: '2026-08-03T00:00:00.000Z', latestVersion: '1.7.0', channel: 'latest' });
    expect(readUpdateCache()).toEqual({ lastCheckAt: '2026-08-03T00:00:00.000Z', latestVersion: '1.7.0', channel: 'latest' });
  });
});

describe('isUpdateCheckDisabled', () => {
  it('false normally, true under CI or kill-switch', () => {
    expect(isUpdateCheckDisabled({})).toBe(false);
    expect(isUpdateCheckDisabled({ CI: 'true' })).toBe(true);
    expect(isUpdateCheckDisabled({ NOIR_DISABLE_UPDATE_CHECK: '1' })).toBe(true);
  });
});

describe('isUpdateStale', () => {
  it('stale when never checked, fresh within interval', () => {
    expect(isUpdateStale({ lastCheckAt: null, latestVersion: null, channel: null }, 24)).toBe(true);
    const now = Date.now();
    const recent = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
    expect(isUpdateStale({ lastCheckAt: recent, latestVersion: '1.7.0', channel: 'latest' }, 24)).toBe(false);
    const old = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    expect(isUpdateStale({ lastCheckAt: old, latestVersion: '1.7.0', channel: 'latest' }, 24)).toBe(true);
  });
});

describe('shouldCheckForUpdate', () => {
  it('checks when enabled + stale + not disabled', () => {
    expect(shouldCheckForUpdate({
      env: {},
      configUpdate: UPDATE,
      cache: { lastCheckAt: null, latestVersion: null, channel: null },
    })).toBe(true);
  });
  it('skips when disabled, not stale, or configured off', () => {
    expect(shouldCheckForUpdate({
      env: { CI: 'true' },
      configUpdate: UPDATE,
      cache: { lastCheckAt: null, latestVersion: null, channel: null },
    })).toBe(false);
    expect(shouldCheckForUpdate({
      env: {},
      configUpdate: { ...UPDATE, checkEnabled: false },
      cache: { lastCheckAt: null, latestVersion: null, channel: null },
    })).toBe(false);
    expect(shouldCheckForUpdate({
      env: {},
      configUpdate: UPDATE,
      cache: { lastCheckAt: new Date().toISOString(), latestVersion: '1.7.0', channel: 'latest' },
    })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/test/update-check.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/update-check.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, type InstallRecord } from './install-method.js';
import { noirHome } from './layout.js';

export interface UpdateCache {
  lastCheckAt: string | null;
  latestVersion: string | null;
  channel: string | null;
}

export interface UpdateConfigLike {
  checkEnabled: boolean;
  checkIntervalHours: number;
  channel: 'latest' | 'beta';
  minVersion: string;
  display: 'notice' | 'silent';
}

export function updateCachePath(): string {
  return process.env.NOIR_UPDATE_CACHE_JSON ?? join(noirHome(), 'update-cache.json');
}

export function readUpdateCache(): UpdateCache {
  try {
    const raw = readFileSync(updateCachePath(), 'utf8');
    const c = JSON.parse(raw) as Partial<UpdateCache>;
    return {
      lastCheckAt: typeof c.lastCheckAt === 'string' ? c.lastCheckAt : null,
      latestVersion: typeof c.latestVersion === 'string' ? c.latestVersion : null,
      channel: typeof c.channel === 'string' ? c.channel : null,
    };
  } catch {
    return { lastCheckAt: null, latestVersion: null, channel: null };
  }
}

export function writeUpdateCache(cache: UpdateCache): void {
  atomicWriteFile(updateCachePath(), `${JSON.stringify(cache, null, 2)}\n`);
}

export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.NOIR_DISABLE_UPDATE_CHECK !== undefined || env.CI !== undefined;
}

export function isUpdateStale(cache: UpdateCache, intervalHours: number): boolean {
  if (!cache.lastCheckAt) return true;
  const elapsed = Date.now() - new Date(cache.lastCheckAt).getTime();
  return elapsed >= intervalHours * 60 * 60 * 1000;
}

export function shouldCheckForUpdate(opts: {
  env: NodeJS.ProcessEnv;
  configUpdate: UpdateConfigLike;
  cache: UpdateCache;
}): boolean {
  if (!opts.configUpdate.checkEnabled) return false;
  if (isUpdateCheckDisabled(opts.env)) return false;
  return isUpdateStale(opts.cache, opts.configUpdate.checkIntervalHours);
}

export function latestVersionFromCache(cache: UpdateCache, channel: string): string | null {
  if (cache.channel !== channel) return null;
  return cache.latestVersion;
}

/** Fetch the current dist-tag version from npm. Offline-safe: any failure → null. */
export async function fetchLatestVersion(channel: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/@noir-ai/cli/${channel}`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}
```

```ts
// packages/core/src/index.ts — add
export {
  type UpdateCache,
  type UpdateConfigLike,
  updateCachePath,
  readUpdateCache,
  writeUpdateCache,
  isUpdateCheckDisabled,
  isUpdateStale,
  shouldCheckForUpdate,
  latestVersionFromCache,
  fetchLatestVersion,
} from './update-check.js';
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/test/update-check.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/update-check.ts packages/core/src/index.ts packages/core/test/update-check.test.ts
git commit -m "feat(core): cached async update-check + update-cache.json"
```

---

### Task 4: Install-method detection + manager subprocess runner (core)

**Files:**
- Create: `packages/core/src/install-detect.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/install-detect.test.ts`

**Interfaces:**
- Consumes: `InstallMethod`, `InstallRecord` (Task 1).
- Produces:
  - `interface DetectResult { method: InstallMethod; version: string | null; uninstallCmd: string | null; managerDetected: boolean }`
  - `detectInstallMethods(env: NodeJS.ProcessEnv): Promise<DetectResult[]>` — probes npm/pnpm/yarn/bun/homebrew/scoop, read-only, never mutates.
  - `detectActiveMethod(): InstallMethod` — from `readInstallRecord()`, else `'unknown'`.
  - `uninstallCommandFor(method: InstallMethod): string | null`
  - `runManagerCmd(cmd: string[], opts?: { cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>` — wraps `spawn` with a timeout, offline-safe (non-zero → `{code, ...}`, never throws).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/install-detect.test.ts
import { describe, expect, it } from 'vitest';
import {
  detectActiveMethod,
  uninstallCommandFor,
} from '../src/install-detect.js';
import { readInstallRecord, writeInstallRecord } from '../src/install-method.js';

describe('uninstallCommandFor', () => {
  it('returns the exact manager uninstall for each method', () => {
    expect(uninstallCommandFor('npm')).toBe('npm uninstall -g @noir-ai/cli');
    expect(uninstallCommandFor('pnpm')).toBe('pnpm remove -g @noir-ai/cli');
    expect(uninstallCommandFor('yarn')).toBe('yarn global remove @noir-ai/cli');
    expect(uninstallCommandFor('bun')).toBe('bun rm -g @noir-ai/cli');
    expect(uninstallCommandFor('homebrew')).toBe('brew uninstall noir');
    expect(uninstallCommandFor('scoop')).toBe('scoop uninstall noir');
    expect(uninstallCommandFor('unknown')).toBeNull();
    expect(uninstallCommandFor('native')).toBeNull();
  });
});

describe('detectActiveMethod', () => {
  it('reads the install record, defaults to unknown', () => {
    // No record → unknown
    expect(detectActiveMethod()).toBe('unknown');
    writeInstallRecord({ method: 'npm', version: '1.6.0', channel: 'latest', installedAt: 'x' });
    expect(detectActiveMethod()).toBe('npm');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/test/install-detect.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/src/install-detect.ts
import { spawn } from 'node:child_process';
import { readInstallRecord, type InstallMethod } from './install-method.js';

export interface DetectResult {
  method: InstallMethod;
  version: string | null;
  uninstallCmd: string | null;
  managerDetected: boolean;
}

const UNINSTALL: Record<Exclude<InstallMethod, 'native' | 'unknown'>, string> = {
  npm: 'npm uninstall -g @noir-ai/cli',
  pnpm: 'pnpm remove -g @noir-ai/cli',
  yarn: 'yarn global remove @noir-ai/cli',
  bun: 'bun rm -g @noir-ai/cli',
  homebrew: 'brew uninstall noir',
  scoop: 'scoop uninstall noir',
};

export function uninstallCommandFor(method: InstallMethod): string | null {
  if (method === 'native' || method === 'unknown') return null;
  return UNINSTALL[method];
}

export function detectActiveMethod(): InstallMethod {
  return readInstallRecord()?.method ?? 'unknown';
}

function binExists(cmd: string): boolean {
  try {
    spawn('which', [cmd], { stdio: 'ignore' });
    return true; // `which` failing throws below; presence is best-effort
  } catch {
    return false;
  }
}

/** Read-only detection of every noir install on the system. Never mutates. */
export async function detectInstallMethods(env: NodeJS.ProcessEnv): Promise<DetectResult[]> {
  const results: DetectResult[] = [];
  // npm global
  try {
    const { code, stdout } = await runManagerCmd(['npm', 'ls', '-g', '@noir-ai/cli', '--depth=0'], { env });
    if (code === 0 || stdout.includes('@noir-ai/cli')) {
      results.push({ method: 'npm', version: null, uninstallCmd: UNINSTALL.npm, managerDetected: true });
    }
  } catch { /* not installed */ }
  // pnpm
  try {
    const { code, stdout } = await runManagerCmd(['pnpm', 'list', '-g', '@noir-ai/cli'], { env });
    if (code === 0 || stdout.includes('@noir-ai/cli')) {
      results.push({ method: 'pnpm', version: null, uninstallCmd: UNINSTALL.pnpm, managerDetected: true });
    }
  } catch { /* not installed */ }
  // yarn classic
  try {
    const { code, stdout } = await runManagerCmd(['yarn', 'global', 'list'], { env });
    if (code === 0 && stdout.includes('@noir-ai/cli')) {
      results.push({ method: 'yarn', version: null, uninstallCmd: UNINSTALL.yarn, managerDetected: true });
    }
  } catch { /* not installed */ }
  // bun
  try {
    const { code, stdout } = await runManagerCmd(['bun', 'pm', 'ls', '-g'], { env });
    if (code === 0 && stdout.includes('@noir-ai/cli')) {
      results.push({ method: 'bun', version: null, uninstallCmd: UNINSTALL.bun, managerDetected: true });
    }
  } catch { /* not installed */ }
  // homebrew
  try {
    const { code, stdout } = await runManagerCmd(['brew', 'list', '--versions', 'noir'], { env });
    if (code === 0 || stdout.toLowerCase().includes('noir')) {
      results.push({ method: 'homebrew', version: null, uninstallCmd: UNINSTALL.homebrew, managerDetected: true });
    }
  } catch { /* not installed */ }
  // scoop
  try {
    const { code, stdout } = await runManagerCmd(['scoop', 'which', 'noir'], { env });
    if (code === 0 || stdout.toLowerCase().includes('noir')) {
      results.push({ method: 'scoop', version: null, uninstallCmd: UNINSTALL.scoop, managerDetected: true });
    }
  } catch { /* not installed */ }
  return results;
}

/** Run a manager subprocess with a timeout. Never throws: non-zero → {code,stdout,stderr}. */
export function runManagerCmd(
  cmd: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: 'timeout' });
    }, opts.timeoutMs ?? 10_000);
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/test/install-detect.test.ts`
Expected: PASS.

> Note: `detectInstallMethods` is not unit-tested against real managers (would need network/tools). It's covered by the CI smoke test (Task 10). The pure helpers (`uninstallCommandFor`, `detectActiveMethod`) are unit-tested.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/install-detect.ts packages/core/src/index.ts packages/core/test/install-detect.test.ts
git commit -m "feat(core): install-method detection + manager subprocess runner"
```

---

### Task 5: `noir install` command (CLI) — migrate to native preserving settings

**Files:**
- Create: `packages/cli/src/commands/install.ts`
- Modify: `packages/cli/src/bin.ts` (register `install` + `migrate` alias)
- Test: `packages/cli/test/install.test.ts`

**Interfaces:**
- Consumes: `detectInstallMethods`, `detectActiveMethod`, `uninstallCommandFor`, `runManagerCmd`, `writeInstallRecord`, `readInstallRecord` (core, Tasks 1+4); `noirHome` (core); `EXIT`, `fail`, `info`, `warn`, `success`, `json` (cli output); the CLI command pattern (`CliOptions`, lazy import, `{ok,data}` envelope).
- Produces:
  - `interface InstallOptions extends CliOptions { list?: boolean; uninstallPrev?: boolean; spec?: string }`
  - `install(opts: InstallOptions): Promise<void>`
  - `installManagedNode(opts: { channel?: string; version?: string; env: NodeJS.ProcessEnv }): Promise<{ ok: boolean; version: string | null; error?: string }>` — the managed-Node native install (downloads pinned Node to `~/.noir/runtime/<v>`, installs `@noir-ai/cli` into isolated prefix `~/.noir/cli`, writes shim `~/.noir/bin/noir`, writes install record).

- [ ] **Step 1: Write the failing test (pure parts — the flow with a fake installer)**

```ts
// packages/cli/test/install.test.ts
import { describe, expect, it } from 'vitest';
import { uninstallCommandFor, type DetectResult } from '@noir-ai/core';
import { buildMigrationPlan } from '../src/commands/install.js';

describe('buildMigrationPlan (pure)', () => {
  it('targets native when a prior method is detected', () => {
    const detected: DetectResult[] = [
      { method: 'npm', version: '1.5.0', uninstallCmd: 'npm uninstall -g @noir-ai/cli', managerDetected: true },
    ];
    const plan = buildMigrationPlan({ detected, currentMethod: 'npm', targetSpec: 'latest', installedVersion: '1.5.0' });
    expect(plan.shouldMigrate).toBe(true);
    expect(plan.nativeVersion).toBe('latest');
    expect(plan.prevUninstallCmd).toBe('npm uninstall -g @noir-ai/cli');
  });

  it('flags a downgrade (target older than installed) without auto-uninstall', () => {
    const detected: DetectResult[] = [
      { method: 'npm', version: '1.7.0', uninstallCmd: 'npm uninstall -g @noir-ai/cli', managerDetected: true },
    ];
    const plan = buildMigrationPlan({ detected, currentMethod: 'npm', targetSpec: '1.6.0', installedVersion: '1.7.0' });
    expect(plan.isDowngrade).toBe(true);
    expect(plan.prevUninstallCmd).toBe('npm uninstall -g @noir-ai/cli'); // still NOT auto-run
    expect(plan.autoUninstall).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/cli/test/install.test.ts`
Expected: FAIL — `buildMigrationPlan` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/commands/install.ts
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteFile,
  detectActiveMethod,
  detectInstallMethods,
  noirHome,
  readInstallRecord,
  runManagerCmd,
  uninstallCommandFor,
  writeInstallRecord,
  type DetectResult,
} from '@noir-ai/core';
import { type CliOptions, EXIT, fail, info, success, warn } from '../output.js';

export interface InstallOptions extends CliOptions {
  list?: boolean;
  uninstallPrev?: boolean;
  spec?: string;
}

export interface MigrationPlan {
  detected: DetectResult[];
  currentMethod: string;
  targetSpec: string;
  installedVersion: string | null;
  shouldMigrate: boolean;
  isDowngrade: boolean;
  nativeVersion: string;
  prevUninstallCmd: string | null;
  autoUninstall: boolean; // always false unless --uninstall-prev
}

/** Pure: build the migration plan from detection + target. No I/O. */
export function buildMigrationPlan(opts: {
  detected: DetectResult[];
  currentMethod: string;
  targetSpec: string;
  installedVersion: string | null;
}): MigrationPlan {
  const detected = opts.detected;
  const shouldMigrate = detected.length > 0 && opts.currentMethod !== 'native';
  const nativeVersion = opts.targetSpec;
  let isDowngrade = false;
  if (opts.installedVersion && nativeVersion !== 'latest' && nativeVersion !== 'beta') {
    isDowngrade = semverLt(nativeVersion, opts.installedVersion);
  }
  return {
    detected,
    currentMethod: opts.currentMethod,
    targetSpec: opts.targetSpec,
    installedVersion: opts.installedVersion,
    shouldMigrate,
    isDowngrade,
    nativeVersion,
    prevUninstallCmd: detected[0]?.uninstallCmd ?? null,
    autoUninstall: false,
  };
}

function semverLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0; const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

export async function installManagedNode(opts: {
  channel?: string; version?: string; env: NodeJS.ProcessEnv;
}): Promise<{ ok: boolean; version: string | null; error?: string }> {
  const spec = opts.version ?? opts.channel ?? 'latest';
  const home = noirHome();
  const runtimeDir = join(home, 'runtime');
  const cliDir = join(home, 'cli');
  const binDir = join(home, 'bin');
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Managed Node: pinned 22.x LTS, installed once into runtime/<v>.
  // (Simplified for the plan; the exact download URL/pinning lands in Task 9's
  // installer, and this JS path delegates to it. For the CLI's own native
  // install we reuse the SAME runtime the installer provisions.)
  const nodeBin = join(runtimeDir, 'node', 'bin', 'node');
  const npmBin = join(runtimeDir, 'node', 'bin', 'npm');
  if (!existsSync(nodeBin)) {
    return { ok: false, version: null, error: `managed Node not provisioned (expected ${nodeBin}) — run the native installer first (install.sh/install.ps1)` };
  }

  // Install @noir-ai/cli into the isolated prefix using the managed npm.
  const { code, stderr } = await runManagerCmd([npmBin, 'install', '-g', `@noir-ai/cli@${spec}`, `--prefix=${cliDir}`], { env: opts.env, timeoutMs: 120_000 });
  if (code !== 0) {
    return { ok: false, version: null, error: `npm install failed: ${stderr.slice(0, 300)}` };
  }

  // Shim: ~/.noir/bin/noir → managed node + isolated prefix.
  const shim = join(binDir, 'noir');
  const shimBody = `#!/usr/bin/env bash\n"${nodeBin}" "${join(cliDir, 'lib', 'node_modules', '@noir-ai', 'cli', 'dist', 'bin.js')}" "$@"\n`;
  atomicWriteFile(shim, shimBody);
  // (POSIX shim; Windows uses a .cmd wrapper — Task 9.)

  // Resolve installed version via the shim.
  const ver = await runManagerCmd([nodeBin, join(cliDir, 'lib', 'node_modules', '@noir-ai', 'cli', 'dist', 'bin.js'), '--version'], { env: opts.env, timeoutMs: 30_000 });
  const version = ver.code === 0 ? ver.stdout.trim() : null;
  writeInstallRecord({ method: 'native', version: version ?? '0.0.0', channel: opts.channel ?? 'latest', installedAt: new Date().toISOString(), managedRuntimeVersion: '22.x' });
  return { ok: true, version };
}

export async function install(opts: InstallOptions = {}): Promise<void> {
  if (opts.list === true) {
    const detected = await detectInstallMethods(process.env);
    const json = { ok: true, data: { detected } };
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(json)}\n`);
      return;
    }
    info('Detected installs:');
    for (const d of detected) info(`  ${d.method} (${d.version ?? 'unknown'})`);
    return;
  }

  const currentMethod = detectActiveMethod();
  const detected = await detectInstallMethods(process.env);
  const installedRecord = readInstallRecord();
  const plan = buildMigrationPlan({
    detected,
    currentMethod,
    targetSpec: opts.spec ?? 'latest',
    installedVersion: installedRecord?.version ?? null,
  });

  if (plan.isDowngrade) {
    warn(`Target ${plan.nativeVersion} is OLDER than installed ${plan.installedVersion}.`);
    // (Interactive confirm is skipped under --no-input; we hard-stop to be safe.)
    if (opts.noInput === true) {
      fail(EXIT.USAGE, `refusing downgrade to ${plan.nativeVersion} (installed ${plan.installedVersion})`, opts);
    }
    // @clack confirm gate (lazy import) — same pattern as home.ts.
  }

  const result = await installManagedNode({ channel: plan.nativeVersion === 'beta' ? 'beta' : undefined, version: plan.nativeVersion.startsWith('v') ? plan.nativeVersion : plan.nativeVersion === 'latest' || plan.nativeVersion === 'beta' ? undefined : plan.nativeVersion, env: process.env });
  if (!result.ok) {
    fail(EXIT.ERROR, result.error ?? 'native install failed', opts);
  }

  info(`Installed native: ${result.version}.`);
  if (plan.prevUninstallCmd && opts.uninstallPrev !== true) {
    warn(`To finish the migration, uninstall the previous install: ${plan.prevUninstallCmd}`);
    warn('  Or re-run with --uninstall-prev to do it now. Rollback: reinstall via the previous manager.');
  } else if (plan.prevUninstallCmd && opts.uninstallPrev === true) {
    const { code } = await runManagerCmd(plan.prevUninstallCmd.split(' '), { env: process.env });
    if (code === 0) success('Previous install removed.');
    else warn('Previous install NOT removed (non-zero exit). You can remove it manually.');
  }
  success(`noir ${result.version} installed via native. Run \`noir doctor\` to verify.`);
}
```

- [ ] **Step 4: Register `install` + `migrate` in bin.ts**

In `packages/cli/src/bin.ts`, after the `task` group (before `handoff`), add:

```ts
  // C1 — `noir install` / `noir migrate`: move to the native install path,
  // preserving all settings. `migrate` is an alias (mirrors claude migrate-installer).
  const installCmd = program
    .command('install')
    .description('install Noir via the native managed-Node path (or migrate from another install method)')
    .option('--list', 'list detected install methods')
    .option('--uninstall-prev', 'after a successful migrate, uninstall the previous install method')
    .argument('[spec]', "channel ('latest'|'beta') or exact version (default: latest)")
    .action(async (spec: string | undefined, opts: { list?: boolean; uninstallPrev?: boolean }, cmd: Command) => {
      const { install } = await import('./commands/install.js');
      const cli = cmd.optsWithGlobals() as CliOptions;
      await install({ ...cli, spec, list: opts.list === true, uninstallPrev: opts.uninstallPrev === true });
    });
  // `migrate` alias — same behavior.
  program
    .command('migrate', { hidden: true })
    .description('alias for `noir install` (move to the native install path)')
    .option('--list', 'list detected install methods')
    .option('--uninstall-prev', 'after a successful migrate, uninstall the previous install method')
    .argument('[spec]', "channel ('latest'|'beta') or exact version (default: latest)")
    .action(async (spec: string | undefined, opts: { list?: boolean; uninstallPrev?: boolean }, cmd: Command) => {
      const { install } = await import('./commands/install.js');
      const cli = cmd.optsWithGlobals() as CliOptions;
      await install({ ...cli, spec, list: opts.list === true, uninstallPrev: opts.uninstallPrev === true });
    });
```

> Check whether commander supports `.command('migrate', { hidden: true })` with a separate action — if the two-arg form (a separate Command file) doesn't fit this pattern, use `.command('migrate').action(...)` and register it as an alias via `installCmd.alias('migrate')` (cleaner). Prefer `installCmd.alias('migrate')`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run packages/cli/test/install.test.ts packages/cli/test/bin.test.ts`
Expected: PASS (install pure test + existing bin arg pins unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/install.ts packages/cli/src/bin.ts packages/cli/test/install.test.ts
git commit -m "feat(cli): noir install/migrate — native path preserving settings"
```

---

### Task 6: `noir update` command (CLI) + async version-check wiring

**Files:**
- Create: `packages/cli/src/commands/update.ts`
- Modify: `packages/cli/src/bin.ts` (register `update`)
- Modify: `packages/cli/src/commands/home.ts` + `packages/cli/src/commands/status.ts` (async update-check hook on non-blocking paths)
- Test: `packages/cli/test/update.test.ts`

**Interfaces:**
- Consumes: `readInstallRecord`, `detectActiveMethod`, `runManagerCmd`, `uninstallCommandFor`, `readUpdateCache`, `writeUpdateCache`, `shouldCheckForUpdate`, `fetchLatestVersion`, `latestVersionFromCache`, `isUpdateStale` (core); `installManagedNode` (Task 5); output helpers.
- Produces:
  - `interface UpdateOptions extends CliOptions { check?: boolean; spec?: string }`
  - `update(opts: UpdateOptions): Promise<void>`
  - `runAsyncUpdateCheck(opts: { env: NodeJS.ProcessEnv; configUpdate: UpdateConfigLike; quiet: boolean }): Promise<void>` — non-blocking, time-boxed, cache-writes, silent on failure.

- [ ] **Step 1: Write the failing test (pure parts)**

```ts
// packages/cli/test/update.test.ts
import { describe, expect, it } from 'vitest';
import { buildUpdateTarget, type UpdateTarget } from '../src/commands/update.js';

describe('buildUpdateTarget (pure)', () => {
  it('uses the active method + target channel', () => {
    const t = buildUpdateTarget({ method: 'npm', channel: 'latest', spec: undefined, currentVersion: '1.5.0', latestKnown: '1.6.0' });
    expect(t).toEqual({ method: 'npm', targetSpec: 'latest', currentVersion: '1.5.0', latestKnown: '1.6.0', isUpgrade: true });
  });
  it('isUpgrade false when already current', () => {
    const t = buildUpdateTarget({ method: 'native', channel: 'latest', spec: undefined, currentVersion: '1.6.0', latestKnown: '1.6.0' });
    expect(t.isUpgrade).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/cli/test/update.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/commands/update.ts
import { readInstallRecord } from '@noir-ai/core';
import {
  detectActiveMethod,
  fetchLatestVersion,
  readUpdateCache,
  runManagerCmd,
  uninstallCommandFor,
  writeUpdateCache,
  type UpdateConfigLike,
} from '@noir-ai/core';
import { type CliOptions, EXIT, fail, info, success, warn } from '../output.js';
import { installManagedNode } from './install.js';

export interface UpdateOptions extends CliOptions {
  check?: boolean;
  spec?: string;
}

export interface UpdateTarget {
  method: string;
  targetSpec: string;
  currentVersion: string | null;
  latestKnown: string | null;
  isUpgrade: boolean;
}

export function buildUpdateTarget(opts: {
  method: string;
  channel: string;
  spec?: string;
  currentVersion: string | null;
  latestKnown: string | null;
}): UpdateTarget {
  const targetSpec = opts.spec ?? opts.channel;
  const isUpgrade =
    (opts.latestKnown != null && opts.currentVersion != null && opts.latestKnown !== opts.currentVersion);
  return {
    method: opts.method,
    targetSpec,
    currentVersion: opts.currentVersion,
    latestKnown: opts.latestKnown,
    isUpgrade,
  };
}

export async function update(opts: UpdateOptions = {}): Promise<void> {
  const method = detectActiveMethod();
  const rec = readInstallRecord();
  const currentVersion = rec?.version ?? null;

  if (opts.check === true) {
    const latest = await fetchLatestVersion('latest');
    info(latest ? `Latest: ${latest} (you have ${currentVersion ?? 'unknown'})` : 'Could not reach the registry.');
    return;
  }

  // Fetch latest (network; timeout-bound).
  const latest = await fetchLatestVersion('latest');
  const target = buildUpdateTarget({
    method,
    channel: 'latest',
    spec: opts.spec,
    currentVersion,
    latestKnown: latest,
  });

  if (!target.isUpgrade) {
    info(`noir ${currentVersion} is up to date.`);
    return;
  }

  if (method === 'native') {
    const res = await installManagedNode({ version: target.targetSpec === 'latest' ? undefined : target.targetSpec, env: process.env });
    if (!res.ok) fail(EXIT.ERROR, res.error ?? 'update failed', opts);
    success(`Updated to ${res.version}.`);
    return;
  }

  // npm/pnpm/yarn/bun/homebrew/scoop → reinstall via the same manager.
  const cmd = updateCmdFor(method, target.targetSpec);
  if (!cmd) fail(EXIT.USAGE, `cannot auto-update a ${method} install; use the manager directly`, opts);
  const { code, stderr } = await runManagerCmd(cmd, { env: process.env });
  if (code !== 0) fail(EXIT.ERROR, `update failed: ${stderr.slice(0, 300)}`, opts);
  success('Updated.');
}

function updateCmdFor(method: string, spec: string): string[] | null {
  switch (method) {
    case 'npm': return ['npm', 'install', '-g', `@noir-ai/cli@${spec}`];
    case 'pnpm': return ['pnpm', 'add', '-g', `@noir-ai/cli@${spec}`];
    case 'yarn': return ['yarn', 'global', 'add', `@noir-ai/cli@${spec}`];
    case 'bun': return ['bun', 'add', '-g', `@noir-ai/cli@${spec}`];
    case 'homebrew': return ['brew', 'upgrade', 'noir'];
    case 'scoop': return ['scoop', 'update', 'noir'];
    default: return null;
  }
}

/** Non-blocking, time-boxed startup check. Writes the cache on success; silent on any failure. */
export async function runAsyncUpdateCheck(opts: {
  env: NodeJS.ProcessEnv;
  configUpdate: UpdateConfigLike;
  quiet: boolean;
}): Promise<void> {
  const cache = readUpdateCache();
  if (!shouldCheckForUpdate({ env: opts.env, configUpdate: opts.configUpdate, cache })) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const latest = await fetchLatestVersion(opts.configUpdate.channel, controller.signal);
  clearTimeout(timer);
  if (latest != null) {
    writeUpdateCache({ lastCheckAt: new Date().toISOString(), latestVersion: latest, channel: opts.configUpdate.channel });
  }
  // Non-blocking: never print in quiet/CI/non-TTY; a mismatch only nudges.
}
```

- [ ] **Step 4: Register `update` in bin.ts**

```ts
  // C1 — `noir update`: self-update via the active install method.
  program
    .command('update')
    .description('update Noir to the latest version via the active install method')
    .option('--check', 'check for a new version without changing anything')
    .argument('[spec]', "channel ('latest'|'beta') or exact version (default: latest)")
    .action(async (spec: string | undefined, opts: { check?: boolean }, cmd: Command) => {
      const { update } = await import('./commands/update.js');
      const cli = cmd.optsWithGlobals() as CliOptions;
      await update({ ...cli, spec, check: opts.check === true });
    });
```

- [ ] **Step 5: Wire the async check into non-blocking startup paths**

In `packages/cli/src/commands/home.ts` (the interactive menu path, only when interactive + TTY) and `packages/cli/src/commands/status.ts` (before the snapshot), add:

```ts
// fire-and-forget; never blocks, never prints under --json/--quiet/CI/non-TTY.
void runAsyncUpdateCheck({
  env: process.env,
  configUpdate: project?.config.update ?? DEFAULT_UPDATE_CONFIG,
  quiet: opts.json === true || opts.quiet === true || !process.stdout.isTTY,
});
```

Where `DEFAULT_UPDATE_CONFIG = { checkEnabled: true, checkIntervalHours: 24, channel: 'latest', minVersion: '1.6.0', display: 'notice' }`.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/cli/test/update.test.ts packages/cli/test/home.test.ts packages/cli/test/status.test.ts packages/cli/test/bin.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/update.ts packages/cli/src/bin.ts packages/cli/src/commands/home.ts packages/cli/src/commands/status.ts packages/cli/test/update.test.ts
git commit -m "feat(cli): noir update + async cached version check"
```

---

### Task 7: Doctor `install` row

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `detectActiveMethod`, `readInstallRecord`, `readUpdateCache`, `latestVersionFromCache` (core); the doctor check pattern (`CheckResult`, `checks.push`, severity ok/warn/fail).
- Produces: a new `install` check row (never `fail`), plus `data.install` on the payload.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/doctor.test.ts — add
import { describe, expect, it } from 'vitest';
import { buildInstallCheck, type InstallCheckOutcome } from '../src/commands/doctor.js';
import type { InstallMethod } from '@noir-ai/core';

describe('buildInstallCheck (pure)', () => {
  it('reports method + recommendation without network', () => {
    const o = buildInstallCheck({ method: 'npm', version: '1.5.0', latestKnown: '1.6.0' });
    expect(o.status).toBe('warn'); // non-native advisory
    expect(o.detail).toContain('native recommended');
    expect(o.detail).toContain('update available');
  });
  it('native + current → ok', () => {
    const o = buildInstallCheck({ method: 'native', version: '1.6.0', latestKnown: '1.6.0' });
    expect(o.status).toBe('ok');
  });
  it('never fails', () => {
    for (const m of ['native','npm','homebrew','unknown'] as InstallMethod[]) {
      const o = buildInstallCheck({ method: m, version: null, latestKnown: null });
      expect(['ok','warn']).toContain(o.status);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/cli/test/doctor.test.ts`
Expected: FAIL — `buildInstallCheck` not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/commands/doctor.ts`, add near the other check builders:

```ts
import {
  detectActiveMethod,
  latestVersionFromCache,
  readInstallRecord,
  readUpdateCache,
  type InstallMethod,
} from '@noir-ai/core';

export interface InstallCheckOutcome {
  name: 'install';
  status: 'ok' | 'warn';
  detail: string;
  method: InstallMethod;
  installedVersion: string | null;
  latestKnown: string | null;
}

/** Pure: build the doctor `install` row. NEVER `fail` — an install method issue
 *  is advisory, not a broken host. Reads the cache only; no network. */
export function buildInstallCheck(opts: {
  method: InstallMethod;
  version: string | null;
  latestKnown: string | null;
}): InstallCheckOutcome {
  const { method, version, latestKnown } = opts;
  const parts: string[] = [`method=${method}`];
  if (version) parts.push(`v${version}`);
  const advisory: string[] = [];
  if (method !== 'native') advisory.push('native recommended');
  if (latestKnown && version && latestKnown !== version) advisory.push('update available');
  const status: 'ok' | 'warn' = advisory.length > 0 ? 'warn' : 'ok';
  if (advisory.length > 0) parts.push(advisory.join(' + '));
  return {
    name: 'install',
    status,
    detail: parts.join(' · '),
    method,
    installedVersion: version,
    latestKnown,
  };
}
```

Add to the `DoctorPayload` interface:
```ts
  /** C1 install-method report. `method` from ~/.noir/install.json (fallback
   *  unknown); `latestKnown` from the update cache (never a live call). */
  install: { method: InstallMethod; installedVersion: string | null; latestKnown: string | null } | null;
```

In `doctor()`:
```ts
  const installCheck = buildInstallCheck({
    method: detectActiveMethod(),
    version: readInstallRecord()?.version ?? null,
    latestKnown: latestVersionFromCache(readUpdateCache(), 'latest'),
  });
  checks.push(installCheck);
  // ... include installCheck in the payload's `install` field.
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/cli/test/doctor.test.ts`
Expected: PASS (new + existing doctor checks still green; no `fail` regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/doctor.ts packages/cli/test/doctor.test.ts
git commit -m "feat(cli): doctor install row — method + advisory, cache-only"
```

---

### Task 8: TUI migration banner (nudge, once per channel/version)

**Files:**
- Modify: `packages/cli/src/commands/home.ts`
- Modify: `packages/cli/src/tui/App.tsx` (optional banner region) — keep minimal
- Test: `packages/cli/test/home.test.ts`

**Interfaces:**
- Consumes: `detectActiveMethod`, `readInstallRecord` (core); `shouldShowBanner` (existing).
- Produces: a `migrationBannerDismissed(record, version)` helper + render when not dismissed.

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/home.test.ts — add
import { describe, expect, it } from 'vitest';
import { shouldShowMigrationBanner } from '../src/commands/home.js';

describe('shouldShowMigrationBanner', () => {
  it('shows once for a non-native method, not for native', () => {
    expect(shouldShowMigrationBanner({ method: 'npm', version: '1.6.0', channel: 'latest', installedAt: 'x' }, '1.6.0')).toBe(true);
    expect(shouldShowMigrationBanner({ method: 'native', version: '1.6.0', channel: 'latest', installedAt: 'x' }, '1.6.0')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/cli/test/home.test.ts`
Expected: FAIL — function not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/cli/src/commands/home.ts — add
import { detectActiveMethod, readInstallRecord, type InstallRecord } from '@noir-ai/core';

/** One-time nudge: shows only for non-native installs, once per version. The
 *  "dismissed for this version" flag is stored in install.json's record
 *  (`dismissedVersions` is added on demand); absence ⇒ show. */
export function shouldShowMigrationBanner(rec: InstallRecord, currentVersion: string): boolean {
  if (rec.method === 'native') return false;
  return true; // naive v1: show whenever non-native; dismissal persists via a flag added in Task 11 hardening
}
```

In `runMenu()`, after the banner write and before `clack.intro`, add (only when interactive):
```ts
  const rec = readInstallRecord();
  if (rec && shouldShowMigrationBanner(rec, NOIR_VERSION)) {
    process.stderr.write(`\n  ${c.yellow('noir installed via ' + rec.method)} — consider \`noir install\` for the native path (auto-update, no npm prefix/PATH issues). Dismiss with: \`noir install --list\` (persisted per version).\n\n`);
  }
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run packages/cli/test/home.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/home.ts packages/cli/test/home.test.ts
git commit -m "feat(cli): one-time TUI migration banner for non-native installs"
```

---

### Task 9: `install.ps1` + `install.sh` Windows redirect + Scoop + Homebrew formula

**Files:**
- Create: `scripts/install.ps1`
- Modify: `scripts/install.sh` (Windows MINGW/MSYS/CYGWIN → redirect to install.ps1)
- Create: `packaging/scoop/noir.json`
- Modify: `packaging/homebrew/noir.rb` (real url/sha256/version + `std_npm_args`)
- Test: (no unit test — these are exercised by the CI smoke test in Task 10)

**Interfaces:**
- Consumes: the existing `install.sh` logic (channel/version/proxy/prefix/PATH verify); `~/.noir/` layout (Task 1).
- Produces:
  - `install.ps1` — native PowerShell sibling to install.sh: `NOIR_CHANNEL`/`NOIR_VERSION`/proxy; installs to `%LOCALAPPDATA%\noir` (`~\.noir`); verifies `noir --version`; writes `install.json` record.
  - `install.sh` — when MINGW/MSYS/CYGWIN, print `powershell -c "irm <url>/install.ps1 | iex"` and exit 0.
  - `packaging/scoop/noir.json` — Scoop manifest (community bucket), hash of npm tarball.
  - `packaging/homebrew/noir.rb` — real formula.

- [ ] **Step 1: Write `scripts/install.ps1`**

```powershell
# scripts/install.ps1 — native PowerShell installer for Noir (Windows).
# Mirrors scripts/install.sh. Env knobs: NOIR_CHANNEL, NOIR_VERSION,
# HTTP_PROXY/HTTPS_PROXY/NO_PROXY. Installs @noir-ai/cli via a managed-Node
# runtime under ~\.noir (runtime/, cli/, bin/) and writes ~\.noir\install.json.
# Usage:
#   powershell -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"

$ErrorActionPreference = 'Stop'

$Package = '@noir-ai/cli'
$RepoUrl = 'https://github.com/agaaaptr/noir'

function Info  { Write-Host "==> $args" -ForegroundColor Blue }
function Good  { Write-Host "[ok] $args" -ForegroundColor Green }
function Warn  { Write-Host "[!] $args" -ForegroundColor Yellow }
function Die   { Write-Error $args; exit 1 }

# --- Resolve spec ---
$channel = if ($env:NOIR_CHANNEL) { $env:NOIR_CHANNEL } else { 'latest' }
$spec = if ($env:NOIR_VERSION) { "@$($env:NOIR_VERSION)" } else { "@$channel" }

$home = if ($env:NOIR_HOME) { $env:NOIR_HOME } else { Join-Path $HOME '.noir' }
$runtimeDir = Join-Path $home 'runtime'
$cliDir     = Join-Path $home 'cli'
$binDir     = Join-Path $home 'bin'
New-Item -ItemType Directory -Force -Path $runtimeDir, $cliDir, $binDir | Out-Null

# --- Managed Node: require a provisioned runtime (the CLI's own install reuses it).
$nodeBin = Join-Path $runtimeDir 'node\node.exe'
if (-not (Test-Path $nodeBin)) {
  Warn "Managed Node not provisioned at $nodeBin."
  Warn "For the native path, provision Node 22 LTS under $runtimeDir (see docs)."
  # Fallback: use system node/npm if >= 22.
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Die 'Node.js >= 22 is required. Install it, or provision the managed runtime.' }
  $nodeBin = (Get-Command node).Source
}

$npmBin = if (Test-Path (Join-Path (Split-Path $nodeBin) 'npm.cmd')) { Join-Path (Split-Path $nodeBin) 'npm.cmd' } else { 'npm' }

# --- Install into the isolated prefix.
$prefixArgs = "--prefix=$cliDir"
Info "Installing $Package$spec via npm (prefix: $cliDir)"
& $npmBin install -g "$Package$spec" $prefixArgs
if ($LASTEXITCODE -ne 0) { Die "npm install failed (exit $LASTEXITCODE)" }

# --- Shim: bin\noir.cmd
$shim = Join-Path $binDir 'noir.cmd'
$cliMain = Join-Path $cliDir 'node_modules\@noir-ai\cli\dist\bin.js'
@"
@echo off
"%nodeBin%" "$cliMain" %*
"@ | Set-Content -Path $shim -Encoding ASCII

# --- Verify
$ver = & $nodeBin $cliMain --version
if ($LASTEXITCODE -ne 0) { Die 'Verification failed: noir --version' }
Good "Installed $Package$spec ($ver)"

# --- Record install method
$rec = @{ method = 'native'; version = $ver; channel = $channel; installedAt = (Get-Date).ToUniversalTime().ToString('o'); managedRuntimeVersion = '22.x' } | ConvertTo-Json
Set-Content -Path (Join-Path $home 'install.json') -Value $rec

# --- PATH hint
$binDir | Out-String | Write-Host
if (-not ($env:PATH -split ';' | Where-Object { $_ -ieq $binDir })) {
  Warn "Add $binDir to your PATH to run 'noir' from anywhere."
  Warn "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$binDir', 'User')"
}
```

- [ ] **Step 2: Add the Windows redirect to `install.sh`**

In `scripts/install.sh`, in `detect_platform()`, change the Windows case to redirect:

```bash
    MINGW*|MSYS*|CYGWIN*) os="windows"
      # C1: on Windows the canonical path is the native PowerShell installer.
      # Don't run a bash-wrapped npm install here — redirect instead.
      warn "Windows detected — use the native PowerShell installer:"
      warn "  powershell -c \"irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex\""
      exit 0
      ;;
```

- [ ] **Step 3: Write the Scoop manifest**

```json
// packaging/scoop/noir.json
{
  "version": "1.6.0",
  "description": "Discipline, context, and memory layer for any agentic CLI",
  "homepage": "https://github.com/agaaaptr/noir",
  "license": "MIT",
  "url": "https://registry.npmjs.org/@noir-ai/cli/-/@noir-ai/cli-1.6.0.tgz",
  "hash": "REPLACE_WITH_REAL_SHA256",
  "bin": "dist/bin.js"
}
```

> `hash` must be the real SHA-256 of the tarball (`shasum -a 256 <tarball>`). This is filled at release time (Task 10). `bin` points at the ESM entry; Scoop wraps it with node if `node` is available, else the user must have Node — the manifest should note `requires node` (Scoop `dependencies: nodejs-lts`).

- [ ] **Step 4: Complete the Homebrew formula**

Rewrite `packaging/homebrew/noir.rb`:

```ruby
class Noir < Formula
  desc "Discipline, context, and memory layer for any agentic CLI"
  homepage "https://github.com/agaaaptr/noir"
  url "https://registry.npmjs.org/@noir-ai/cli/-/@noir-ai/cli-1.6.0.tgz"
  sha256 "REPLACE_WITH_REAL_SHA256"
  version "1.6.0"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *Language::Node.std_npm_args(libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/noir --version")
  end
end
```

> Note: use `std_npm_args` (current Homebrew helper; `std_npm_install_args` is older). Must pass `brew audit --strict`.

- [ ] **Step 5: Commit**

```bash
git add scripts/install.ps1 scripts/install.sh packaging/scoop/noir.json packaging/homebrew/noir.rb
git commit -m "feat(dist): install.ps1 + Windows redirect + Scoop + real Homebrew formula"
```

---

### Task 10: Release pipeline — pinned installers + SHA256SUMS + attestations + CI matrix + install smoke test

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml`
- Create: `.github/actions/install-smoke/action.yml` (or inline steps)
- Test: (workflow YAML — validated by running the workflows; the smoke test itself is the CI validation)

**Interfaces:**
- Consumes: existing `release.yml` publish steps (id-token: write, provenance).
- Produces:
  - Pinned installer assets (`install.sh`, `install.ps1`) + `SHA256SUMS` uploaded to the GitHub Release.
  - Artifact attestations for those assets (`actions/attest-build-provenance`).
  - `ci.yml` matrix gains `windows-latest`; an install-smoke job runs the installer on each OS and asserts `noir --version` + `noir doctor`.

- [ ] **Step 1: Extend `release.yml` — checksum + attestation step**

Add after the "Publish the packed tarballs" step (before "Update release registry"):

```yaml
      # ── 7b. Generate installer artifacts + SHA256SUMS + attestations ──
      - name: Generate SHA256SUMS for installers
        if: success() && steps.check.outputs.already_published == 'false'
        run: |
          cd "$GITHUB_WORKSPACE"
          # Pinned, versioned installers (Astral/uv model): copy scripts to
          # tagged paths so users fetch from a tag, not the mutable main branch.
          mkdir -p dist-installers
          cp scripts/install.sh dist-installers/install.sh
          cp scripts/install.ps1 dist-installers/install.ps1
          ( cd dist-installers && shasum -a 256 install.sh install.ps1 > SHA256SUMS )
          # Attest the installers + checksums (reuses the release OIDC token).
          gh attestation create dist-installers/install.sh dist-installers/install.ps1 dist-installers/SHA256SUMS \
            --repo "$GITHUB_REPOSITORY" --predicate-type https://slsa.dev/provenance/v1

      - name: Attach installers to the GitHub Release
        if: success() && steps.check.outputs.already_published == 'false'
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ github.ref_name }}
          files: |
            dist-installers/install.sh
            dist-installers/install.ps1
            dist-installers/SHA256SUMS
```

- [ ] **Step 2: Add `windows-latest` to `ci.yml` + install smoke test**

In `ci.yml`, change the matrix to include Windows, and add a smoke job:

```yaml
  verify:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    # ... existing steps unchanged (they already work cross-platform; pnpm handles Windows)
```

Add a new job after `verify`:

```yaml
  install-smoke:
    name: Install smoke test (${{ matrix.os }})
    needs: verify
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - name: Run installer
        shell: bash
        run: |
          set -e
          if [ "$RUNNER_OS" = "Windows" ]; then
            powershell -ExecutionPolicy Bypass -File scripts/install.ps1
          else
            bash scripts/install.sh
          fi
      - name: Verify
        shell: bash
        run: |
          # The installer writes ~/.noir/bin; ensure it's on PATH for this step.
          export PATH="$HOME/.noir/bin:$PATH"
          noir --version
          noir doctor
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/ci.yml
git commit -m "ci: windows matrix + install smoke test + release checksums/attestation"
```

---

### Task 11: Hardening pass — migration banner dismissal, per-channel cache, PATH hint

**Files:**
- Modify: `packages/cli/src/commands/home.ts` (banner dismissal persists)
- Modify: `packages/core/src/update-check.ts` (per-channel cache — store `channel` keyed map, not single channel)
- Modify: `packages/cli/src/commands/install.ts` (PATH-precedence hint after migrate — `hash -r`, `which -a`)
- Test: `packages/cli/test/home.test.ts`, `packages/core/test/update-check.test.ts`, `packages/cli/test/install.test.ts`

**Interfaces:**
- Consumes: Task 8 banner + Task 3 cache + Task 5 install.
- Produces:
  - `shouldShowMigrationBanner` reads a `dismissedVersions: string[]` field on `InstallRecord`.
  - `UpdateCache` becomes channel-keyed: `{ latest: string|null, beta: string|null, lastCheckAt, channel }`.
  - Install prints a PATH hint (Claude Code #41806/#27910 mitigation).

- [ ] **Step 1: Per-channel update cache**

Change `UpdateCache` to:
```ts
export interface UpdateCache {
  lastCheckAt: string | null;
  /** latestVersion per channel — avoids cross-channel contamination. */
  versions: Record<string, string | null>;
}
```
Update `readUpdateCache`/`writeUpdateCache`/`latestVersionFromCache(cache, channel)` accordingly (default `{ lastCheckAt: null, versions: {} }`). Update the Task 3 test.

- [ ] **Step 2: Banner dismissal persists**

Add `dismissedVersions?: string[]` to `InstallRecord`. `shouldShowMigrationBanner(rec, version)` returns false when `rec.dismissedVersions?.includes(version)`. `noir install --list` with a `--dismiss` flag appends the current version. Update the Task 8 test.

- [ ] **Step 3: PATH hint after migrate**

In `install()`, after the swap:
```ts
  // Claude Code #41806/#27910 mitigation: the old npm bin may still resolve first.
  info('If `noir` still points at the old install, run: hash -r && which -a noir');
```

- [ ] **Step 4: Run full gate**

Run: `pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm docs:validate`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/update-check.ts packages/core/src/install-method.ts packages/cli/src/commands/home.ts packages/cli/src/commands/install.ts packages/cli/test/home.test.ts packages/core/test/update-check.test.ts packages/cli/test/install.test.ts
git commit -m "refactor(cli): per-channel update cache + banner dismissal + PATH hint"
```

---

### Task 12: Documentation — user-facing + roadmap (no drift)

**Files:**
- Modify: `docs/how-to/installation.md`
- Modify: `docs/getting-started.md`, `README.md`
- Modify: `docs/reference/cli.md`, `docs/reference/config.md`
- Modify: `docs/how-to/releasing.md`, `docs/how-to/packaging.md`
- Modify: `docs/roadmap/capability-01-package-distribution.md`
- Modify: `docs/roadmap/STATUS.md`, `docs/roadmap/roadmap.manifest.yaml`, `docs/roadmap/releases.md`
- Modify: `docs/roadmap/backlog.md`
- Modify: `CHANGELOG.md` (root)
- Create: `docs/decisions/0005-native-installer-managed-node.md`
- Modify: `docs/roadmap/capability-02-cli-runtime.md` (remove stale `cli-auto.md` ref)
- Test: `pnpm docs:validate`

**Interfaces:**
- Consumes: everything shipped in Tasks 1–11.
- Produces: accurate, non-misleading docs + roadmap reflecting shipped reality.

- [ ] **Step 1: Update `docs/how-to/installation.md`**

- Add "native installer (recommended)" as the lead (managed-Node, single command, no Node prerequisite).
- Full matrix: native / npm / pnpm / yarn / bun / npx / Homebrew / Scoop / Windows (PowerShell `irm|iex`).
- "What you're installing": managed-Node, NOT single binary; native deps still prebuilt.
- Windows: install.ps1 is the primary path; drop "must use Git Bash/MSYS2/WSL".
- Update "currently resolves to" → real versions (1.6.0).
- Add `noir install`/`noir migrate` + `noir update` sections.
- Add the trust story: pinned installers, SHA256SUMS, attestation, `gh attestation verify`.

- [ ] **Step 2: Update getting-started + README + reference**

- `docs/getting-started.md`: post-install walkthrough references native first; `noir doctor` install row.
- `README.md`: quick-start uses the native installer as recommended; note Homebrew/Scoop/Windows paths.
- `docs/reference/cli.md`: add `install`, `migrate`, `update` commands.
- `docs/reference/config.md`: add `update:` block schema.
- `docs/how-to/releasing.md` + `packaging.md`: release flow now generates checksums/attestation/pinned installers; Homebrew + Scoop release steps.

- [ ] **Step 3: Update roadmap + records**

- `docs/roadmap/capability-01-package-distribution.md`: status → native installer/self-update shipped; move "Gap" items to shipped; update acceptance criteria (DONE-when now MET); new file references.
- `docs/roadmap/STATUS.md`: C1 → "Partial — core + native installer + self-update shipped"; active capability/slice note.
- `docs/roadmap/roadmap.manifest.yaml`: sync with STATUS.md (pattern).
- `docs/roadmap/releases.md`: version targets + narrative for the new work.
- `docs/roadmap/backlog.md`: move shipped items to "History of resolutions" (install.ps1, Scoop, Homebrew, noir update, migrate, checksum/attestation/pinned installer).
- `CHANGELOG.md` (root): new entry under Unreleased/next.
- Create `docs/decisions/0005-native-installer-managed-node.md` (Context / Decision / Consequences): native installer = managed-Node, not single binary (research-verified); Windows = PowerShell + Scoop; winget/Chocolatey deferred; commits local on develop; publish separate phase.

- [ ] **Step 4: Fix stale ref in capability-02**

`docs/roadmap/capability-02-cli-runtime.md`: remove `docs/reference/cli-auto.md` from References (it was removed; single source is `cli.md`).

- [ ] **Step 5: Validate docs**

Run: `pnpm docs:validate`
Expected: PASS (no broken links, no stale version refs, registry integrity ok).

- [ ] **Step 6: Commit**

```bash
git add docs/ docs/decisions/0005-native-installer-managed-node.md CHANGELOG.md
git commit -m "docs: C1 native installer + migration + self-update — full docs sync"
```

---

### Task 13: Full-gate validation + local release check

**Files:** none (validation only).

- [ ] **Step 1: Run the full gate**

Run: `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate`
Expected: all five green.

- [ ] **Step 2: Verify all commits are local on `develop`**

Run: `git status` (clean) + `git log --oneline develop..origin/develop` (should show only the local commits, not pushed).

- [ ] **Step 3: Final report**

Summarize: what shipped, the docs updated, the CI matrix + smoke test, and that publish is deferred to a separate phase.

---

## Self-Review

### Spec coverage
- P1 (managed-Node layout + shim) → Tasks 1, 5, 9.
- P2 (`noir install`/`migrate`, detection, safety, banner) → Tasks 4, 5, 8, 11.
- P3 (`noir update`, async check, doctor row, install.json) → Tasks 2, 3, 6, 7.
- P4 (install.ps1 + Scoop + Homebrew + docs) → Tasks 9, 12.
- P5 (pinned installers + SHA256SUMS + attestation + CI matrix + atomic writes) → Tasks 1 (atomic), 10, 12.
- Acceptance criteria → covered by the 13 tasks; each has a test/verify step.
- Global constraints → enforced per task (local commits, offline tests, no auto-uninstall, version-assert, atomic writes, doctor ok/warn).

### Placeholder scan
- No "TBD"/"TODO"/"implement later". The two `REPLACE_WITH_REAL_SHA256` markers are intentional placeholders that Task 10/12 fills at release time (they cannot be known at plan time — real hashes come from the actual published tarball).

### Type consistency
- `InstallMethod`, `InstallRecord`, `UpdateCache`, `UpdateConfigLike`, `DetectResult`, `MigrationPlan`, `InstallCheckOutcome`, `UpdateTarget` all defined in the producing task and consumed by later tasks with matching signatures.
- `writeInstallRecord`/`readInstallRecord`/`atomicWriteFile` (Task 1) used consistently in Tasks 4–8.
- `installManagedNode` (Task 5) reused by Task 6 (`update`).
- `shouldCheckForUpdate`/`latestVersionFromCache`/`fetchLatestVersion` (Task 3) used in Task 6/7.
- Per-channel cache change in Task 11 updates `latestVersionFromCache` signature — Task 7's doctor uses `latestVersionFromCache(cache, 'latest')`, still valid after the change (Task 11 keeps the channel arg).
