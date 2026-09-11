# Daemon Hardening + Init Completeness + `.noir/.env` Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the daemon's single global record (which can put two writers on one DB), make `.noir/.env` the real, precedence-winning, auto-created home for project-scoped configuration, and make `noir init --upgrade` backfill what the manifest grew — all in one release.

**Architecture:** Seven independent slices that ship together (spec §19). A–D rework the daemon runtime; E/E4 rework the scaffold manifest and the upgrade engine; F inverts the env-file precedence contract and consolidates the doctrine across 9 skills and 14 docs; G fixes `noir run`'s credential diagnostics. Each slice is revertible on its own; F + F-docs are one release unit (behaviour + its documentation).

**Tech Stack:** TypeScript (ESM), pnpm workspaces, tsup, vitest, zod, better-sqlite3, `@modelcontextprotocol/{client,node,server}`, biome.

**Spec:** [`docs/internal/specs/2026-09-11-daemon-hardening-init-completeness-design.md`](../specs/2026-09-11-daemon-hardening-init-completeness-design.md) — read it alongside this plan; the plan argues from it and does not restate its rationale.

## Global Constraints

- **Full gate, in this order, before any "done" claim:** `pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm docs:validate`. All five must be green.
- **Offline and free.** No test may need a network call or an API key. Every new test runs in a tmp HOME via `NOIR_DAEMON_DIR` / `NOIR_WORKSPACE_DIR`-style env seams.
- **Commits stay local.** Commit per scope on `develop`. **Do not push** without explicit user approval. Conventional Commits, scope per package (`feat(daemon): …`, `fix(cli): …`, `docs: …`).
- **Never print a secret value.** Every diagnostic added names variables and files only. Existing contract: `doctor.ts:329` "names only, never values".
- **`claude` is the regression anchor.** A bare `noir init` must stay byte-identical for every manifest entry that exists today. The only permitted content change is `env.example.tmpl` (E1), which has its own assertion.
- **The daemon is the single writer.** No change may open the store for writing in a second process.
- **Generated docs.** `docs/reference/{config,cli,mcp-tools}.md` are written whole-file by `scripts/docs-generate.mjs`. Editing the `.md` is a no-op after the next `pnpm docs:generate` — edit the generator.
- **`skipIfExists` never modifies an existing file.** This invariant is what makes Task 10 safe.
- **Version bump:** `CURRENT_SCAFFOLD_VERSION` `1.0.0 → 1.1.0` (Task 11). Package version bump happens only in the release task (Task 20), not per-slice.

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `packages/daemon/src/project-record.ts` | Per-project daemon record read/write/clear/list — mirrors `workspace-record.ts` |
| `packages/daemon/src/migrate-legacy-record.ts` | One-shot retirement of `~/.noir/daemon.json` |
| `packages/core/src/git-tracked.ts` | Bounded, non-throwing `isGitTracked(root, relPath)` |
| `packages/cli/src/commands/env.ts` | `noir env` — resolved keys, winning source, shadowing; never values |
| `packages/create/templates/noir-readme.md.tmpl` | The `.noir/README.md` map |
| `packages/create/templates/config.env.tmpl` | Body for the created `.noir/.env` (all-comment) |
| `docs/how-to/configure-env.md` | The missing canonical how-to (spec §18.1) |
| `docs/decisions/0010-per-project-daemon-records-and-http-auth.md` | ADR-0010 |
| `docs/decisions/0011-noir-env-precedence-and-doctrine.md` | ADR-0011 |

**Modified — daemon runtime (A–D)**

| Path | Change |
|---|---|
| `packages/daemon/src/lifecycle.ts` | Keep legacy helpers; re-export the project-record module; add `NOIR_DAEMON_DIR` |
| `packages/daemon/src/http.ts` | Write the project record; accept `port`; token enforcement on `/mcp` |
| `packages/daemon/src/ensure.ts` | Per-project lookup; delete the `wrongProject` branch; add `port`; legacy retirement |
| `packages/daemon/src/spawn.ts` | Poll the per-project record |
| `packages/daemon/src/workspace-http.ts` | Workspace token |
| `packages/daemon/src/index.ts` | Export the new module + `NOIR_DAEMON_DIR` |
| `packages/cli/src/daemon-client.ts` | `probeDaemon` resolves the project first; send the token header; connect-first |
| `packages/cli/src/commands/daemon.ts` | Per-project stop/status; remove the guards; `--all`; `token` subcommand |
| `packages/cli/src/commands/doctor.ts` | Provenance rows; integration rows |

**Modified — scaffold + env (E, E4, F)**

| Path | Change |
|---|---|
| `packages/create/src/manifest.ts` | `.noir/.env` entry; `.noir/README.md` entry; `env.example.tmpl` unchanged in mode |
| `packages/create/src/scaffold.ts` | `--upgrade` emits every mode |
| `packages/create/src/scaffold-version.ts` | `CURRENT_SCAFFOLD_VERSION = '1.1.0'` |
| `packages/create/src/migrations/index.ts` | Real `1.0.0 → 1.1.0` entry |
| `packages/create/templates/env.example.tmpl` | Doctrine header + full variable set (E1) |
| `packages/create/templates/config.yml.tmpl` | Pointer comment to `.env` |
| `packages/core/src/env-file.ts` | Precedence inversion; `sources`; tracked refusal; `NOIR_DAEMON_DIR` denylist |
| `packages/core/src/ignore-manager.ts` | Drop the three vestigial entries |
| `packages/cli/src/commands/run.ts` | Broadened auth branch; uninitialized notice |
| `packages/cli/src/bin.ts` | Register `noir env` |
| `scripts/docs-generate.mjs` | Precedence block + Secrets policy source text |
| 9 `SKILL.md` / reference files | Doctrine (spec §12.5) |
| 8 hand-authored docs | Doctrine (spec §12.5, §18) |

---

## Slice A — Per-project daemon records

### Task 1: The project-record module

**Files:**
- Create: `packages/daemon/src/project-record.ts`
- Create: `packages/daemon/test/project-record.test.ts`
- Modify: `packages/daemon/src/index.ts`

**Interfaces:**
- Consumes: `atomicWriteFile` from `@noir-ai/core`.
- Produces: `ProjectDaemonRecord`, `NOIR_DAEMON_DIR_ENV`, `projectRecordPath(projectId)`, `readProjectDaemonRecord(projectId)`, `writeProjectDaemonRecord(projectId, rec)`, `clearProjectDaemonRecord(projectId)`, `listProjectDaemonRecords()`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/test/project-record.test.ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-project-record-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

const {
  projectRecordPath, readProjectDaemonRecord, writeProjectDaemonRecord,
  clearProjectDaemonRecord, listProjectDaemonRecords,
} = await import('../src/project-record.js');

describe('project-record', () => {
  beforeEach(() => { mkdirSync(tmpRoot, { recursive: true }); });

  it('honors the NOIR_DAEMON_DIR override', () => {
    expect(projectRecordPath('p1')).toBe(join(tmpRoot, 'p1.json'));
  });

  it('round-trips a record per project', () => {
    writeProjectDaemonRecord('p1', { pid: 1, port: 5001, startedAt: 7, projectId: 'p1' });
    writeProjectDaemonRecord('p2', { pid: 2, port: 5002, startedAt: 8, projectId: 'p2' });
    expect(readProjectDaemonRecord('p1')?.port).toBe(5001);
    expect(readProjectDaemonRecord('p2')?.port).toBe(5002);
  });

  it('is isolated: clearing p1 leaves p2 intact', () => {
    writeProjectDaemonRecord('p1', { pid: 1, port: 5001, startedAt: 7, projectId: 'p1' });
    writeProjectDaemonRecord('p2', { pid: 2, port: 5002, startedAt: 8, projectId: 'p2' });
    clearProjectDaemonRecord('p1');
    expect(readProjectDaemonRecord('p1')).toBeNull();
    expect(readProjectDaemonRecord('p2')?.pid).toBe(2);
  });

  it('returns null for absent or malformed records', () => {
    expect(readProjectDaemonRecord('nope')).toBeNull();
    writeFileSync(projectRecordPath('bad'), '{not json');
    expect(readProjectDaemonRecord('bad')).toBeNull();
  });

  it('lists every project record on the machine', () => {
    writeProjectDaemonRecord('p1', { pid: 1, port: 5001, startedAt: 7, projectId: 'p1' });
    writeProjectDaemonRecord('p2', { pid: 2, port: 5002, startedAt: 8, projectId: 'p2' });
    expect(listProjectDaemonRecords().map((r) => r.projectId).sort()).toEqual(['p1', 'p2']);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/daemon/test/project-record.test.ts`
Expected: FAIL — cannot resolve `../src/project-record.js`.

- [ ] **Step 3: Implement the module**

```ts
// packages/daemon/src/project-record.ts
// Per-project daemon record — the project-scoped counterpart to
// `~/.noir/daemon.json`. Mirrors `workspace-record.ts`: one file per identity,
// so no code path can read, adopt, or clear another project's record.
// That is what removes the `wrongProject` guards in ensure.ts / commands/daemon.ts
// (spec §4.3) — the bug is structural, so the fix is structural.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, noirHome } from '@noir-ai/core';

/** Directory holding per-project records. `NOIR_DAEMON_DIR` isolates tests. */
export const NOIR_DAEMON_DIR_ENV = 'NOIR_DAEMON_DIR';

export interface ProjectDaemonRecord {
  pid: number;
  port: number;
  startedAt: number;
  /** Ownership: `foreground` (this CLI process) or `detached` (via --detach). */
  mode?: 'foreground' | 'detached';
  /** The identity this record belongs to (cf. `workspace` on a workspace record). */
  projectId: string;
}

export function projectRecordDir(): string {
  return process.env[NOIR_DAEMON_DIR_ENV]?.trim() || join(noirHome(), 'daemons');
}

export function projectRecordPath(projectId: string): string {
  return join(projectRecordDir(), `${projectId}.json`);
}

export function readProjectDaemonRecord(projectId: string): ProjectDaemonRecord | null {
  try {
    const rec = JSON.parse(readFileSync(projectRecordPath(projectId), 'utf8')) as ProjectDaemonRecord;
    if (typeof rec.pid === 'number' && typeof rec.port === 'number') return rec;
    return null;
  } catch {
    return null;
  }
}

export function writeProjectDaemonRecord(projectId: string, rec: ProjectDaemonRecord): void {
  mkdirSync(projectRecordDir(), { recursive: true });
  atomicWriteFile(projectRecordPath(projectId), `${JSON.stringify(rec)}\n`);
}

export function clearProjectDaemonRecord(projectId: string): void {
  const p = projectRecordPath(projectId);
  if (existsSync(p)) rmSync(p, { force: true });
}

/** Every project record on this machine — for `noir daemon status --all` + doctor. */
export function listProjectDaemonRecords(): Array<{ projectId: string; rec: ProjectDaemonRecord }> {
  let names: string[];
  try {
    names = readdirSync(projectRecordDir());
  } catch {
    return []; // dir absent — no daemon has ever run
  }
  const out: Array<{ projectId: string; rec: ProjectDaemonRecord }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const projectId = name.slice(0, -'.json'.length);
    const rec = readProjectDaemonRecord(projectId);
    if (rec) out.push({ projectId, rec });
  }
  return out;
}
```

- [ ] **Step 4: Export from the package index**

Add to `packages/daemon/src/index.ts`, beside the existing `lifecycle.js` export block:

```ts
export {
  clearProjectDaemonRecord,
  listProjectDaemonRecords,
  NOIR_DAEMON_DIR_ENV,
  type ProjectDaemonRecord,
  projectRecordDir,
  projectRecordPath,
  readProjectDaemonRecord,
  writeProjectDaemonRecord,
} from './project-record.js';
```

- [ ] **Step 5: Run the test and the package suite**

Run: `pnpm vitest run packages/daemon/test/project-record.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/project-record.ts packages/daemon/test/project-record.test.ts packages/daemon/src/index.ts
git commit -m "feat(daemon): add per-project daemon record module

One record file per ProjectId under ~/.noir/daemons/, mirroring
workspace-record.ts. Structural prerequisite for removing the three
wrongProject guards (spec 4.3).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Migrate every consumer and delete the `wrongProject` guards

**Files:**
- Modify: `packages/daemon/src/http.ts:179-204`
- Modify: `packages/daemon/src/spawn.ts`
- Modify: `packages/daemon/src/ensure.ts:51-93`
- Modify: `packages/cli/src/daemon-client.ts:150-223`
- Modify: `packages/cli/src/commands/daemon.ts:303-374` (stop), `:388-449` (status), `:201` (detach guard)
- Modify: `packages/cli/src/commands/doctor.ts:210`
- Test: `packages/daemon/test/ensure.test.ts`, `packages/cli/test/daemon.test.ts`

**Interfaces:**
- Consumes: Task 1's module.
- Produces: `ensureDaemonRunning({ project, idleTimeoutSec, port? })`; `probeDaemon` unchanged in signature but resolving the project id **first**.

- [ ] **Step 1: Write the failing isolation test**

```ts
// packages/daemon/test/project-isolation.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-isolation-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

const { writeProjectDaemonRecord, readProjectDaemonRecord } = await import('../src/project-record.js');
const { ensureDaemonRunning } = await import('../src/ensure.js');

const projA = { id: 'proj-a', root: tmpRoot, config: {} } as never;
const projB = { id: 'proj-b', root: tmpRoot, config: {} } as never;

describe('cross-project daemon isolation', () => {
  it('project B activity never deletes project A\'s recorded daemon', async () => {
    // A has a live-looking record that is deliberately NOT healthy (dead pid),
    // so ensureDaemonRunning for B must not clear A's record on its behalf.
    writeProjectDaemonRecord('proj-a', { pid: 2 ** 30, port: 1, startedAt: 1, projectId: 'proj-a' });
    try { await ensureDaemonRunning({ project: projB, idleTimeoutSec: 900 }); } catch { /* start may fail in CI */ }
    // THE REGRESSION: the old global-record code cleared a foreign record here.
    expect(readProjectDaemonRecord('proj-a')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/daemon/test/project-isolation.test.ts`
Expected: FAIL — `ensureDaemonRunning` still reads the global record and clears it.

- [ ] **Step 3: Rewrite `http.ts`'s record write + shutdown**

Replace the `rec` block and the shutdown clear (`http.ts:179-204`):

```ts
  writeProjectDaemonRecord(opts.project.id, {
    pid,
    port,
    startedAt,
    mode: process.env[DAEMON_MODE_ENV] === 'detached' ? 'detached' : 'foreground',
    projectId: opts.project.id,
  });

  async function shutdown(): Promise<void> {
    if (idleTimer) { clearInterval(idleTimer); idleTimer = undefined; }
    await new Promise<void>((r) => httpServer.close(() => r()));
    await daemonStore?.store.close().catch(() => undefined);
    // Only clear OUR record (pid match) — a slow-dying predecessor or a
    // restarting daemon must not have its record wiped by this one.
    const rec = readProjectDaemonRecord(opts.project.id);
    if (rec && rec.pid === pid) clearProjectDaemonRecord(opts.project.id);
  }
```

Swap the import: drop `clearDaemonRecord, readDaemonRecord, writeDaemonRecord` from `./lifecycle.js`, keep `DAEMON_MODE_ENV, type DaemonRecord`, and add the four project-record functions from `./project-record.js`. `DaemonRecord` is still used by `spawn.ts`; keep the type exported from `lifecycle.ts` until Task 3 removes its last user.

- [ ] **Step 4: Rewrite `ensure.ts` — the guards disappear**

```ts
export async function ensureDaemonRunning(opts: {
  project: ProjectInfo;
  idleTimeoutSec: number;
  port?: number;
}): Promise<EnsureResult> {
  const { project } = opts;
  await retireLegacyDaemonRecord(); // Task 3; no-op once the legacy file is gone

  // Scoped read: this can only ever return THIS project's record, so there is
  // no foreign record to detect, clear, or refuse. The three wrongProject
  // guards are gone because the condition they guarded is unrepresentable.
  const rec = readProjectDaemonRecord(project.id);
  if (rec && pidAlive(rec.pid) && (await isHealthy(rec.port, rec.pid, project.id))) {
    return { port: rec.port, url: `http://127.0.0.1:${rec.port}/mcp`, started: false, stop: async () => {} };
  }
  if (rec) clearProjectDaemonRecord(project.id); // stale: pid dead or /health failed

  const running = await startHttpServer({
    project: opts.project,
    idleTimeoutSec: opts.idleTimeoutSec,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  });
  return { port: running.port, url: `http://127.0.0.1:${running.port}/mcp`, started: true, stop: running.stop };
}
```

- [ ] **Step 5: Reorder `probeDaemon` and swap its record read**

In `packages/cli/src/daemon-client.ts`, move the `expectedProject` resolution **above** the record read, then read the scoped record:

```ts
export async function probeDaemon(opts: DaemonClientOptions = {}): Promise<DaemonProbe> {
  // Resolve the project FIRST — with per-project records the ProjectId IS the
  // lookup key, so the record cannot be read before it is known.
  const expectedProject =
    opts.project?.id ??
    (() => { try { return loadProjectInfo(process.cwd()).id; } catch { return undefined; } })();
  if (expectedProject === undefined) {
    if (opts.verbose) process.stderr.write('noir: daemon probe: no project (uninitialized)\n');
    return { running: false };
  }
  const rec = readProjectDaemonRecord(expectedProject);
  if (!rec) { /* …unchanged from here, minus the projectOk cross-check… */ }
```

Delete the now-impossible `projectOk` comparison (`daemon-client.ts:198-200`) and drop the wrong-project verbose branch (`:206-207`).

- [ ] **Step 6: Delete the guards in `commands/daemon.ts`**

- `daemonStop`: delete `resolveCallerProjectId`/`wrongProject` (`:322-324`, `:331`, `:344`) and call `clearProjectDaemonRecord(callerProject)` unconditionally when the caller project is known; when it is unknown, report honestly rather than guessing.
- `daemonStatus`: delete the cross-project exit-4 block (`:397-408`) and read `readProjectDaemonRecord(callerProject)`.
- The `--detach` double-spawn guard (`:201`) reads the scoped record.

- [ ] **Step 7: Run the affected suites**

Run: `pnpm vitest run packages/daemon packages/cli --testTimeout=40000`
Expected: PASS. Existing tests that set `NOIR_DAEMON_JSON` must be migrated to `NOIR_DAEMON_DIR` in the same commit.

- [ ] **Step 8: Commit**

```bash
git add -A packages/daemon packages/cli
git commit -m "refactor(daemon): key the daemon record by ProjectId

Removes the three wrongProject guards in ensure.ts and commands/daemon.ts.
They compensated for a record with no identity; scoping the record by
ProjectId makes a foreign record unrepresentable, so the guards and the
destructive clear they guarded both disappear (spec 4.3).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: One-shot legacy record retirement

**Files:**
- Create: `packages/daemon/src/migrate-legacy-record.ts`
- Test: `packages/daemon/test/migrate-legacy-record.test.ts`

**Interfaces:**
- Produces: `retireLegacyDaemonRecord(): Promise<void>` — resolves on success or no-op; **rejects** when a live legacy daemon refuses to exit (spec §4.5).

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/test/migrate-legacy-record.test.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-legacy-'));
const legacy = join(tmpRoot, 'daemon.json');
process.env.NOIR_DAEMON_JSON = legacy;

const { retireLegacyDaemonRecord } = await import('../src/migrate-legacy-record.js');

describe('retireLegacyDaemonRecord', () => {
  it('is a no-op when no legacy record exists', async () => {
    await expect(retireLegacyDaemonRecord()).resolves.toBeUndefined();
  });

  it('removes a legacy record whose pid is dead', async () => {
    writeFileSync(legacy, JSON.stringify({ pid: 2 ** 30, port: 1, startedAt: 1 }));
    await retireLegacyDaemonRecord();
    expect(existsSync(legacy)).toBe(false);
  });

  it('SIGTERMs a live legacy daemon, waits, then removes the file', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(legacy, JSON.stringify({ pid: child.pid, port: 1, startedAt: 1 }));
      await retireLegacyDaemonRecord();
      expect(existsSync(legacy)).toBe(false);
    } finally { child.kill('SIGKILL'); }
  });

  it('refuses (rejects) and KEEPS the file when the daemon ignores SIGTERM', async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(legacy, JSON.stringify({ pid: child.pid, port: 1, startedAt: 1 }));
      await expect(retireLegacyDaemonRecord({ exitTimeoutMs: 300 })).rejects.toThrow(/did not exit/);
      expect(existsSync(legacy)).toBe(true); // left for the next attempt
    } finally { child.kill('SIGKILL'); }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/daemon/test/migrate-legacy-record.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement it**

```ts
// packages/daemon/src/migrate-legacy-record.ts
// One-shot retirement of the pre-1.14 single global record. This is the ONLY
// code that reads `~/.noir/daemon.json`; once it has run the file is gone and
// no code path reads the legacy shape again. Without it, a daemon from the
// previous version keeps a write handle on the project DB while the new version
// opens a second one (spec 4.5).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { noirHome } from '@noir-ai/core';
import { pidAlive } from './lifecycle.js';

const DEFAULT_EXIT_TIMEOUT_MS = 5_000;
const POLL_MS = 50;

function legacyPath(): string {
  return process.env.NOIR_DAEMON_JSON ?? join(noirHome(), 'daemon.json');
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return !pidAlive(pid);
}

export async function retireLegacyDaemonRecord(
  opts: { exitTimeoutMs?: number } = {},
): Promise<void> {
  const path = legacyPath();
  if (!existsSync(path)) return; // no-op forever after the first success

  let rec: { pid?: unknown } | null = null;
  try { rec = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }; } catch { rec = null; }

  const pid = typeof rec?.pid === 'number' ? rec.pid : undefined;
  if (pid !== undefined && pidAlive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone — fall through */ }
    const exited = await waitForExit(pid, opts.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS);
    if (!exited) {
      // Do NOT remove the file and do NOT let the caller start a second daemon:
      // the legacy daemon still holds a write handle on this project's store.
      throw new Error(
        `a daemon from a previous Noir version (pid ${pid}) did not exit within ` +
          `${opts.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS}ms and still holds this project's ` +
          `store open — stop it with \`kill ${pid}\` and re-run.`,
      );
    }
  }
  rmSync(path, { force: true });
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm vitest run packages/daemon/test/migrate-legacy-record.test.ts --testTimeout=30000`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/migrate-legacy-record.ts packages/daemon/test/migrate-legacy-record.test.ts
git commit -m "feat(daemon): retire the legacy global daemon record once

Reads ~/.noir/daemon.json exactly once, SIGTERMs a live legacy daemon, then
deletes it. Refuses to proceed if the daemon will not exit, so a second
writer can never be started against a held store (spec 4.5).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Slice B — `daemon.port`

### Task 4: Honour `daemon.port` with an honest fallback

**Files:**
- Modify: `packages/core/src/config.ts:24-30`
- Modify: `packages/daemon/src/http.ts:170-177`
- Modify: `packages/cli/src/daemon-client.ts` (`resolveDaemon`), `packages/cli/src/commands/daemon.ts`
- Test: `packages/daemon/test/port.test.ts`

**Interfaces:**
- Consumes: `ensureDaemonRunning({ project, idleTimeoutSec, port })` from Task 2.
- Produces: on `EADDRINUSE` the daemon binds ephemeral and the record names the **actual** port.

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/test/port.test.ts
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-port-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

const { startHttpServer } = await import('../src/http.js');
const { readProjectDaemonRecord } = await import('../src/project-record.js');
const project = { id: 'port-proj', root: tmpRoot, config: {}, name: 'p' } as never;

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const s of stops.splice(0)) await s().catch(() => {}); });

describe('daemon.port', () => {
  it('binds the configured port when free, and records it', async () => {
    const blocker = createServer(); await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const free = (blocker.address() as { port: number }).port; await new Promise<void>((r) => blocker.close(() => r()));
    const d = await startHttpServer({ project, idleTimeoutSec: 900, port: free });
    stops.push(d.stop);
    expect(d.port).toBe(free);
    expect(readProjectDaemonRecord('port-proj')?.port).toBe(free);
  });

  it('falls back to ephemeral on EADDRINUSE and records the ACTUAL port', async () => {
    const blocker = createServer(); await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const d = await startHttpServer({ project, idleTimeoutSec: 900, port: taken });
      stops.push(d.stop);
      expect(d.port).not.toBe(taken);
      expect(d.port).toBeGreaterThan(0);
      expect(readProjectDaemonRecord('port-proj')?.port).toBe(d.port); // truthful record
    } finally { await new Promise<void>((r) => blocker.close(() => r())); }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/daemon/test/port.test.ts`
Expected: the second test FAILS — today `listen()` rejects with `EADDRINUSE`.

- [ ] **Step 3: Implement the fallback**

Replace the listen block (`http.ts:170-177`):

```ts
  // `daemon.port` is a PREFERENCE, not a demand: two projects may legitimately
  // configure the same port, and failing the command would be worse than
  // degrading. On EADDRINUSE we retry ephemeral and warn — and the record below
  // always carries the port actually bound, so the record never lies.
  async function listenOn(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      httpServer.once('error', onError);
      httpServer.listen(port, '127.0.0.1', () => {
        httpServer.removeListener('error', onError);
        const addr = httpServer.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  }

  let port: number;
  try {
    port = await listenOn(opts.port ?? 0);
  } catch (err) {
    if (opts.port !== undefined && opts.port !== 0 && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      process.stderr.write(
        `noir: port ${opts.port} is in use — falling back to an ephemeral port.\n`,
      );
      port = await listenOn(0);
    } else throw err;
  }
```

- [ ] **Step 4: Update the config description and thread the port**

`packages/core/src/config.ts` — drop the "not yet wired" clause:

```ts
      port: z
        .number()
        .int()
        .min(0)
        .max(65535)
        .optional()
        .describe('Preferred daemon HTTP port (a preference: if taken, an ephemeral port is used)'),
```

In `resolveDaemon` (`daemon-client.ts`) pass `port: project.config.daemon.port`, and in `commands/daemon.ts` do the same on every `ensureDaemonRunning` call (`:170`, `:246`).

- [ ] **Step 5: Run the suite**

Run: `pnpm vitest run packages/daemon packages/cli --testTimeout=40000`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/daemon packages/cli
git commit -m "feat(daemon): honour daemon.port with an ephemeral fallback

The config was parsed and validated but never consumed. It is now a
preference: a taken port degrades to ephemeral with a warning, and the
record always carries the port actually bound (spec 5.2).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Slice C — HTTP auth token

### Task 5: Token generation, `/mcp` enforcement, CLI header

**Files:**
- Create: `packages/daemon/src/token.ts`
- Modify: `packages/daemon/src/http.ts` (route guard)
- Modify: `packages/cli/src/daemon-client.ts` (`connectClient` → send `Authorization`)
- Test: `packages/daemon/test/token.test.ts`

**Interfaces:**
- Produces: `writeDaemonToken(scopeKey, token)`, `readDaemonToken(scopeKey)`, `tokenPath(scopeKey)`, `scopeKeyForProject(projectId)`; `/mcp` returns 401 without a matching bearer.

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/test/token.test.ts
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-token-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

const { writeDaemonToken, readDaemonToken } = await import('../src/token.js');

describe('daemon token', () => {
  it('writes a 0600 token and reads it back', () => {
    writeDaemonToken('proj-x', 'abc123');
    expect(readDaemonToken('proj-x')).toBe('abc123');
    expect(statSync(join(tmpRoot, 'proj-x.token')).mode & 0o777).toBe(0o600);
  });

  it('generates a fresh token per write', async () => {
    const { generateToken } = await import('../src/token.js');
    expect(generateToken()).not.toBe(generateToken());
    expect(generateToken().length).toBeGreaterThanOrEqual(32);
  });
});
```

Plus an HTTP-level test in `packages/daemon/test/http.test.ts`: `GET /health` without a token → 200; `POST /mcp` without `Authorization` → 401; with the correct bearer → not 401.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/daemon/test/token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the token module**

```ts
// packages/daemon/src/token.ts
// Shared secret between a daemon and its clients. Regenerated on every daemon
// start, so a token never outlives the process that issued it. 0600 because the
// file is a credential the moment it exists (spec 6.1).
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '@noir-ai/core';
import { projectRecordDir } from './project-record.js';

/** 32 bytes → 43 base64url chars. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenPath(scopeKey: string): string {
  return join(projectRecordDir(), `${scopeKey}.token`);
}

export function writeDaemonToken(scopeKey: string, token: string): void {
  atomicWriteFile(tokenPath(scopeKey), `${token}\n`, { mode: 0o600 });
}

export function readDaemonToken(scopeKey: string): string | null {
  try { return readFileSync(tokenPath(scopeKey), 'utf8').trim() || null; } catch { return null; }
}

export function clearDaemonToken(scopeKey: string): void {
  rmSync(tokenPath(scopeKey), { force: true });
}

/** Constant-time compare, so a token check is not a timing oracle. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 3b: Extend `atomicWriteFile` with an optional `mode` — REQUIRED**

**Verified:** the current signature is `atomicWriteFile(path: string, data: string): void`
(`packages/core/src/install-method.ts:117`). It writes the temp file with umask (0o644) and only
*restores* a mode that already existed. It has **no `mode` parameter**, so the call above does not
compile and, more importantly, a `chmod` after the rename would leave a window in which a
credential file exists world-readable.

Apply the mode to the **temp file, before the rename**, so the final path is never readable by
others:

```ts
export interface AtomicWriteOptions {
  /** Mode applied to the temp file before the rename, on EVERY write that
   *  requests it (so the destination never exists with a laxer mode). When set,
   *  the post-rename prevMode restore is skipped — the caller's mode is
   *  authoritative. */
  mode?: number;
}

export function atomicWriteFile(path: string, data: string, opts: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  let prevMode: number | undefined;
  try { prevMode = statSync(path).mode & 0o777; } catch { /* absent on first write */ }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  // `mode` on writeFileSync is masked by umask; 0o600 has no group/other bits,
  // so it survives any umask. On Windows the argument is ignored — the
  // permission model there is ACL-based, so tests must not assert 0600 on win32.
  writeFileSync(tmp, data, opts.mode !== undefined
    ? { encoding: 'utf8', mode: opts.mode }
    : 'utf8');
  renameSync(tmp, path);
  if (opts.mode === undefined && prevMode !== undefined) {
    try { chmodSync(path, prevMode); } catch { /* best-effort */ }
  }
}
```

Add to the test in Step 1: a **Windows guard** — `it.skipIf(process.platform === 'win32')(...)` around
the 0600 assertion, since `mode` is a no-op on Windows.

- [ ] **Step 3c: Confirm the existing consumers still compile**

Run: `pnpm typecheck`
Expected: PASS — the new parameter is optional, so every existing call site is unaffected.

- [ ] **Step 4: Enforce on `/mcp` only**

In `http.ts`, after the host/origin validation and before the `/mcp` branch:

```ts
    // Auth on the HTTP transport only (spec 6.1). /health stays token-free —
    // the probe depends on it and its body carries no secret — but it remains
    // host/origin validated above.
    if (req.url === '/mcp') {
      const provided = req.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (!tokenMatches(daemonToken, provided)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'unauthorized: this daemon requires a token. Set it via the host MCP `headersHelper` (run `noir daemon token`), or use the stdio transport.',
        }));
        return;
      }
    }
```

Generate `daemonToken` once per lifecycle next to `pid`, write it, and clear it in `shutdown()`.

- [ ] **Step 5: Send the header from the CLI**

```ts
// daemon-client.ts
async function connectClient(client: Client, url: string, opts: DaemonClientOptions, scopeKey: string): Promise<void> {
  const token = readDaemonToken(scopeKey);
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), {
      // Verified present: StreamableHTTPClientTransportOptions.requestInit?: RequestInit
      ...(token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    }));
  } catch (err) { failDaemonDown(opts, err); }
}
```

- [ ] **Step 6: Assert the stdio path is untouched**

Add to `packages/cli/test/gate1-stdio.test.ts`: a stdio `mcp serve` session succeeds with no token file present, proving stdio carries no token requirement.

- [ ] **Step 7: Run the suites**

Run: `pnpm vitest run packages/daemon packages/cli --testTimeout=40000`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/daemon packages/cli
git commit -m "feat(daemon): require a bearer token on the HTTP transport

stdio is untouched (no network surface, and the host header-forwarding
bugs make a header-delivered token unsafe there). The CLI sends the
header itself; /health stays token-free for the probe (spec 6).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 6: `noir daemon token` + workspace parity

**Files:**
- Modify: `packages/cli/src/bin.ts` (subcommand), `packages/cli/src/commands/daemon.ts`
- Modify: `packages/daemon/src/workspace-http.ts`
- Test: `packages/cli/test/daemon-token.test.ts`

- [ ] **Step 1: Write the failing test**

Assert `noir daemon token` prints the current project's token to **stdout** and nothing else, exits 0, and exits 4 with a clear message when no daemon record exists. Assert `--json` emits `{ok:true,data:{token}}`.

- [ ] **Step 2: Implement the subcommand and workspace token**

Mirror Task 5 in `workspace-http.ts` using the workspace name as the scope key, and add the `token` verb. `headersHelper` support is documentation-only (Task 17) — the command is the deliverable.

- [ ] **Step 3: Run, then commit**

```bash
git commit -m "feat(cli,daemon): add \`noir daemon token\` + workspace transport auth

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Slice D — Connect-triggered activation

### Task 7: Connect-first ordering (project path only)

**Files:**
- Modify: `packages/cli/src/daemon-client.ts` (`withDaemon` / `resolveDaemon`)
- Test: `packages/cli/test/connect-first.test.ts`

**Interfaces:**
- Consumes: Task 4's `daemon.port`; Task 5's token.
- Produces: `withDaemon` connects first and spawns only on `ECONNREFUSED`; **`withWorkspaceDaemon` is unchanged** (ADR-0009 §11).

- [ ] **Step 1: Write the failing test**

Point at a configured `daemon.port` with no daemon running; assert the first call connects, fails, spawns, reconnects and succeeds; assert the retry is bounded (a permanently dead port gives up with `DAEMON_DOWN_HINT`, not a hang).

- [ ] **Step 2: Implement**

```ts
  // Connect-first when a stable address exists (a configured daemon.port).
  // Without one there is no address to probe, so today's ensure-first path is
  // retained — D depends on B (spec 7.1).
  const preferred = project.config.daemon.port;
  if (preferred !== undefined && preferred !== 0) {
    const direct = `http://127.0.0.1:${preferred}/mcp`;
    try {
      await connectClient(probeClient, direct, opts, project.id);
      return { url: direct, stop: async () => {} };
    } catch { /* ECONNREFUSED → fall through to ensure */ }
  }
  const ensured = await ensureDaemonRunning({ project, idleTimeoutSec, ...(preferred !== undefined ? { port: preferred } : {}) });
  return { url: ensured.url, stop: ensured.stop };
```

- [ ] **Step 3: Add the workspace guard test — this is the important one**

```ts
it('withWorkspaceDaemon never auto-starts (ADR-0009 §11)', async () => {
  // A workspace daemon that is down must fail with guidance, not silently start.
  await expect(
    withWorkspaceDaemon(opts, { name: 'ws', projectId: 'p' }, async () => 'unreachable'),
  ).rejects.toThrow(/is not running/);
});
```

- [ ] **Step 4: Run, then commit**

```bash
git commit -m "feat(cli): connect-first daemon activation on the project path

Spawns only on a refused connection when daemon.port gives a stable
address. The workspace path stays probe-only per ADR-0009 11 (spec 7).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Slice E — Init completeness

### Task 8: `.env.example` doctrine, the full variable set, and a real `.noir/.env`

**Files:**
- Modify: `packages/create/templates/env.example.tmpl`
- Create: `packages/create/templates/config.env.tmpl`
- Modify: `packages/create/src/manifest.ts` (add the `.noir/.env` entry)
- Modify: `packages/create/src/writers.ts` (mode support if needed)
- Test: `packages/create/test/env-seed.test.ts`

**Interfaces:**
- Produces: init writes `.noir/.env` (0600, all-comment) and `.noir/.env.example` (doctrine + full set).

- [ ] **Step 1: Write the failing test**

```ts
it('creates .noir/.env at 0600 with no active values', async () => {
  const res = await scaffold({ root, mode: 'init', host: 'claude' });
  expect(res.written).toContain('.noir/.env');
  const mode = statSync(join(root, '.noir/.env')).mode & 0o777;
  expect(mode).toBe(0o600);
  expect(loadNoirEnv(root).overlay).toEqual({}); // nothing active
});

it('documents the doctrine and the full variable set in .env.example', async () => {
  await scaffold({ root, mode: 'init', host: 'claude' });
  const t = readFileSync(join(root, '.noir/.env.example'), 'utf8');
  expect(t).toMatch(/recommended home for project-scoped/);
  expect(t).toMatch(/CLICKUP_API_TOKEN/);
  expect(t).toMatch(/OPENAI_API_KEY/);
  expect(t).toMatch(/NOIR_PROFILE/);
  expect(t).toMatch(/apiKeyEnv/);          // the NAME-not-interpolation note
  expect(t).not.toMatch(/^ANTHROPIC_API_KEY=/m); // never an active value
});
```

- [ ] **Step 2: Implement the templates and the manifest entry**

`config.env.tmpl` header (the doctrine must match spec §12.1 verbatim):

```
# .noir/.env — project-scoped configuration for this repo.
#
# This file is the recommended home for project-scoped configuration and
# secrets. Precedence:
#   1. one-shot            VAR=value noir ...        (this invocation only)
#   2. run profile env     run.profiles.<n>.env      (merges over)
#   3. THIS FILE           .noir/.env                 <- recommended here
#   4. real environment    CI / container / launchd / shell rc
#   5. built-in default
#
# A real environment variable is a FALLBACK: it applies only to keys this file
# leaves unset. A machine-global export therefore cannot shadow a value here.
# Run `noir env` to see which source is winning for each key.
#
# Keep this file private: chmod 600 .noir/.env
# It is gitignored by Noir's managed .gitignore block, and Noir REFUSES to load
# it if it is tracked by git (a cloned repo could redirect credentials).
# Never commit it.
```

Then the commented variable groups (ClickUp, embedder keys, model provider via `apiKeyEnv`, `NOIR_PROFILE`, update kill-switches), closing with a pointer to `docs/reference/environment.md`.

**Plumbing note (verified — do not skip).** `ManifestEntry` (`manifest.ts:53-78`) has **no
permission field**, and `skipIfExists(absPath, content): WriteOutcome` (`writers.ts:229`) takes no
mode. The 0600 must be plumbed explicitly, in three places:

```ts
// 1. manifest.ts — add an optional field to ManifestEntry
  /** Permission for a NEWLY created file (e.g. 0o600 for a credential seed).
   *  Applied only on creation; an existing file's mode is never changed. */
  fileMode?: number;

// 2. manifest.ts — the entry, next to `envExample`
    {
      path: P.env,
      mode: 'skipIfExists',
      template: 'config.env.tmpl',
      fileMode: 0o600,
      description: 'project-scoped env file (gitignored, 0600)',
    },

// 3. writers.ts — thread it through skipIfExists
export function skipIfExists(absPath: string, content: string, fileMode?: number): WriteOutcome {
  if (existsSync(absPath)) return { status: 'skipped', path: absPath };
  atomicWriteFile(absPath, content, fileMode !== undefined ? { mode: fileMode } : {});
  return { status: 'written', path: absPath };
}
```

The orchestrator (`scaffold.ts`) forwards `entry.fileMode` to the `skipIfExists` dispatch, and to
the dry-run predictor (which reports the planned mode without writing).

Add `env: `${NOIR_DIR}/.env`` to the `P` path map. **Both entries coexist** — `.env.example` stays
the committable documentation, `.env` is the working file.

- [ ] **Step 3: Run, then commit**

```bash
git commit -m "feat(create): seed .noir/.env at 0600 and document the doctrine

Init now creates the real env file (all-comment, so behaviour is unchanged)
instead of asking the user to copy the example by hand. The example carries
the full documented variable set and the precedence chain (spec 8).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 9: `.noir/README.md`, ignore cleanup, parity gates

**Files:**
- Create: `packages/create/templates/noir-readme.md.tmpl`
- Modify: `packages/create/src/manifest.ts`, `packages/core/src/ignore-manager.ts`
- Modify: `packages/adapters/test/claude.test.ts`, `packages/create/test/scaffold.test.ts`
- Test: `packages/core/test/ignore-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

- Ignore: assert the managed `.gitignore` block contains `/.noir/.env` and `!/.noir/.env.example`, does **not** contain `/.noir/*.sock`, `/.noir/daemon.pid`, or `/.noir/state/`, and that `/.noir/.env.local` is matched by the `.env.*` glob while `.env.example` is not.
- Manifest: assert `.noir/README.md` is written and lists the runtime directories.
- Parity: update the two gate tests to include the two new files, and assert every **pre-existing** entry's bytes are unchanged.

- [ ] **Step 2: Implement**

Remove the three vestigial entries (`ignore-manager.ts:23-25`). Write the README template: what exists now, what appears later (with the triggering command per directory — `store/` ← daemon, `specs|plans|tasks|intake|clarifications/` ← workflow phases, `audit/` ← integrations, `transcripts/` ← `noir run`), and where to go next.

- [ ] **Step 3: Run the full create + core + adapters suites**

Run: `pnpm vitest run packages/create packages/core packages/adapters`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(create,core): write .noir/README.md + drop vestigial ignore entries

The ignore block named /.noir/*.sock, /.noir/daemon.pid and /.noir/state/ —
paths nothing creates. Daemon records are HOME-scoped, so no replacement
entry is needed (spec 10). The README maps what init produces and what
appears later (spec 9).

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Slice E4 — `--upgrade` backfill

### Task 10: `--upgrade` emits every manifest mode

**Files:**
- Modify: `packages/create/src/scaffold.ts`
- Test: `packages/create/test/upgrade-backfill.test.ts`

**Interfaces:**
- Produces: `--upgrade` creates absent `skipIfExists` entries; never modifies an existing one.

- [ ] **Step 1: Write the failing test — the §1.6 regression test**

```ts
it('backfills a skipIfExists seed added after initialization', async () => {
  // A project stamped 1.0.0 with .noir/.env present and .env.example absent —
  // the maintainer's real shape.
  writeScaffoldVersion(root, '1.0.0');
  writeFileSync(join(root, '.noir', '.env'), 'CLICKUP_API_TOKEN=pk_keepme\n');
  const before = createHash('sha256').update(readFileSync(join(root, '.noir', '.env'))).digest('hex');

  const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });

  expect(existsSync(join(root, '.noir', '.env.example'))).toBe(true); // was absent
  expect(res.written).toContain('.noir/.env.example');
  const after = createHash('sha256').update(readFileSync(join(root, '.noir', '.env'))).digest('hex');
  expect(after).toBe(before); // a user's tokens are NEVER touched
  expect(readScaffoldVersion(root)).toBe('1.1.0');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/create/test/upgrade-backfill.test.ts`
Expected: FAIL — `.env.example` is not created (skipIfExists is skipped on upgrade).

- [ ] **Step 3: Implement**

In `scaffold.ts`, change the upgrade filter so `skipIfExists` is **included**. The mode filter currently excludes it; the fix is to keep `skipIfExists`' existing writer semantics untouched and remove only the upgrade-time exclusion. Update the `ScaffoldOptions.upgrade` doc comment (`:75-77`) to read:

```ts
  /** `noir init --upgrade`: run migrations, then emit the FULL manifest.
   *  `skipIfExists` keeps its create-only-if-absent semantics, so an upgrade
   *  backfills seeds added since initialization without ever touching a file
   *  the user owns. */
```

- [ ] **Step 4: Assert dry-run lists the backfill without writing**

```ts
it('dry-run reports the backfill and writes nothing', async () => {
  const res = await scaffold({ root, mode: 'init', host: 'claude', upgrade: true, dryRun: true });
  expect(res.written).toContain('.noir/.env.example');
  expect(existsSync(join(root, '.noir', '.env.example'))).toBe(false);
  expect(res.written).not.toContain('.noir/.env'); // already present → not listed
});
```

- [ ] **Step 5: Run, then commit**

```bash
git commit -m "fix(create): backfill skipIfExists seeds on --upgrade

--upgrade skipped skipIfExists entirely, so any seed added to the manifest
after a project was initialized was permanently absent from it. Running
skipIfExists is safe by construction: it creates only when absent
(spec 11.1)."

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 11: Scaffold version bump + the first real migration

**Files:**
- Modify: `packages/create/src/scaffold-version.ts:19`
- Modify: `packages/create/src/migrations/index.ts`
- Modify: `packages/create/templates/config.yml.tmpl`
- Test: `packages/create/test/migration-1_0_0.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('1.0.0 → 1.1.0 adds the .env pointer to an existing config.yml, idempotently', async () => {
  mkdirSync(join(root, '.noir'), { recursive: true });
  writeFileSync(join(root, '.noir', 'config.yml'), 'host: claude\nmode: full\n');
  await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });
  const once = readFileSync(join(root, '.noir', 'config.yml'), 'utf8');
  expect(once).toMatch(/\.noir\/\.env/);
  expect(once).toMatch(/host: claude/); // user content preserved
  await scaffold({ root, mode: 'init', host: 'claude', upgrade: true });
  expect(readFileSync(join(root, '.noir', 'config.yml'), 'utf8')).toBe(once); // idempotent
});
```

- [ ] **Step 2: Implement**

Bump `CURRENT_SCAFFOLD_VERSION` to `'1.1.0'`, add the migration entry to `MIGRATIONS` with `from: '1.0.0', to: '1.1.0'`, whose `run` appends a marker-guarded comment block to `.noir/config.yml` when the marker is absent. Follow the registry's stated convention: idempotent, non-throwing, conflicts captured into `result.conflicts`. Add the same pointer comment to `config.yml.tmpl` for new projects.

- [ ] **Step 3: Assert doctor reports drift for a 1.0.0 project**

Run `checkScaffoldVersion` against a 1.0.0 fixture and assert `drift: true` — the existing row (`doctor.ts:461-485`) already does this; the test pins it.

- [ ] **Step 4: Run, then commit**

```bash
git commit -m "feat(create): scaffold 1.1.0 + first real migration

Bumps CURRENT_SCAFFOLD_VERSION so doctor reports drift for existing
projects, and adds the 1.0.0 -> 1.1.0 transformation that skipIfExists
cannot perform (spec 11.2)."

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Slice F — `.noir/.env` precedence and consolidation

### Task 12: Invert the precedence and record provenance

**Files:**
- Modify: `packages/core/src/env-file.ts`
- Test: `packages/core/test/env-file.test.ts`

**Interfaces:**
- Produces: `loadNoirEnv(root, env?) → { overlay, warnings, sources: Record<string, 'file'|'env'> }`. `applyNoirEnv` mutates only the passed env object.

- [ ] **Step 1: Write the failing test**

```ts
it('a file key WINS over the ambient environment', () => {
  writeFileSync(join(root, '.noir', '.env'), 'CLICKUP_API_TOKEN=from_file\n');
  const env = { CLICKUP_API_TOKEN: 'from_env' };
  const { overlay, sources } = loadNoirEnv(root, env);
  expect(overlay.CLICKUP_API_TOKEN).toBe('from_file');
  expect(sources.CLICKUP_API_TOKEN).toBe('file');
});

it('a key absent from the file still falls back to the environment', () => {
  writeFileSync(join(root, '.noir', '.env'), 'A=file\n');
  const env = { B: 'from_env' };
  expect(loadNoirEnv(root, env).sources.B).toBe('env');
});

it('confines the overlay to the object it is given', () => {
  writeFileSync(join(root, '.noir', '.env'), 'A=file\n');
  const env: Record<string, string | undefined> = {};
  applyNoirEnv(root, env);
  expect(process.env.A).toBeUndefined(); // never leaks to the real process env
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run packages/core/test/env-file.test.ts`
Expected: the first test FAILS — today the ambient value wins.

- [ ] **Step 3: Implement**

Replace the fill-only-unset branch:

```ts
  // PRECEDENCE (spec 12.1): a key this file defines WINS; the real environment
  // is the FALLBACK for keys the file omits. This departs from Node --env-file
  // fill-only-unset deliberately: for PROJECT configuration, the project file
  // must be able to describe the project. `sources` records the winner so
  // `noir env` and doctor can report provenance without re-reading anything.
  const overlay: Record<string, string> = {};
  const sources: Record<string, 'file' | 'env'> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (PROCESS_INJECTION_ENV_RE.test(k)) {
      warnings.push(`.noir/.env: refusing process-injection key '${k}' — ignored`);
      continue;
    }
    overlay[k] = v;
    sources[k] = 'file';
  }
```

Add the shadowing warning (Task 14 consumes it; emit here so it fires once):

```ts
    if (env[k] !== undefined && env[k] !== v) {
      warnings.push(
        `.noir/.env: '${k}' overrides the environment value for this run ` +
          `(run \`noir env\` to see every resolved key)`,
      );
    }
```

`applyNoirEnv` signature keeps its `env` parameter and writes only into it.

- [ ] **Step 4: Update every existing test that asserted fill-only-unset**

Run: `pnpm vitest run packages/core packages/daemon packages/cli`
Expected: existing env-file tests need their expectations flipped — that is the intended behaviour change, and the flips are the record of it.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(core)!: .noir/.env wins over the ambient environment

Project configuration must be able to describe its own project. The real
environment becomes the fallback for keys the file omits. applyNoirEnv
still touches only the env object it is given, so a user's manual claude
invocations are unaffected (spec 12.1).

BREAKING CHANGE: a key set in both .noir/.env and the shell environment now
resolves to the .noir/.env value. `noir env` reports which source won.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 13: Refuse a git-tracked `.noir/.env`

**Files:**
- Create: `packages/core/src/git-tracked.ts`
- Modify: `packages/core/src/env-file.ts`
- Test: `packages/core/test/git-tracked.test.ts`

**Interfaces:**
- Produces: `isGitTracked(root: string, relPath: string): boolean` — never throws; `false` on any git failure.

- [ ] **Step 1: Write the failing tests**

```ts
it('detects a tracked file and an untracked one', () => {
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(join(repo, '.noir', '.env'), 'A=1\n');
  expect(isGitTracked(repo, '.noir/.env')).toBe(false);
  execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo });
  expect(isGitTracked(repo, '.noir/.env')).toBe(true);
});

it('returns false (trusted) outside a git repository or on any git failure', () => {
  expect(isGitTracked(plainTmpDir, '.noir/.env')).toBe(false);
});

it('refuses to load a tracked .noir/.env and applies nothing from it', () => {
  // repo with .noir/.env force-added
  const { overlay, warnings } = loadNoirEnv(repo, {});
  expect(overlay).toEqual({});
  expect(warnings.join('\n')).toMatch(/tracked by git/);
});
```

- [ ] **Step 2: Implement**

```ts
// packages/core/src/git-tracked.ts
// A `.noir/.env` that arrived with a clone is attacker-controlled. Because
// .noir/.env now WINS over the environment (spec 12.1), a repo could set
// ANTHROPIC_BASE_URL while the user's real token arrives via the fallback —
// exfiltrating the credential without ever knowing it. Tracking status cleanly
// separates "my own file" from "a file that came with the repo".
//
// Never throws: any git failure degrades to TRUSTED, so an exotic setup cannot
// silently disable the env file for everyone.
import { execFileSync } from 'node:child_process';

export function isGitTracked(root: string, relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
      cwd: root, stdio: 'ignore', timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}
```

In `loadNoirEnv`, immediately after the file is read successfully:

```ts
  if (isGitTracked(root, join(NOIR_DIR, '.env'))) {
    warnings.push(
      `.noir/.env: refusing to load — it is tracked by git. A cloned repository ` +
        `could redirect credentials through it. Fix: add \`.noir/.env\` to .gitignore ` +
        `(Noir's managed block already does) and run \`git rm --cached .noir/.env\`.`,
    );
    return { overlay: {}, warnings, sources: {} };
  }
```

- [ ] **Step 3: Run, then commit**

```bash
git commit -m "feat(core): refuse a git-tracked .noir/.env

Inverting precedence opened a credential-exfiltration path: a repo-supplied
.noir/.env could redirect ANTHROPIC_BASE_URL while the user's real token
arrived via the fallback. Tracking status separates the user's own file
from one that came with the clone (spec 12.2)."

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 14: `noir env` + doctor provenance

**Files:**
- Create: `packages/cli/src/commands/env.ts`
- Modify: `packages/cli/src/bin.ts`, `packages/cli/src/commands/doctor.ts`
- Test: `packages/cli/test/env-command.test.ts`

**Interfaces:**
- Consumes: `loadNoirEnv(...).sources` from Task 12.
- Produces: `noir env` (table + `--json`), and `noir-env` / `provider` doctor rows naming the winning source. **Never prints a value.**

- [ ] **Step 1: Write the failing test**

```ts
it('reports the winning source per key and never prints a value', async () => {
  writeFileSync(join(root, '.noir', '.env'), 'CLICKUP_API_TOKEN=pk_secret_value\n');
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example';
  const out = await runCli(['env', '--json'], { cwd: root });
  const data = JSON.parse(out.stdout).data;
  expect(data.vars.find((v: any) => v.key === 'CLICKUP_API_TOKEN').source).toBe('file');
  expect(data.vars.find((v: any) => v.key === 'ANTHROPIC_BASE_URL').source).toBe('env');
  expect(out.stdout + out.stderr).not.toContain('pk_secret_value');
});
```

- [ ] **Step 2: Implement the command and the doctor rows**

Follow the `status` command's structure for the table/`--json` split and `EXIT` codes. `doctor.ts`'s `checkNoirEnv` gains per-key provenance rows; `checkProvider` renders `key present (from .noir/.env)` instead of a bare `key present`.

- [ ] **Step 3: Run, then commit**

```bash
git commit -m "feat(cli): add \`noir env\` + per-key provenance in doctor

Answers \\\"which value is actually in effect\\\" — the question behind the
maintainer's \\\"I edited .noir/.env and nothing changed\\\". Names only,
never values (spec 12.4)."

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 15: Denylist addition

**Files:**
- Modify: `packages/core/src/env-file.ts:36`
- Test: `packages/core/test/env-file.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('refuses NOIR_DAEMON_DIR from .noir/.env', () => {
  writeFileSync(join(root, '.noir', '.env'), 'NOIR_DAEMON_DIR=/tmp/evil\n');
  const { overlay, warnings } = loadNoirEnv(root, {});
  expect(overlay.NOIR_DAEMON_DIR).toBeUndefined();
  expect(warnings.join()).toMatch(/process-injection/);
});
```

- [ ] **Step 2: Add `NOIR_DAEMON_DIR` to `PROCESS_INJECTION_ENV_RE`**

`NOIR_DAEMON_JSON` is already present; the pattern is `(?:$|_)`-anchored, so `NOIR_DAEMON_DIR` does **not** match it and must be added as its own alternative.

Record, without fixing, the Windows case-insensitivity gap and the `env-filename` case-collision risk in `backlog.md` (Task 20).

- [ ] **Step 3: Run, then commit**

```bash
git commit -m "fix(core): refuse NOIR_DAEMON_DIR from .noir/.env

A .noir/.env that redirects the daemon record directory is a hijack
vector (spec 4.4)."

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Slice F-docs — Doctrine consolidation

### Task 16: The missing how-to page

**Files:**
- Create: `docs/how-to/configure-env.md`

- [ ] **Step 1: Write the page** per spec §18.1 — what the file is for, creating it, the precedence chain (§12.1 verbatim), seeing what is in effect, common recipes (ClickUp, model provider with the `apiKeyEnv` NAME trap, embedder, profiles, `NOIR_PROFILE`), safety (gitignore/0600/denylist/tracked refusal), troubleshooting.

- [ ] **Step 2: Link it** from `getting-started.md`, `environment.md`, `clickup.md`, and `host-profiles.md`.

- [ ] **Step 3: Validate and commit**

```bash
pnpm docs:validate
git commit -m "docs: add the missing .noir/.env configuration how-to

The file was referenced in six pages and documented in none of them
(spec 18.1)."
```

---

### Task 17: Correct the existing docs (generator + hand-authored)

**Files:** the 14 items in spec §12.5.

- [ ] **Step 1: Edit `scripts/docs-generate.mjs` first** — the Precedence source (`:196-210`) and the Secrets-policy source (`:330-345`).

- [ ] **Step 2: Edit the hand-authored pages** — `environment.md` (precedence block `:6-11`; the three placements `:15-19, :25, :109-111`; provider-key placement `:38-53`; the `NOIR_SKIP_NODE_PROVISION` row; the refused-keys note), `clickup.md:17-37`, `host-profiles.md:68-71`, `getting-started.md:60-69` and `:219-225`, `privacy.md:38`, `architecture.md:46, :54`, `config.yml.tmpl`.

- [ ] **Step 3: Fix the `apiKeyEnv` conflation in all three places** so no doc shows `apiKeyEnv: ${VAR}`.

- [ ] **Step 4: Regenerate and DIFF — this is the acceptance test**

```bash
pnpm docs:generate
git diff --stat docs/reference/config.md docs/reference/cli.md docs/reference/mcp-tools.md
# Expected: the generated pages already contain your new text (you edited the
# generator, so regeneration is a no-op or a trivial refactor). If the diff
# shows your text REVERTED, you edited the .md instead of the generator.
```

- [ ] **Step 5: Commit**

```bash
git commit -m "docs: consolidate configuration doctrine onto .noir/.env

Project scope beats machine scope; the reference chain is stated once and
linked. Generated pages fixed in scripts/docs-generate.mjs (spec 12.5)."
```

---

### Task 18: The 9 skills

**Files:** `packages/skills/integrations/noir-clickup/{SKILL.md,references/clickup-api.md}` and `packages/skills/builtin/{noir-writing-skills,noir-doctor,noir-context,noir-security}/…`, `packages/skills/builtin/noir-backend/references/backend-patterns.md`.

- [ ] **Step 1: Rewrite the ClickUp setup block** (`SKILL.md:36-53`) with `.noir/.env` as option 1, a real env var / one-shot for CI as option 2, and `~/.claude/settings.json` explicitly labelled a machine-global fallback that cannot shadow the file. Fix `:392`, `:307-308`, and the API reference.

- [ ] **Step 2: Update the four other skills** — `noir-doctor` (add the `noir-env`/`provider` rows and the `chmod 600` remedy), `noir-writing-skills` (a config-placement rule for skill authors), `noir-context` (embedder keys), `noir-security` and `noir-backend` (name the file).

- [ ] **Step 3: Run the skills quality gate**

Run: `pnpm vitest run packages/skills && pnpm build`
Expected: PASS — `validateSkill`/`lintSkill` enforce WHAT+WHEN descriptions and structure.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs(skills): point every skill at .noir/.env first

The ClickUp setup ranked a machine-global host file as the primary fix
and never named .noir/.env. Eight further skills carried the same gap
(spec 12.5)."
```

---

## Slice G — `noir run` diagnostics

### Task 19: Credential diagnostics

**Files:**
- Modify: `packages/cli/src/commands/run.ts:135-146`, and the pre-spawn path
- Test: `packages/cli/test/run-diagnostics.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it('explains a gateway credential failure, not just ANTHROPIC_API_KEY', async () => {
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-test';
  process.env.ANTHROPIC_BASE_URL = 'https://gw.example';
  const err = await runExpectingFailure();
  expect(err.message).toMatch(/ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL/);
});

it('names .noir/.env as the source when the credential came from there', async () => {
  writeFileSync(join(root, '.noir', '.env'), 'ANTHROPIC_AUTH_TOKEN=sk-test\n');
  const err = await runExpectingFailure();
  expect(err.message).toMatch(/\.noir\/\.env/);
});

it('does not print the credential value', async () => {
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-super-secret';
  const err = await runExpectingFailure();
  expect(err.message).not.toContain('sk-super-secret');
});

it('notices an uninitialized project on stderr, and stays silent under --json', async () => {
  const r = await runCli(['run', 'hi'], { cwd: plainDirWithoutNoir });
  expect(r.stderr).toMatch(/noir init/);
  const j = await runCli(['run', 'hi', '--json'], { cwd: plainDirWithoutNoir });
  expect(j.stderr).not.toMatch(/noir init/);
});
```

- [ ] **Step 2: Implement** — broaden the credential shape check, use `loadNoirEnv(...).sources` to name the file when it won, and add the informational uninitialized notice (stderr only, suppressed under `--json`, never a failure).

- [ ] **Step 3: Run, then commit**

```bash
git commit -m "fix(cli): make noir run credential failures actionable

The auth branch keyed on ANTHROPIC_API_KEY only, so a custom-gateway setup
(ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL) got \\\"run /login\\\" instead of
the real cause. Also notices an uninitialized project (spec 13)."
```

---

## Finalisation

### Task 20: Gate, roadmap sync, ADRs, release prep

**Files:** `docs/roadmap/{STATUS.md,releases.md,backlog.md,roadmap.manifest.yaml,capability-05-runtime-infrastructure.md}`, `CHANGELOG.md`, `docs/decisions/0010-*.md`, `docs/decisions/0011-*.md`, `docs/how-to/releasing.md`.

- [ ] **Step 1: Run the full gate**

```bash
pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate
```
Expected: all five green. Do not proceed on a red gate.

- [ ] **Step 2: Write ADR-0010 and ADR-0011** from spec §20 (items 1–8 → 0010; 9–15 → 0011).

- [ ] **Step 3: Sync the roadmap** — `capability-05` gap items move out of "Gap / roadmap delta"; `backlog.md` resolves the ignore-list entry and records the deferrals (D if unused, Windows env case-insensitivity, `env-filename` collision risk, `.claude/settings.local.json` policy); `STATUS.md` sprint entry; `releases.md` current-status; `roadmap.manifest.yaml`.

- [ ] **Step 4: CHANGELOG** — a **Changed** entry for the precedence inversion and an **Added** entry for the rest, plus the upgrade steps from spec §15.

- [ ] **Step 5: Commit and STOP for approval**

```bash
git add -A
git commit -m "docs: roadmap sync + ADR-0010/0011 for the 1.14.0 slice

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

**Do not push.** Report the gate results and the diff summary, then ask for explicit go-ahead before the release flow (bump → push → CI → beta tag → **user approves the GitHub deployment** → merge → stable tag → **user approves again** → Homebrew + Scoop → branch sync).

---

## Self-Review

**Spec coverage.** §4→T1–3 · §5→T4 · §6→T5–6 · §7→T7 · §8→T8 · §9→T9 · §10→T9 · §11→T10–11 · §12.1→T12 · §12.2→T13 · §12.3–12.4→T12+T14 · §12.5→T16–18 · §12.6→T15 · §13→T19 · §14 security→T13, T15, T19 (value-redaction asserted in T14/T19) · §15 compat→T20 · §16 criteria→mapped below · §17 testing→tests are written in each task · §18 docs→T16–18 · §19 slices→task grouping · §20→T20.

Acceptance criteria → task: A1–A5→T2,T3 · B1–B3→T4 · C1–C5→T5,T6 · D1–D3→T7 · E1–E4→T8 · E5–E8→T10,T11 · F1–F2→T12 · F3→T13 · F4→T12 (warning) + T14 (doctor) · F5→T14 · F6→T12 step 1 third test · F7→T12 (assert the profile exception survives) · F8→T17 · F9→T17 step 4 · G1–G4→T19.

**Placeholder scan.** No "TBD"/"TODO"/"handle edge cases". Every code step carries real code. Task 6 and Tasks 9/14/16/17/18 describe changes to existing content or prose deliverables where the requirement is the specification itself; their acceptance tests are given.

**Type consistency.** `ProjectDaemonRecord` (T1) is the type used in T2/T3/T4. `readProjectDaemonRecord`/`writeProjectDaemonRecord`/`clearProjectDaemonRecord`/`listProjectDaemonRecords` keep one spelling throughout. `loadNoirEnv` gains `sources` in T12 and is consumed under that exact name in T14 and T19. `retireLegacyDaemonRecord(opts?)` in T3 is called with no argument in T2. `NOIR_DAEMON_DIR_ENV` is the constant; `NOIR_DAEMON_DIR` is the string. `isGitTracked(root, relPath)` (T13) is called with the same two-argument shape everywhere.

**Known gaps, deliberately recorded rather than silently dropped:** the Windows denylist case-insensitivity (`env-file.ts:146`) and the `env-filename` case-collision risk are found-but-deferred; both go to `backlog.md` in T20 with an explicit note. Task 6's `headersHelper` support is documentation-only by design (spec §6.1) — the host-side wiring cannot be verified offline.
