# Shared Workspace Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let ≥2 agent sessions in different repos (e.g. a backend repo and a frontend repo) on one machine share decision memory through one workspace daemon (foreground by default, or `--detach`) — `noir daemon start --workspace <name>` / `noir daemon join <name>` — with provenance-stamped entries and a change feed (`changes_since` + long-poll `await_changes`). Default transport stays stdio; sharing is explicit per-repo.

**Architecture:** A **workspace** is a named cross-repo unit under `~/.noir/workspaces/<name>/` (registry.json + store.db + its own daemon record). One daemon serves it over Streamable HTTP; each member repo's `.mcp.json` points at `http://127.0.0.1:<port>/mcp?p=<its-own-projectId>`. The daemon routes `memory_*` + feed tools to the **workspace store** and `context_*`/`workflow_*`/`task_*` to the **requesting member's own project store** (lazily opened). A `.noir/workspace.json` join marker in a member repo makes CLI `memory`/`capture` commands route to the workspace daemon. Supersede is append-only (target marked `superseded`); forget is soft (`forgotten`) in workspace stores. Feed = monotonic cursor in KV + in-process long-poll waiters (content push is an anti-pattern per spec §2).

**Tech Stack:** TypeScript, pnpm monorepo, vitest (single root config), zod config, commander CLI, `@modelcontextprotocol/{client,server}` Streamable HTTP, better-sqlite3 store (`getState`/`setState` KV, FTS5, sqlite-vec).

**Spec:** [`docs/internal/specs/2026-09-09-shared-workspace-context-design.md`](../specs/2026-09-09-shared-workspace-context-design.md) — the plan argues from the spec; executors read both. Slice labels W1–W6 map to spec §14.

## Global Constraints

- **Offline + free tests only.** Never add a test that needs a network call, a paid key, an LLM, or a real embedder beyond the test fake (`packages/memory/test/fake-embed.ts`). CI has no network to external services.
- **Default stays stdio.** Project stores, project daemon gating, and bare `noir init` must remain byte-for-byte unchanged. Workspace join is explicit and additive only.
- **Daemon stays the single writer per DB.** The workspace daemon must never open two write handles on the same `.db`. `openStoreForDaemon` is the only project-store opener; the workspace store is opened once per daemon lifecycle.
- **Isolation is default.** A workspace daemon refuses requests whose `?p=` is not a member of its registry. `noir daemon stop` (project) never touches a workspace record, and vice versa.
- **Provenance is stamped, never caller-supplied.** `repo` on a workspace observation is derived from the request URL identity (`?p=`), never from `memory_save` args.
- **Commit discipline:** Conventional Commits, one commit per task, scope per package (`feat(core):`, `feat(store):`, `feat(daemon):`, `feat(memory):`, `feat(cli):`, `docs(workspace):`). Keep commits local; never push.
- **Every behavior ships with a regression test** (standing rule). Each task ends green.
- Full gate before claiming done: `pnpm lint → build → typecheck → test → docs:validate`.
- Run one test file from repo root: `pnpm vitest run packages/<pkg>/test/<file>.test.ts` (optionally `--testTimeout=40000`).
- Exact record/KV/fact anchors (verified 2026-09-09): daemon record file `~/.noir/daemon.json` via `packages/daemon/src/lifecycle.ts` (`daemonJsonPath`, `readDaemonRecord`, `writeDaemonRecord`, `clearDaemonRecord`, `pidAlive`, `DaemonRecord {pid,port,startedAt,mode?,projectId?}`); `Store` KV is `getState<T>(key): T|null` / `setState<T>(key, value)` (`packages/store/src/types.ts:56`); memory engine methods at `packages/memory/src/engine.ts`; obs KV helpers at `packages/memory/src/store.ts` (`getObservation`, `setObservation`, `obsKey`). Env-override precedent: `NOIR_DAEMON_JSON`, `NOIR_RUNTIME_DIR` — new `NOIR_WORKSPACES_DIR` follows the same shape AND joins the `.env` deny-list regex in `packages/core/src/env-file.ts`.

---

### Task 1: Store — optional `dbPath` override (W2 dependency)

**Files:**
- Modify: `packages/store/src/types.ts` (OpenOptions)
- Modify: `packages/store/src/sqlite-store.ts` (`openStore`)
- Test: Create `packages/store/test/dbpath.test.ts`

**Interfaces:**
- Consumes: `openStore(opts: OpenOptions)` current behavior (`dbPath = paths.storeDb(opts.root, projectId)` at `sqlite-store.ts`).
- Produces: `OpenOptions.dbPath?: string` — when set, the DB is opened at that exact path (dir auto-created); when absent, the existing `<root>/.noir/store/<projectId>.db` behavior is unchanged. This lets a workspace store live at `~/.noir/workspaces/<name>/store.db`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/store/test/dbpath.test.ts
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

describe('openStore dbPath override', () => {
  it('opens the db at an explicit path when dbPath is given', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noir-store-dbpath-'));
    const target = join(root, 'custom', 'ws.db');
    try {
      const store = await openStore({ projectId: 'ws-a', root, dbPath: target });
      await store.close();
      expect(existsSync(target)).toBe(true);
      // no nested <root>/.noir created when dbPath overrides
      expect(readdirSync(root)).not.toContain('.noir');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/store/test/dbpath.test.ts`
Expected: FAIL — `OpenOptions` has no `dbPath` (type error), and the store opened at the default path.

- [ ] **Step 3: Extend OpenOptions**

`packages/store/src/types.ts` — add to the existing `OpenOptions` interface:

```ts
/** Open the database at this exact path (default: <root>/.noir/store/<projectId>.db). */
dbPath?: string;
```

- [ ] **Step 4: Honor dbPath in openStore**

`packages/store/src/sqlite-store.ts` — in `openStore`, replace the db-path derivation + mkdir:

```ts
export async function openStore(opts: OpenOptions): Promise<Store & { __db: Database.Database }> {
  const projectId: ProjectId = opts.projectId;
  const dbPath = opts.dbPath ?? paths.storeDb(opts.root, projectId);
  if (opts.readonly !== true) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  // ... rest unchanged (new Database(dbPath, ...))
}
```

Add `dirname` to the existing `node:path` import at the top of the file.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/store/test/dbpath.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/store/src/types.ts packages/store/src/sqlite-store.ts packages/store/test/dbpath.test.ts
git commit -m "feat(store): optional dbPath override for openStore"
```

---

### Task 2: Core — workspace home, registry, join marker, env deny-list (W1)

**Files:**
- Create: `packages/core/src/workspace.ts`
- Modify: `packages/core/src/index.ts` (re-export)
- Modify: `packages/core/src/env-file.ts` (deny-list regex)
- Test: Create `packages/core/test/workspace.test.ts`
- Test: Modify `packages/core/test/env-file.test.ts` (deny-list case)

**Interfaces:**
- Consumes: `noirHome()` from `packages/core/src/layout.ts`; `ProjectId`, `isValidProjectId` from `project-id.ts`; fs primitives.
- Produces (re-exported from `@noir-ai/core`):
  - `workspaceHomeDir(): string` — `process.env.NOIR_WORKSPACES_DIR ?? join(noirHome(), 'workspaces')`
  - `workspaceDir(name: string): string` — `join(workspaceHomeDir(), name)`
  - `workspaceRegistryPath(name): string` — `join(workspaceDir(name), 'registry.json')`
  - `workspaceStoreDbPath(name): string` — `join(workspaceDir(name), 'store.db')`
  - `workspaceMarkerPath(root): string` — `join(root, '.noir', 'workspace.json')`
  - `isValidWorkspaceName(name): boolean` — `/^[a-z0-9][a-z0-9-]{0,63}$/`
  - `interface WorkspaceMember { projectId: ProjectId; root: string; joinedAt: number }`
  - `interface WorkspaceRegistry { name: string; createdAt: number; members: WorkspaceMember[] }`
  - `readWorkspaceRegistry(name): WorkspaceRegistry | null`
  - `writeWorkspaceRegistry(reg): void` (atomic: tmp file + rename)
  - `ensureWorkspaceRegistry(name): WorkspaceRegistry` (create if absent)
  - `upsertWorkspaceMember(reg, member): WorkspaceRegistry` (replace member with same projectId, else append)
  - `removeWorkspaceMember(reg, projectId): WorkspaceRegistry`
  - `isWorkspaceMember(reg, projectId): boolean`
  - `readWorkspaceMarker(root): string | null`, `writeWorkspaceMarker(root, name): void`, `clearWorkspaceMarker(root): void`

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/workspace.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ensureWorkspaceRegistry,
  isWorkspaceMember,
  readWorkspaceRegistry,
  removeWorkspaceMember,
  upsertWorkspaceMember,
  workspaceDir,
  workspaceRegistryPath,
  workspaceStoreDbPath,
} from '../src/workspace.js';

const dirs: string[] = [];
const home = mkdtempSync(join(tmpdir(), 'noir-ws-home-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('workspace registry', () => {
  it('creates, persists, joins and leaves members idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'noir-ws-repo-'));
    dirs.push(root);
    const reg = ensureWorkspaceRegistry('my-app');
    expect(reg.members).toEqual([]);
    const member = { projectId: 'be-repo', root, joinedAt: 1 };
    const reg2 = upsertWorkspaceMember(reg, member);
    const reg2b = upsertWorkspaceMember(reg2, member); // idempotent
    expect(reg2b.members).toHaveLength(1);
    expect(isWorkspaceMember(reg2b, 'be-repo')).toBe(true);
    expect(isWorkspaceMember(reg2b, 'other')).toBe(false);
    const onDisk = readWorkspaceRegistry('my-app');
    expect(onDisk?.members[0]?.projectId).toBe('be-repo');
    const reg3 = removeWorkspaceMember(reg2b, 'be-repo');
    expect(reg3.members).toHaveLength(0);
    expect(existsSync(workspaceStoreDbPath('my-app'))).toBe(false);
    expect(workspaceRegistryPath('my-app')).toBe(join(workspaceDir('my-app'), 'registry.json'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/core/test/workspace.test.ts`
Expected: FAIL — module `../src/workspace.js` not found.

- [ ] **Step 3: Implement the module**

```ts
// packages/core/src/workspace.ts
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectId } from './project-id.js';

export const WORKSPACES_DIR_ENV = 'NOIR_WORKSPACES_DIR';
export const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function workspaceHomeDir(): string {
  return process.env[WORKSPACES_DIR_ENV] ?? join(homedir(), '.noir', 'workspaces');
}
export function workspaceDir(name: string): string {
  if (!isValidWorkspaceName(name)) throw new Error(`invalid workspace name: ${JSON.stringify(name)}`);
  return join(workspaceHomeDir(), name);
}
export function workspaceRegistryPath(name: string): string {
  return join(workspaceDir(name), 'registry.json');
}
export function workspaceStoreDbPath(name: string): string {
  return join(workspaceDir(name), 'store.db');
}
export function workspaceMarkerPath(root: string): string {
  return join(root, '.noir', 'workspace.json');
}
export function isValidWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_RE.test(name);
}

export interface WorkspaceMember { projectId: ProjectId; root: string; joinedAt: number; }
export interface WorkspaceRegistry { name: string; createdAt: number; members: WorkspaceMember[]; }

export function readWorkspaceRegistry(name: string): WorkspaceRegistry | null {
  try {
    const raw = readFileSync(workspaceRegistryPath(name), 'utf8');
    return JSON.parse(raw) as WorkspaceRegistry;
  } catch {
    return null;
  }
}
export function ensureWorkspaceRegistry(name: string): WorkspaceRegistry {
  const existing = readWorkspaceRegistry(name);
  if (existing !== null && existing.members) return existing;
  const reg: WorkspaceRegistry = { name, createdAt: Date.now(), members: [] };
  writeWorkspaceRegistry(reg);
  return reg;
}
export function writeWorkspaceRegistry(reg: WorkspaceRegistry): void {
  const p = workspaceRegistryPath(reg.name);
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}
export function upsertWorkspaceMember(reg: WorkspaceRegistry, member: WorkspaceMember): WorkspaceRegistry {
  const next: WorkspaceRegistry = { ...reg, members: reg.members.filter((m) => m.projectId !== member.projectId) };
  next.members.push(member);
  writeWorkspaceRegistry(next);
  return next;
}
export function removeWorkspaceMember(reg: WorkspaceRegistry, projectId: string): WorkspaceRegistry {
  const next: WorkspaceRegistry = { ...reg, members: reg.members.filter((m) => m.projectId !== projectId) };
  writeWorkspaceRegistry(next);
  return next;
}
export function isWorkspaceMember(reg: WorkspaceRegistry, projectId: string): boolean {
  return reg.members.some((m) => m.projectId === projectId);
}
export function readWorkspaceMarker(root: string): string | null {
  try {
    const raw = readFileSync(workspaceMarkerPath(root), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return typeof parsed.name === 'string' ? parsed.name : null;
  } catch {
    return null;
  }
}
export function writeWorkspaceMarker(root: string, name: string): void {
  mkdirSync(join(root, '.noir'), { recursive: true });
  writeFileSync(workspaceMarkerPath(root), JSON.stringify({ name }, null, 2) + '\n', 'utf8');
}
export function clearWorkspaceMarker(root: string): void {
  rmSync(workspaceMarkerPath(root), { force: true });
}
```

Note: keep `noirHome()` from `layout.ts` as the canonical home; `workspaceHomeDir()` here defaults to `join(noirHome(), 'workspaces')` when `NOIR_WORKSPACES_DIR` is unset. To avoid importing `layout.ts` (which is fine — same package), use `join(noirHome(), 'workspaces')` and add `import { noirHome } from './layout.js';`.

- [ ] **Step 4: Re-export from the barrel**

`packages/core/src/index.ts` — add: `export * from './workspace.js';` (verify the file uses `export *` per existing style; if it re-exports selectively, add the symbols above).

- [ ] **Step 5: Add NOIR_WORKSPACES_DIR to the .env deny-list + test**

`packages/core/src/env-file.ts` — add `NOIR_WORKSPACES_DIR` to the `PROCESS_INJECTION_ENV_RE` alternation (next to `NOIR_RUNTIME_DIR`).

`packages/core/test/env-file.test.ts` — add one assertion that a `.env` containing `NOIR_WORKSPACES_DIR=...` yields a refusal warning and does not land in the overlay (mirror the existing `NOIR_DAEMON_JSON` case).

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/core/test/workspace.test.ts packages/core/test/env-file.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/workspace.ts packages/core/src/index.ts packages/core/src/env-file.ts packages/core/test/workspace.test.ts packages/core/test/env-file.test.ts
git commit -m "feat(core): workspace home + registry + join marker (NOIR_WORKSPACES_DIR)"
```

---

### Task 3: Memory — provenance fields + soft lifecycle on the engine (W2/W3)

**Files:**
- Modify: `packages/memory/src/types.ts`
- Modify: `packages/memory/src/engine.ts`
- Modify: `packages/memory/src/store.ts`
- Modify: `packages/memory/src/index.ts` (barrel, if adding new exports)
- Test: Create `packages/memory/test/engine-status.test.ts`

**Interfaces:**
- Consumes: existing `Observation`, `SaveInput`, `MemoryEngineOptions`, `forget()` (currently hard-deletes), `recall`/`search` hydration via `getObservation` (authoritative KV).
- Produces (additive, optional — legacy rows stay valid):
  - `type ObservationStatus = 'active' | 'superseded' | 'forgotten'`
  - On `Observation` (optional): `repo?: string; status?: ObservationStatus; cursor?: number; supersedes?: string;`
  - On `SaveInput` (optional): `repo?: string; status?: ObservationStatus; supersedes?: string;`
  - On `MemoryHit` (optional): `status?: ObservationStatus; repo?: string; cursor?: number;`
  - `MemoryEngineOptions.softForget?: boolean` (default false — workspace stores soft-forget; project stores keep today's hard-delete)
  - `MemoryEngine.softForget(): boolean`
  - `MemoryEngine.recall(query, { includeInactive?: boolean })` / `search` — drop hits whose hydrated status is `superseded`/`forgotten` unless `includeInactive` (legacy undefined status = active)
  - `MemoryEngine.markStatus(id, status): void` — flips the authoritative KV row + re-indexes the FTS meta projection (used by supersede/forget flows)

- [ ] **Step 1: Write the failing test**

```ts
// packages/memory/test/engine-status.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryEngine } from '../src/engine.js';
import { fakeEmbedFn } from './fake-embed.js';

let root: string;
let store: Awaited<ReturnType<typeof openStore>>;
let projectId: string;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'noir-mem-status-'));
  projectId = createProjectId();
  store = await openStore({ projectId, root });
});
afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('memory provenance + lifecycle', () => {
  it('stamps repo and marks superseded targets inactive; recall hides them unless includeInactive', async () => {
    const mem = createMemoryEngine({ store, root, projectId, embed: fakeEmbedFn() });
    const first = await mem.save({ content: 'GET /users returns {items: User[]}', repo: 'be' });
    await mem.save({ content: 'pagination param is page, not offset', repo: 'be', supersedes: first.id });
    // first is now superseded -> hidden by default
    const hidden = await mem.recall('pagination offset users');
    expect(hidden.some((h) => h.id === first.id)).toBe(false);
    const shown = await mem.recall('pagination offset users', { includeInactive: true });
    expect(shown.some((h) => h.id === first.id)).toBe(true);
    expect(shown.find((h) => h.id === first.id)?.status).toBe('superseded');
  });

  it('softForget marks forgotten (not deleted) and hides from recall', async () => {
    const mem = createMemoryEngine({ store, root, projectId, embed: fakeEmbedFn(), softForget: true });
    const obs = await mem.save({ content: 'scratch note to drop' });
    const res = mem.forget([obs.id]);
    expect(res.deleted).toBe(1);
    const gone = await mem.recall('scratch note');
    expect(gone.some((h) => h.id === obs.id)).toBe(false);
    const raw = await mem.get(obs.id); // get is engine-internal but public on the class
    expect(raw?.status).toBe('forgotten');
  });
});
```

Note: `engine.get(id)` exists on the class (`engine.ts:300`); if the instance type used by the test doesn't expose it, cast: `(mem as { get(id: string): unknown }).get(obs.id)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/memory/test/engine-status.test.ts`
Expected: FAIL — `repo`/`supersedes`/`includeInactive`/`softForget` don't exist yet; `forget` deletes (get returns null).

- [ ] **Step 3: Extend types**

`packages/memory/src/types.ts`:
- Add `export type ObservationStatus = 'active' | 'superseded' | 'forgotten';`
- On `Observation`: add optional `repo?: string; status?: ObservationStatus; cursor?: number; supersedes?: string;`
- On `SaveInput`: add optional `repo?: string; status?: ObservationStatus; supersedes?: string;`
- On `MemoryHit`: add optional `status?: ObservationStatus; repo?: string; cursor?: number;`
- On `RecallOptions` (and `SearchOptions` if it has filters): add `includeInactive?: boolean`.

- [ ] **Step 4: Stamp + soft lifecycle in the engine**

`packages/memory/src/engine.ts`:
- `MemoryEngineOptions` — add `softForget?: boolean`.
- In `saveInternal`, when building `observation`, copy the new optional fields (absent stays absent; do NOT invent `status: 'active'` defaults so legacy projections are unchanged):

```ts
const observation: Observation = {
  id: randomUUID(),
  type: input.type ?? DEFAULT_TYPE,
  content: input.content,
  project: this.projectId,
  sessionId: input.sessionId ?? null,
  ts,
  lastAccessTs: ts,
  importance: input.importance ?? DEFAULT_IMPORTANCE,
  concepts: input.concepts ?? [],
  files: input.files ?? [],
  source: 'explicit',
  // new optional provenance (copied only when provided)
  ...(input.repo !== undefined ? { repo: input.repo } : {}),
  ...(input.status !== undefined ? { status: input.status } : {}),
  ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
};
```

- After `this.indexObservation(observation, vec)`, handle supersede (append-only): if `input.supersedes` is set, flip the target's status:

```ts
if (input.supersedes !== undefined) {
  this.markStatus(input.supersedes, 'superseded');
}
```

- Add `markStatus(id, status)` (synchronous; KV row + FTS meta re-projection):

```ts
markStatus(id: string, status: ObservationStatus): void {
  const obs = getObservation(this.store, id);
  if (obs === null) return;
  const next: Observation = { ...obs, status };
  setObservation(this.store, next);
  // re-project the FTS doc meta so recall/search hydration sees the status
  this.store.indexDoc({ id, source: MEMORY_SOURCE, content: obs.content, meta: obsMeta(next) });
}
```

- In `hydrateHits` (engine.ts, used by `search`) and in the recall hydration loop (`recall.ts:302`), after `getObservation`, drop non-active unless opted in:

```ts
const obs = getObservation(this.store, row.id);
if (obs === null) continue;
if (obs.status !== undefined && obs.status !== 'active' && opts?.includeInactive !== true) continue;
```

(recall.ts and engine.ts each have their own hydrate loop — apply the same guard in both; `recall.ts` already takes options with filters.)

- `forget(ids)` — branch on `softForget`:

```ts
forget(ids: string[]): ForgetResult {
  this.assertNotDegraded('forget');
  let deleted = 0;
  const idSet = new Set(ids);
  for (const id of ids) {
    const obs = getObservation(this.store, id);
    if (obs === null) continue;
    if (this.softForget) {
      // soft: keep the authoritative KV row, flip status, purge search indexes
      this.store.deleteDoc(id);
      try { this.store.deleteVec(id); } catch { /* vec0 unavailable */ }
      this.markStatus(id, 'forgotten');
    } else {
      this.store.deleteDoc(id);
      try { this.store.deleteVec(id); } catch { /* vec0 unavailable */ }
      clearObservation(this.store, id);
      if (obs.sessionId !== null) decrementSession(this.store, obs.sessionId);
    }
    deleted += 1;
  }
  if (deleted > 0) {
    const remaining = getObservationIds(this.store).filter((i) => !idSet.has(i));
    setObservationIds(this.store, remaining);
  }
  return { deleted, ids };
}
```

- Store `softForget` on the instance (constructor) and expose `softForget(): boolean`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/memory/test/engine-status.test.ts packages/memory/test/engine.test.ts`
Expected: PASS (and existing engine tests unaffected — hard-delete default unchanged).

- [ ] **Step 6: Commit**

```bash
git add packages/memory/src/types.ts packages/memory/src/engine.ts packages/memory/src/store.ts packages/memory/test/engine-status.test.ts
git commit -m "feat(memory): provenance (repo/status/cursor/supersedes) + soft-forget + inactive recall filter"
```

---

### Task 4: Daemon — workspace record + reuse/ensure + spawn (W1/W4)

**Files:**
- Create: `packages/daemon/src/workspace-record.ts`
- Modify: `packages/daemon/src/ensure.ts` (workspace-aware ensure) — or new `packages/daemon/src/workspace-ensure.ts`
- Modify: `packages/daemon/src/spawn.ts` (workspace-aware detached spawn)
- Modify: `packages/daemon/src/index.ts` (re-exports)
- Test: Create `packages/daemon/test/workspace-record.test.ts`

**Interfaces:**
- Consumes: `workspaceDir`, `workspaceRegistryPath` from `@noir-ai/core`; `pidAlive` from `lifecycle.js`; existing `startHttpServer` (extended in Task 6).
- Produces:
  - `interface WorkspaceDaemonRecord { pid: number; port: number; startedAt: number; workspace: string; }`
  - `workspaceRecordPath(name): string` — `join(workspaceDir(name), 'daemon.json')`
  - `readWorkspaceDaemonRecord(name): WorkspaceDaemonRecord | null`
  - `writeWorkspaceDaemonRecord(name, rec): void`
  - `clearWorkspaceDaemonRecord(name): void`
  - `ensureWorkspaceDaemonRunning(opts: { name; registry; founderRoot; idleTimeoutSec }): Promise<EnsureResult>` — reuse-or-start keyed on the workspace record (pid alive + `/health` returns the same workspace name)
  - `spawnDetachedWorkspaceDaemon(opts: { name; registry; founderRoot }): Promise<{ pid: number; port: number }>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/test/workspace-record.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { clearWorkspaceDaemonRecord, readWorkspaceDaemonRecord, writeWorkspaceDaemonRecord } from '../src/workspace-record.js';

const home = mkdtempSync(join(tmpdir(), 'noir-wsrec-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('workspace daemon record', () => {
  it('round-trips and is keyed by workspace name', () => {
    clearWorkspaceDaemonRecord('my-app');
    expect(readWorkspaceDaemonRecord('my-app')).toBeNull();
    writeWorkspaceDaemonRecord('my-app', { pid: 1234, port: 4321, startedAt: 1, workspace: 'my-app' });
    const rec = readWorkspaceDaemonRecord('my-app');
    expect(rec?.pid).toBe(1234);
    expect(rec?.workspace).toBe('my-app');
    // other workspace's record unaffected
    expect(readWorkspaceDaemonRecord('other')).toBeNull();
    clearWorkspaceDaemonRecord('my-app');
    expect(readWorkspaceDaemonRecord('my-app')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/test/workspace-record.test.ts`
Expected: FAIL — module `../src/workspace-record.js` not found.

- [ ] **Step 3: Implement the module**

```ts
// packages/daemon/src/workspace-record.ts
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { workspaceDir } from '@noir-ai/core';

export interface WorkspaceDaemonRecord { pid: number; port: number; startedAt: number; workspace: string; }

export function workspaceRecordPath(name: string): string {
  return join(workspaceDir(name), 'daemon.json');
}
export function readWorkspaceDaemonRecord(name: string): WorkspaceDaemonRecord | null {
  try {
    const raw = readFileSync(workspaceRecordPath(name), 'utf8');
    const parsed = JSON.parse(raw) as WorkspaceDaemonRecord;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}
export function writeWorkspaceDaemonRecord(name: string, rec: WorkspaceDaemonRecord): void {
  const p = workspaceRecordPath(name);
  mkdirSync(join(p, '..'), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec) + '\n', 'utf8');
  renameSync(tmp, p);
}
export function clearWorkspaceDaemonRecord(name: string): void {
  rmSync(workspaceRecordPath(name), { force: true });
}
```

Note: the record file is deliberately a **different file** from `~/.noir/daemon.json` (project record) so `noir daemon stop`/`ensureDaemonRunning` never touch a workspace daemon. `readWorkspaceDaemonRecord` reads the members' registry membership too (via `readWorkspaceRegistry`) — Task 6 re-reads the registry per request for membership freshness.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/test/workspace-record.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/daemon/src/workspace-record.ts packages/daemon/test/workspace-record.test.ts
git commit -m "feat(daemon): workspace daemon record (isolated from project record)"
```

---

### Task 5: Daemon — HTTP transport parses `?p=` and binds a per-workspace context (W2, the multiplexer)

**Files:**
- Modify: `packages/daemon/src/http.ts`
- Modify: `packages/daemon/src/server.ts` (ServerContext gains optional workspace fields + memory provenance passthrough)
- Modify: `packages/daemon/src/index.ts`
- Test: Create `packages/daemon/test/workspace-routing.test.ts`

**Interfaces:**
- Consumes: `startHttpServer(opts: StartHttpOptions)` per-request `createNoirServer(ctx)`; `openStore` dbPath override (Task 1); `openStoreForDaemon`; `createMemoryEngine` + embedder resolution (already in http.ts); workspace core helpers (Task 2); `loadProjectInfo`.
- Produces:
  - `StartHttpOptions.workspace?: { name: string; founderRoot: string }` — when set, this daemon serves a **workspace** (not a single project): it opens the workspace store once (memory + feed), opens member project stores lazily per `?p=`, and writes a `WorkspaceDaemonRecord`.
  - `ServerContext.workspace?: { name: string; repo: string }` — set per request; `memory_*` tools use the workspace memory engine; context/workflow tools use the requesting member's project store.
  - Workspace `ServerContext.memory` = the **workspace** engine (project stores do not get their own memory engine here).
  - `/health` in workspace mode returns `{ ok, pid, workspace: name, projectId: repo, uptimeSec }` (projectId = the `?p=` of the request, if any; workspace name always).
  - Non-member or missing `?p=` in workspace mode → an `{ ok:false, error }` envelope on a `tools/call`/health request; tool registration refuses.

Implementation notes (verified anchors):
- `http.ts` opens one store per lifecycle today and builds one memory engine. For workspace mode, branch in `startHttpServer`: open `openStore({ projectId: name, root: workspaceDir(name), dbPath: workspaceStoreDbPath(name) })` for the workspace; build ONE workspace memory engine (reuse the existing embedder resolution block).
- Member project context (context/workflow engines) is built **per member lazily** inside the per-request branch, cached in a `Map<repo, {project, store, context, engine}>`. On each request, re-read the registry (`readWorkspaceRegistry(name)`) for membership freshness; add newly-joined members on demand; drop members that left.
- Project tools only: when building the per-member cache, use `openStoreForDaemon(projectId, root)` and the same engine builders `http.ts` already uses (`buildWorkflowEngine`, `buildContextEngine`) — mirror http.ts lines 60-110 with the member's `project` (`loadProjectInfo(member.root)`).

- [ ] **Step 1: Write the failing routing test**

```ts
// packages/daemon/test/workspace-routing.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { paths } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http.js';
import { clearDaemonRecord } from '../src/lifecycle.js';
import { ensureWorkspaceRegistry, upsertWorkspaceMember } from '@noir-ai/core';

const home = mkdtempSync(join(tmpdir(), 'noir-wsrout-home-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
process.env.NOIR_DAEMON_JSON = join(home, 'daemon.json');
const repoA = mkdtempSync(join(tmpdir(), 'noir-wsrout-a-'));
const repoB = mkdtempSync(join(tmpdir(), 'noir-wsrout-b-'));
for (const [root, id] of [[repoA, 'repo-a'], [repoB, 'repo-b']] as const) {
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), `${id}\n`, 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
}
afterAll(() => {
  clearDaemonRecord();
  for (const d of [home, repoA, repoB]) rmSync(d, { recursive: true, force: true });
});

async function mcpClient(port: number, urlPath: string) {
  const client = new Client({ name: 'noir-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${urlPath}`)));
  return client;
}

describe('workspace http routing', () => {
  it('routes memory_save from repo A to the workspace store and refuses a non-member', async () => {
    // founder: repo A starts workspace 'demo'
    const founder = { projectId: 'repo-a', root: repoA, joinedAt: Date.now() };
    const reg = upsertWorkspaceMember(ensureWorkspaceRegistry('demo'), founder);
    const { port, stop } = await startHttpServer({
      project: { id: 'repo-a', name: 'demo-founder', root: repoA, config: { host: 'claude' } },
      idleTimeoutSec: 0,
      workspace: { name: 'demo', founderRoot: repoA },
    });
    try {
      // repo B joins (registry now has both)
      upsertWorkspaceMember(readWorkspaceRegistry('demo') ?? reg, { projectId: 'repo-b', root: repoB, joinedAt: Date.now() });
      // health reports the workspace
      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as Record<string, unknown>;
      expect(body.workspace).toBe('demo');
      // member A can save
      const a = await mcpClient(port, '/mcp?p=repo-a');
      const saved = await a.callTool({ name: 'memory_save', arguments: { content: 'be contract: GET /users' } });
      const envelope = JSON.parse((saved.content?.[0] as { text: string }).text) as Record<string, unknown>;
      expect(envelope.ok).toBe(true);
      // member B recalls the same entry (shared store)
      const b = await mcpClient(port, '/mcp?p=repo-b');
      const recalled = await b.callTool({ name: 'memory_recall', arguments: { query: 'users contract' } });
      const renv = JSON.parse((recalled.content?.[0] as { text: string }).text) as Record<string, unknown>;
      expect(renv.ok).toBe(true);
      // non-member is refused
      const c = await mcpClient(port, '/mcp?p=not-a-member');
      const refused = await c.callTool({ name: 'memory_save', arguments: { content: 'x' } });
      const cenv = JSON.parse((refused.content?.[0] as { text: string }).text) as Record<string, unknown>;
      expect(cenv.ok).toBe(false);
      await Promise.all([a.close(), b.close(), c.close()]);
    } finally {
      await stop();
      clearDaemonRecord();
    }
  }, 30000);
});
```

The `memory_save` handler must stamp `repo` from `?p=` (see Task 7 server wiring). This test pins: cross-repo share + non-member refusal + provenance.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/test/workspace-routing.test.ts`
Expected: FAIL — `workspace` not in `StartHttpOptions`; `?p=` unparsed; non-member not refused.

- [ ] **Step 3: Extend StartHttpOptions + request identity parsing**

`packages/daemon/src/http.ts`:
- Add to `StartHttpOptions`: `workspace?: { name: string; founderRoot: string };`
- In the server request handler, parse identity from `req.url` for `/mcp`:

```ts
function parseRepo(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url, 'http://127.0.0.1').searchParams.get('p'); } catch { return null; }
}
```

- The idle timer must not fire for workspace daemons (`idleTimeoutSec: 0` ⇒ skip the interval; mirror existing guard by only scheduling when `opts.idleTimeoutSec > 0`).

- [ ] **Step 4: Bind workspace store + per-member context**

In `startHttpServer`, when `opts.workspace` is set:

```ts
const wsName = opts.workspace.name;
const reg = readWorkspaceRegistry(wsName) ?? ensureWorkspaceRegistry(wsName);
const wsStore = await openStore({
  projectId: wsName,
  root: opts.workspace.founderRoot,
  dbPath: workspaceStoreDbPath(wsName),
}).catch(() => undefined);
// ONE workspace memory engine (shared across members):
// reuse the embedder block already in http.ts, then:
const wsMemory = wsStore ? buildMemoryEngine(wsStore, opts.project, /* ...same args as today... */) : undefined;
```

Create a small per-request helper that, given `repo` (from `?p=`), resolves the member's `project` + project store + context/workflow engines lazily into a `Map`, and refuses when `repo` is not in the freshly-read registry (return an `{ok:false,error:'<repo> is not a member of workspace <name>'} `envelope instead of building a server). Store the map keyed by repo and drop members no longer in the registry on each request.

Wire `/health` for workspace mode to return `workspace: wsName` and, when a `?p=` is present, `projectId: repo`.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/test/workspace-routing.test.ts packages/daemon/test/http.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/daemon/src/http.ts packages/daemon/src/server.ts packages/daemon/src/index.ts packages/daemon/test/workspace-routing.test.ts
git commit -m "feat(daemon): workspace http multiplexer (?p= member routing, shared memory store)"
```

---

### Task 6: Feed — cursor KV + changes_since + await_changes long-poll (W3)

**Files:**
- Create: `packages/daemon/src/feed.ts` (KV cursor helpers + waiter registry)
- Modify: `packages/daemon/src/server.ts` (register `changes_since`, `await_changes` when the memory engine is a workspace engine; stamp provenance on `memory_save`)
- Modify: `packages/daemon/src/index.ts`
- Test: Create `packages/daemon/test/workspace-feed.test.ts`

**Interfaces:**
- Consumes: `Store.getState/setState`; workspace memory engine (Task 5); `ServerContext.memory`.
- Produces:
  - `const CURSOR_KEY = 'workspace:cursor'`, `const FEED_KEY = 'workspace:feed'`
  - `interface FeedEntry { cursor: number; kind: 'save'|'supersede'|'forget'; id: string; repo: string; type: string; summary: string; ts: number; }`
  - `bumpCursor(store): number` — RMW `workspace:cursor` +1, returns new value (atomic via sync store)
  - `appendFeed(store, entry: Omit<FeedEntry,'cursor'>): FeedEntry` — stamps cursor via `bumpCursor`, appends to `workspace:feed` array (ring, keep last 500)
  - `changesSince(store, cursor): { cursor: number; changes: FeedEntry[] }`
  - `interface FeedWaiter { resolve(): void }` + module-level `registerWaiter()/wakeFeedWaiters()` used by `await_changes` (single-writer daemon ⇒ in-process only)

- [ ] **Step 1: Write the failing test**

```ts
// packages/daemon/test/workspace-feed.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openStore } from '@noir-ai/store';
import { appendFeed, changesSince, clearFeedState } from '../src/feed.js';

let root: string;
let store: Awaited<ReturnType<typeof openStore>>;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'noir-wsfeed-'));
  store = await openStore({ projectId: 'demo', root });
});
afterEach(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });

describe('workspace feed', () => {
  it('assigns monotonic cursors and reports changes since a cursor', () => {
    clearFeedState(store);
    const e1 = appendFeed(store, { kind: 'save', id: 'a', repo: 'be', type: 'decision', summary: 'one', ts: 1 });
    const e2 = appendFeed(store, { kind: 'supersede', id: 'b', repo: 'fe', type: 'fact', summary: 'two', ts: 2 });
    expect(e2.cursor).toBeGreaterThan(e1.cursor);
    const since0 = changesSince(store, 0);
    expect(since0.changes).toHaveLength(2);
    const since1 = changesSince(store, e1.cursor);
    expect(since1.changes.map((c) => c.id)).toEqual(['b']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/daemon/test/workspace-feed.test.ts`
Expected: FAIL — module `../src/feed.js` not found.

- [ ] **Step 3: Implement the feed module**

```ts
// packages/daemon/src/feed.ts
import type { Store } from '@noir-ai/store';

export const CURSOR_KEY = 'workspace:cursor';
export const FEED_KEY = 'workspace:feed';
export const FEED_RING_LIMIT = 500;

export interface FeedEntry { cursor: number; kind: 'save' | 'supersede' | 'forget'; id: string; repo: string; type: string; summary: string; ts: number; }

export function clearFeedState(store: Store): void {
  store.setState(CURSOR_KEY, 0);
  store.setState(FEED_KEY, []);
}
export function currentCursor(store: Store): number {
  return store.getState<number>(CURSOR_KEY) ?? 0;
}
export function bumpCursor(store: Store): number {
  const next = currentCursor(store) + 1;
  store.setState(CURSOR_KEY, next);
  return next;
}
export function appendFeed(store: Store, entry: Omit<FeedEntry, 'cursor'>): FeedEntry {
  const full: FeedEntry = { ...entry, cursor: bumpCursor(store) };
  const feed = store.getState<FeedEntry[]>(FEED_KEY) ?? [];
  feed.push(full);
  if (feed.length > FEED_RING_LIMIT) feed.splice(0, feed.length - FEED_RING_LIMIT);
  store.setState(FEED_KEY, feed);
  return full;
}
export function changesSince(store: Store, cursor: number): { cursor: number; changes: FeedEntry[] } {
  const feed = store.getState<FeedEntry[]>(FEED_KEY) ?? [];
  return { cursor: currentCursor(store), changes: feed.filter((e) => e.cursor > cursor) };
}

// --- long-poll waiters (single-daemon process only) ---
type Waiter = { cursor: number; resolve: () => void };
let waiters: Waiter[] = [];
export function wakeFeedWaiters(store: Store): void {
  const cursor = currentCursor(store);
  const ready = waiters.filter((w) => w.cursor < cursor);
  waiters = waiters.filter((w) => w.cursor >= cursor);
  for (const w of ready) w.resolve();
}
export function waitForFeedChange(store: Store, cursor: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = () => { if (currentCursor(store) > cursor) return resolve(true); };
    probe();
    const timer = setTimeout(() => { waiters = waiters.filter((w) => w.resolve !== release); resolve(false); }, timeoutMs);
    const release = () => { clearTimeout(timer); resolve(true); };
    waiters.push({ cursor, resolve: release });
  });
}
```

(Trim the helper so each waiter resolves exactly once — `release` clears the timer and resolves.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/daemon/test/workspace-feed.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire tools + provenance into the workspace server**

In `packages/daemon/src/server.ts`, when the daemon is in workspace mode (context has the workspace memory engine + a handle to the workspace store), register:

```ts
// after memory_save succeeds, stamp provenance + feed:
server.registerTool('memory_save', { /* ... existing schema + optional repo/supersedes ... */ },
  async (input) => {
    if (storeDegraded) return textResult({ ok: false, degraded: true, error: '...' });
    const obs = await memory.save({
      content: input.content,
      type: input.type,
      concepts: input.concepts,
      files: input.files,
      importance: input.importance,
      sessionId: input.sessionId,
      supersedes: input.supersedes,
      repo: wsRepo,           // stamped from ?p= — NEVER from caller
      status: 'active',
    });
    appendFeed(wsStore, { kind: 'save', id: obs.id, repo: wsRepo, type: String(obs.type), summary: summarize(obs.content), ts: Date.now() });
    wakeFeedWaiters(wsStore);
    return textResult({ ok: true, id: obs.id, observation: obs });
  });
```

And register feed tools (only in workspace mode):

```ts
server.registerTool('changes_since', { description: 'List workspace memory changes newer than a cursor (id + one-line summary; fetch full entries via memory_recall by id/query).', inputSchema: { cursor: z.number().int().min(0).describe('Last cursor seen (0 = everything).') } },
  async ({ cursor }) => textResult({ ok: true, ...changesSince(wsStore, cursor) }));

server.registerTool('await_changes', { description: 'Long-poll: resolve as soon as the workspace feed advances past cursor, or on timeout. Returns the current cursor + any new changes.', inputSchema: { cursor: z.number().int().min(0), timeoutMs: z.number().int().min(0).max(25000).optional() } },
  async ({ cursor, timeoutMs }) => {
    const timeout = timeoutMs ?? 5000;
    await waitForFeedChange(wsStore, cursor, timeout);
    return textResult({ ok: true, timedOut: false, ...changesSince(wsStore, cursor) });
  });
```

Guard so these are ONLY registered in workspace mode; add the server `instructions` string in workspace mode telling agents to call `changes_since`/`await_changes` at turn boundaries (server instructions live in the `McpServer` options — set it when constructing the workspace server).

- [ ] **Step 6: Run feed + routing tests together**

Run: `pnpm vitest run packages/daemon/test/workspace-feed.test.ts packages/daemon/test/workspace-routing.test.ts packages/daemon/test/http.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/daemon/src/feed.ts packages/daemon/src/server.ts packages/daemon/src/index.ts packages/daemon/test/workspace-feed.test.ts
git commit -m "feat(daemon): workspace change feed (cursor, changes_since, await_changes long-poll)"
```

---

### Task 7: CLI — workspace commands + `.mcp.json` rewrite/restore + memory routing (W4)

**Files:**
- Create: `packages/cli/src/commands/workspace.ts`
- Create: `packages/cli/src/workspace-mcp.ts`
- Modify: `packages/cli/src/commands/daemon.ts` (daemonStart gains `--workspace`)
- Modify: `packages/cli/src/daemon-client.ts` (workspace-aware memory routing + read-only fallback to workspace store)
- Modify: `packages/cli/src/commands/memory.ts` (route via workspace marker when present)
- Modify: `packages/cli/src/bin.ts` (`daemon start --workspace <name>`, `daemon join <name>`, new `workspace` group)
- Test: Create `packages/cli/test/workspace-commands.test.ts`

**Interfaces:**
- Consumes: core workspace helpers (Task 2), daemon workspace record/ensure/spawn (Task 4), adapter `emitMcpConfig`/`mcpConfigPath`, `resolveAdapter`, `resolveNoirCommand`, `assertLocalhostUrl` (init.ts:235), `CliOptions`, `fail`/`EXIT`, conflict seam via `buildConflictOpts` in `packages/cli/src/conflict.ts`.
- Produces:
  - `daemonStart(opts & { workspace?: string })` — when `workspace` set: ensure workspace registry exists, upsert founding member (current project), start/ensure the workspace daemon, write the join marker, rewrite `.mcp.json`.
  - `daemonJoin(opts & { name: string })` — registry must exist (else fail with guidance to `start --workspace` from the founder), upsert current project as member, ensure the workspace daemon, write marker, rewrite `.mcp.json`.
  - `workspaceList()`, `workspaceStatus(name?)`, `workspaceLeave()`, `workspaceStop(name?)` handlers.
  - `.mcp.json` rewrite helper: `writeWorkspaceHttpEntry(root, host, url, projectId)` → `{ mcpServers: { ...existing, noir: { type:'http', url: `${url}?p=${projectId}` } } }`; restore helper `writeStdioEntry(root, host, command)`; both reuse `buildMcpServersJson` + preserve the user's other servers, and refuse to clobber a `.mcp.json` that does not look Noir-emitted unless `--force`.
  - Marker-aware memory routing: when `readWorkspaceMarker(cwd)` is present, `memory save|recall|search|sessions|forget|capture` target the workspace daemon URL (`/mcp?p=<projectId>`), and the daemon-down read fallback opens the workspace store read-only (`dbPath` override, Task 1).

- [ ] **Step 1: Write the failing command test (join writes marker + rewrites .mcp.json)**

```ts
// packages/cli/test/workspace-commands.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths, readWorkspaceMarker, ensureWorkspaceRegistry, upsertWorkspaceMember } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonJoin } from '../src/commands/daemon.js';
import { EXIT, inferExitCode } from '../src/output.js';

let home: string;
let root: string;
let origCwd: string;
const out: string[] = [];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noir-wscli-home-'));
  process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
  process.env.NOIR_DAEMON_JSON = join(home, 'daemon.json');
  root = mkdtempSync(join(tmpdir(), 'noir-wscli-repo-'));
  origCwd = process.cwd();
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), 'fe-repo\n', 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
  process.chdir(root);
});
afterEach(() => { process.chdir(origCwd); rmSync(home, { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }); });

describe('noir daemon join', () => {
  it('writes the join marker + an http .mcp.json entry when the workspace exists', async () => {
    // founder already created the workspace (registry present)
    ensureWorkspaceRegistry('demo');
    // stub daemon ensure to avoid really spawning: see note below
    const err: unknown = await run(() => daemonJoin({ name: 'demo' })); // run() = capture-stdout helper from the repo
    // With the ensure/spawn layer stubbed in tests, assert the marker + .mcp.json rewrite happened.
    expect(readWorkspaceMarker(root)).toBe('demo');
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { type?: string; url?: string }> };
    expect(mcp.mcpServers.noir?.type).toBe('http');
    expect(mcp.mcpServers.noir?.url).toContain('?p=fe-repo');
    expect(err).toBeUndefined();
  });

  it('fails cleanly when the workspace does not exist', async () => {
    const r = await run(() => daemonJoin({ name: 'missing' }));
    expect(inferExitCode(r.err)).toBe(EXIT.ERROR);
  });
});
```

Follow the repo's CLI test pattern (`run()` capture helper, `vi.mock('@noir-ai/daemon', ...)` stubbing `ensureWorkspaceDaemonRunning`/`spawnDetachedWorkspaceDaemon` — mirror `status.test.ts`'s `vi.mock` usage) so the command under test does not really spawn a detached process. Where `daemonJoin` needs the workspace daemon to exist (for the URL), have the mocked ensure return `{ url: 'http://127.0.0.1:0/mcp', port: 0, started: true, stop: async () => {} }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/test/workspace-commands.test.ts`
Expected: FAIL — `daemonJoin` not exported / `workspace` handling missing.

- [ ] **Step 3: Implement the .mcp.json rewrite module**

```ts
// packages/cli/src/workspace-mcp.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAdapter, type HostId } from '@noir-ai/adapters';
import { resolveNoirCommand } from '@noir-ai/core';
import { fail, EXIT } from './output.js';

function mcpPathFor(root: string, host: HostId): string {
  const adapter = resolveAdapter(host);
  const rel = adapter.mcpConfigPath?.(root) ?? join(root, '.mcp.json');
  return rel;
}

/** Rewrite ONLY the `noir` server entry to a streamable-http URL, preserving other servers. */
export function writeWorkspaceHttpEntry(root: string, host: HostId, url: string, projectId: string, opts: { force?: boolean }): void {
  const p = mcpPathFor(root, host);
  const existing = readFileSafe(p);
  if (existing !== null && !isNoirEmitted(existing) && opts.force !== true) {
    fail(EXIT.ERROR, `Refusing to rewrite ${p}: it does not look like a Noir-emitted config (add --force to overwrite).`, {});
  }
  const base = existing !== null ? JSON.parse(existing) as { mcpServers?: Record<string, unknown> } : {};
  const noir = { type: 'http', url: `${url}?p=${projectId}` };
  const next = { ...base, mcpServers: { ...(base.mcpServers ?? {}), noir } };
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

/** Restore the `noir` entry to stdio (used by leave / workspace stop). */
export function writeStdioEntry(root: string, host: HostId, opts: { force?: boolean }): void {
  const p = mcpPathFor(root, host);
  const existing = readFileSafe(p);
  if (existing !== null && !isNoirEmitted(existing) && opts.force !== true) {
    fail(EXIT.ERROR, `Refusing to rewrite ${p}: it does not look like a Noir-emitted config (add --force to overwrite).`, {});
  }
  const base = existing !== null ? JSON.parse(existing) as { mcpServers?: Record<string, unknown> } : {};
  const noir = { command: resolveNoirCommand(), args: ['mcp', 'serve', '--stdio'] };
  const next = { ...base, mcpServers: { ...(base.mcpServers ?? {}), noir } };
  writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
}

function readFileSafe(p: string): string | null {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}
function isNoirEmitted(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { mcpServers?: Record<string, unknown> };
    const noir = parsed.mcpServers?.noir as { command?: unknown; type?: unknown } | undefined;
    return Array.isArray(noir?.command ? [noir.command] : []) || noir?.type === 'http' || noir?.type === undefined && noir?.command === 'noir';
  } catch {
    return false;
  }
}
```

Note: use `resolveAdapter`/`HostId` from `@noir-ai/adapters` and assert localhost URL via the exported `assertLocalhostUrl` from `./init.js` (init.ts:235) on `url` before writing.

- [ ] **Step 4: Add the CLI command handlers + wire bin.ts**

`packages/cli/src/commands/daemon.ts` — add `workspace?: string` to `DaemonStartOptions`; branch in `daemonStart`:

```ts
if (opts.workspace !== undefined) {
  return await daemonStartWorkspace({ ...opts, name: opts.workspace }); // founder path
}
```

Add `daemonStartWorkspace`, `daemonJoin` (in `commands/daemon.ts` or `commands/workspace.ts`), plus `workspaceList/workspaceStatus/workspaceLeave/workspaceStop` in `packages/cli/src/commands/workspace.ts`. Each calls core registry helpers + `ensureWorkspaceDaemonRunning`/`spawnDetachedWorkspaceDaemon` from `@noir-ai/daemon`, writes/clears the marker (`writeWorkspaceMarker`/`clearWorkspaceMarker`), and calls the rewrite helpers above. Follow the existing `daemonStart` output envelope shape (`{ ok:true, data:{ mode, pid?, port?, url?, reused? } }`), human output via `info/log/spinner`, JSON via stdout.

`packages/cli/src/bin.ts`:
- `daemonGrp.command('start')` — add `.option('--workspace <name>', 'start a shared workspace daemon (cross-repo context)')`, thread `workspace` into the action's conditional spread.
- `daemonGrp.command('join')` — `.argument('<name>', 'workspace name')` → `daemonJoin({ ...toCliOptions(g), name })`.
- New `workspaceGrp = program.command('workspace')` with `list|status|leave|stop` (mirror the memory group pattern), fallthrough usage action.

- [ ] **Step 5: Marker-aware memory routing**

`packages/cli/src/daemon-client.ts` — add a helper the memory commands use: when `readWorkspaceMarker(cwd)` is present and the repo is a member, resolve the **workspace** daemon (its own record file, Task 4), connect to `/mcp?p=<projectId>`, and on daemon-down fall back to an in-process **read-only** workspace store open (`openStore({ projectId, root, dbPath, readonly:true })`). Implement as `withWorkspaceDaemon<T>(opts, fn)` + a read fallback `withWorkspaceRead<T>(fn)` (mirror `withDaemon`/`withInProcessRead`). `commands/memory.ts`: each handler, when `readWorkspaceMarker(process.cwd()) !== null`, calls the workspace variants; otherwise today's project paths (unchanged). Expose a tiny helper `workspaceRoutingTarget(root)` returning `{ name, projectId } | null`.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/cli/test/workspace-commands.test.ts`
Then the memory + daemon-client suites still green:
`pnpm vitest run packages/cli/test/memory.test.ts packages/cli/test/daemon-client.test.ts` (use actual existing test filenames under `packages/cli/test/`).
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/commands/daemon.ts packages/cli/src/commands/workspace.ts packages/cli/src/workspace-mcp.ts packages/cli/src/daemon-client.ts packages/cli/src/commands/memory.ts packages/cli/src/bin.ts packages/cli/test/workspace-commands.test.ts
git commit -m "feat(cli): workspace commands (start/join/list/status/leave/stop) + .mcp.json rewrite + memory routing"
```

---

### Task 8: Capture — engine `saveCaptured` + `noir memory capture` CLI + `memory_capture` daemon tool (W5)

**Files:**
- Modify: `packages/memory/src/engine.ts` + `types.ts` + `index.ts` (saveCaptured source override)
- Modify: `packages/daemon/src/server.ts` (register `memory_capture` when memory present)
- Create: `packages/cli/src/commands/memory-capture.ts` (or fold into `commands/memory.ts`)
- Modify: `packages/cli/src/bin.ts` (`memory capture <file>`)
- Test: Create `packages/memory/test/engine-capture.test.ts` + `packages/cli/test/memory-capture.test.ts`

**Interfaces:**
- Consumes: capture mapper `toSaveInput`, `CaptureEvent`, `captureSource` from `@noir-ai/memory`; engine.save.
- Produces:
  - `MemoryEngine.saveCaptured(input: SaveInput, eventType: CaptureEventType): Promise<Observation>` — same write path as `save` but stamps `source: captureSource(eventType)` instead of `'explicit'`. (Adds the provenance seam `capture.ts` header promised for "a dedicated noir memory capture command (S9)".)
  - daemon MCP tool `memory_capture` `{ content: string; eventType?: string }` → calls `memory.saveCaptured` with `source = captureSource(eventType ?? 'Stop')`.
  - CLI `noir memory capture [file]` — read transcript file (or stdin), distill to a `{ summary }` payload, call the daemon `memory_capture` tool; in a joined repo it routes via the workspace daemon (Task 7). Never installs hooks; manual only.

- [ ] **Step 1: Write the failing engine test**

```ts
// packages/memory/test/engine-capture.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryEngine } from '../src/engine.js';
import { fakeEmbedFn } from './fake-embed.js';

let root: string; let store: Awaited<ReturnType<typeof openStore>>; let projectId: string;
beforeEach(async () => { root = mkdtempSync(join(tmpdir(), 'noir-mem-cap-')); projectId = createProjectId(); store = await openStore({ projectId, root }); });
afterEach(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });

describe('saveCaptured', () => {
  it('persists with a capture provenance source', async () => {
    const mem = createMemoryEngine({ store, root, projectId, embed: fakeEmbedFn() });
    const obs = await mem.saveCaptured({ content: 'BE session distilled decision: drop offset param' }, 'Stop');
    expect(obs.source).toBe('auto:stop');
    const hit = await mem.recall('offset param decision');
    expect(hit[0]?.source).toBe('auto:stop');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/memory/test/engine-capture.test.ts`
Expected: FAIL — `saveCaptured` missing.

- [ ] **Step 3: Implement `saveCaptured`**

`packages/memory/src/engine.ts`: refactor the private write to accept a source:

```ts
private async saveInternal(input: SaveInput, source: MemorySource = 'explicit'): Promise<Observation> {
  // ... existing body, but set source on the observation:
  source,
}
async save(input: SaveInput): Promise<Observation> {
  return this.serialized(() => this.saveInternal(input, 'explicit'));
}
async saveCaptured(input: SaveInput, eventType: CaptureEventType): Promise<Observation> {
  return this.serialized(() => this.saveInternal(input, captureSource(eventType)));
}
```

Import `captureSource`, `type CaptureEventType` from `./capture.js` in `engine.ts`; add `saveCaptured` to the `MemoryEngine` interface in `types.ts`; re-export from the barrel if needed.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run packages/memory/test/engine-capture.test.ts packages/memory/test/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: daemon tool + CLI verb**

In `packages/daemon/src/server.ts`, inside the `if (ctx.memory)` block add `memory_capture`:

```ts
server.registerTool('memory_capture', {
  description: 'Distill a transcript/notes payload into a cross-session memory observation with auto capture provenance (manual only — never auto-installed hooks).',
  inputSchema: {
    content: z.string().min(1).describe('Distilled content to remember (a decision, non-obvious conclusion, or correction).'),
    eventType: z.string().optional().describe('Capture hook label; defaults to Stop.'),
  },
}, async ({ content, eventType }) => {
  if (storeDegraded) return textResult({ ok: false, degraded: true, error: 'store is read-only (daemon down)' });
  try {
    const obs = await memory.saveCaptured({ content }, (eventType as CaptureEventType) ?? 'Stop');
    return textResult({ ok: true, id: obs.id, observation: obs });
  } catch (err) {
    return textResult({ ok: false, degraded: true, error: errorMessage(err) });
  }
});
```

CLI (`commands/memory.ts` or a new file): `memoryCapture(opts & { file?: string; content?: string })` — resolve content from `--file <path>` (read file) or stdin when piped (`!process.stdin.isTTY`), else interactive `clack.text` (mirror `resolveContent` in memory.ts:274); non-interactive + no source → `fail(EXIT.USAGE, 'memory capture requires --file <path> or piped stdin')`. Then route (workspace-aware when a marker is present, else project daemon) and call `memory_capture`.

`bin.ts` memory group: add `.command('capture').argument('[file]', 'transcript/notes file (or pipe stdin)').option('--content <text>', 'inline distilled content')`.

- [ ] **Step 6: Run the capture tests**

Run: `pnpm vitest run packages/memory/test/engine-capture.test.ts packages/cli/test/memory-capture.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/memory/src/engine.ts packages/memory/src/types.ts packages/memory/src/capture.ts packages/memory/test/engine-capture.test.ts packages/daemon/src/server.ts packages/cli/src/commands/memory.ts packages/cli/src/bin.ts packages/cli/test/memory-capture.test.ts
git commit -m "feat(memory,daemon,cli): saveCaptured source seam + memory_capture tool + noir memory capture"
```

---

### Task 9: Concurrency suite — two clients, one daemon (W6 hardening)

**Files:**
- Create: `packages/daemon/test/workspace-concurrency.test.ts`

**Interfaces:**
- Consumes: the workspace http server from Task 5 + feed from Task 6 (both now live).

- [ ] **Step 1: Write the test**

```ts
// packages/daemon/test/workspace-concurrency.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { paths, ensureWorkspaceRegistry, upsertWorkspaceMember } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';
import { startHttpServer } from '../src/http.js';
import { clearDaemonRecord } from '../src/lifecycle.js';

const home = mkdtempSync(join(tmpdir(), 'noir-wsconc-home-'));
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
process.env.NOIR_DAEMON_JSON = join(home, 'daemon.json');
const rootA = mkdtempSync(join(tmpdir(), 'noir-wsconc-a-')); // founder repo
for (const [root, id] of [[rootA, 'conc-a']] as const) {
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), `${id}\n`, 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
}
afterAll(() => { clearDaemonRecord(); rmSync(home, { recursive: true, force: true }); rmSync(rootA, { recursive: true, force: true }); });

describe('two concurrent clients on one workspace daemon', () => {
  it('sees each other interleaved without lock errors and await_changes wakes across clients', async () => {
    upsertWorkspaceMember(ensureWorkspaceRegistry('conc'), { projectId: 'conc-a', root: rootA, joinedAt: Date.now() });
    const { port, stop } = await startHttpServer({ project: { id: 'conc-a', name: 'conc', root: rootA, config: { host: 'claude' } }, idleTimeoutSec: 0, workspace: { name: 'conc', founderRoot: rootA } });
    const mk = () => new Client({ name: 'noir-conc', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
    try {
      const c1 = mk(); await c1.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?p=conc-a`)));
      const c2 = mk(); await c2.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?p=conc-a`)));
      const write = (c: Client, content: string) => c.callTool({ name: 'memory_save', arguments: { content } });
      await Promise.all([write(c1, 'c1 decision one'), write(c2, 'c2 decision two'), write(c1, 'c1 decision three')]);
      const read = await c2.callTool({ name: 'memory_recall', arguments: { query: 'decision' } });
      const env = JSON.parse((read.content?.[0] as { text: string }).text) as { ok: boolean; hits: Array<{ content: string }> };
      expect(env.ok).toBe(true);
      expect(env.hits.length).toBeGreaterThanOrEqual(3);
      // long-poll wakes: c1 holds await_changes(cursor=0), c2 writes, c1 returns within ~2s
      const poll = c1.callTool({ name: 'await_changes', arguments: { cursor: 0, timeoutMs: 25000 } });
      await new Promise((r) => setTimeout(r, 200));
      await write(c2, 'c2 wake the poller');
      const pollEnv = JSON.parse(((await poll).content?.[0] as { text: string }).text) as { ok: boolean; changes: Array<{ id: string }> };
      expect(pollEnv.ok).toBe(true);
      expect(pollEnv.changes.length).toBeGreaterThanOrEqual(1);
      await c1.close(); await c2.close();
    } finally {
      await stop(); clearDaemonRecord();
    }
  }, 30000);
});
```

The concurrent writes must not throw `database is locked`; the long-poll must return promptly when the other client writes.

- [ ] **Step 2: Run test**

Run: `pnpm vitest run packages/daemon/test/workspace-concurrency.test.ts`
Expected: PASS. If it flakes, run twice; a genuine failure is a bug in Task 5/6 wiring (escalate, do not weaken the test).

- [ ] **Step 3: Commit**

```bash
git add packages/daemon/test/workspace-concurrency.test.ts
git commit -m "test(daemon): two-client concurrency + cross-client await_changes wake"
```

---

### Task 10: Docs + ADR-0009 + roadmap + full gate (W6)

**Files (all under `/Users/agaaaptr/Documents/Personal/Project/AI/noir`):**
- Create: `docs/how-to/shared-workspaces.md`
- Modify: `docs/getting-started.md`
- Modify: `docs/reference/cli.md`
- Modify: `docs/reference/config.md` (regenerate — config.md is `.describe()`-driven)
- Modify: `docs/reference/mcp-tools.md` (regenerate — tool list incl. `changes_since`, `await_changes`, `memory_capture`)
- Modify: `docs/explanation/architecture.md`
- Modify: `docs/decisions/0009-shared-workspaces.md` (create ADR)
- Modify: `docs/roadmap/STATUS.md`, `docs/roadmap/releases.md`, `docs/roadmap/backlog.md`, `docs/roadmap/capability-09-platform-evolution.md`
- Modify: `CHANGELOG.md` (root) — add the 1.13.0 section at release time; this task adds the entry.

**Steps**

- [ ] **Step 1: New how-to guide**

`docs/how-to/shared-workspaces.md` — exact user-facing commands (must match shipped reality):

```markdown
# Sharing context across repositories (workspaces)

Two sessions in DIFFERENT repos can share decision memory through one detached
daemon — no handoff documents. Default transport stays stdio; sharing is
explicit.

## 1. Start a workspace (from the backend repo)
noir daemon start --workspace my-app
# → starts the workspace daemon (foreground), joins this repo, points .mcp.json at it

## 2. Join from the other repo (frontend)
noir daemon join my-app

## 3. Use it
In each session, memory_save writes are visible to the other; call
changes_since / await_changes to see what the other session recorded.
Backend:   memory_save { content: "GET /users returns {items: User[]}" }
Frontend:  memory_recall { query: "users list pagination" }

## 4. Status & stop
noir workspace status
noir workspace leave      # this repo stops sharing, .mcp.json back to stdio
noir workspace stop       # stop the daemon (membership kept)

## Manual capture
cat notes.md | noir memory capture        # manual distill, never auto-hooked
```

- [ ] **Step 2: Regenerate reference docs**

Run: `pnpm docs:generate` (config.md + mcp-tools.md are generated from `.describe()` + the tool registry; `noir memory capture` appears in the CLI list).
Then hand-audit `docs/reference/cli.md` for the new `daemon start --workspace`, `daemon join`, and `workspace` group; add the how-to link to `docs/getting-started.md`; add a workspace paragraph to `docs/explanation/architecture.md`.

- [ ] **Step 3: ADR-0009**

Create `docs/decisions/0009-shared-workspaces.md` recording (extract spec §16): workspace unit + cross-repo scope, stdio default preserved, memory-only slice boundary, long-poll feed (no content push, citing spec §2), provenance stamping from request identity, capture manual-only.

- [ ] **Step 4: Roadmap sync**

- `docs/roadmap/STATUS.md`: set Active capability/slice to the shared-workspace slice under C5 (add to the status table `C5` row's current-phase note) and fill "Next milestone" with the shared-workspace spec link.
- `docs/roadmap/releases.md`: version target v1.13.0 + a release-sequence note (1.13.0 shared workspaces; `1.12.0` stable was superseded — it shipped beta-only as `1.12.0-beta.1`).
- `docs/roadmap/backlog.md`: resolve/annotate the event-bus item → `await_changes` long-poll shipped in 1.13; close the `memory capture` gap line; add a resolved-history entry.
- `docs/roadmap/capability-09-platform-evolution.md`: mark the auto-capture slice's CLI portion done (DONE line) and note the workspace slice in C5.
- `docs/roadmap/roadmap.manifest.yaml`: bump the package note / active fields.
- `CHANGELOG.md` (root): add a `1.13.0` section summarizing the feature (at release time; entry content drafted here).

- [ ] **Step 5: docs:validate**

Run: `pnpm docs:validate`
Expected: PASS (no broken links, no stale version refs, registry integrity).

- [ ] **Step 6: Full gate**

Run: `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add docs/how-to/shared-workspaces.md docs/getting-started.md docs/reference/cli.md docs/reference/config.md docs/reference/mcp-tools.md docs/explanation/architecture.md docs/decisions/0009-shared-workspaces.md docs/roadmap/STATUS.md docs/roadmap/releases.md docs/roadmap/backlog.md docs/roadmap/capability-09-platform-evolution.md docs/roadmap/roadmap.manifest.yaml CHANGELOG.md
git commit -m "docs(workspace): shared-workspaces how-to + ADR-0009 + roadmap/refs sync"
```

---

## Self-Review

**Spec coverage (spec §1–§16 → tasks):**
- §3 goals 1–4 (cross-repo share, stdio default, provenance, isolation): Task 2, 5, 6, 7 ✓
- §3 goal 5 (`noir memory capture`): Task 8 ✓
- §4 workspace location/registry/daemon record: Task 2, 4 ✓
- §5 command surface (`daemon start --workspace`, `join`, `workspace list/status/leave/stop`, join marker, idle default): Task 4, 7 ✓
- §6 multiplexing (`?p=` routing, single-writer per DB, non-member refusal, /health): Task 5 ✓
- §7 data model (repo/status/cursor/supersedes, append-only supersede, soft forget, feed): Task 3, 6 ✓
- §8 tools (`changes_since`, `await_changes`, provenance framing, instructions string): Task 5, 6 ✓
- §9 capture manual: Task 8 ✓
- §10 security/isolation (localhost, membership, stamped provenance): Task 2, 5 ✓
- §12 tests 1–7 (registry, routing, feed, concurrency, CLI commands, memory-capture, regression anchors): Task 2/3/4/5/6/7/8/9 tests ✓ (regression anchor runs included in each task's test step)
- §13 documentation plan: Task 10 ✓
- §14 slices W1–W6: Task 2 (W1), 4 (W1/W4), 3/5 (W2), 6 (W3), 7 (W4), 8 (W5), 9/10 (W6) ✓

**Known deltas vs spec (flagged deliberately):**
1. Feed lives in `@noir-ai/daemon` (daemon-side KV + waiters), not `@noir-ai/memory` — the feed is a daemon concern over the shared workspace store handle; memory stays host-agnostic. Consistent with spec §7.2 ("daemon is one process… in-process waiters").
2. `memory_forget` soft-forget is engine-flagged (`softForget`) rather than a store-wide semantic change, so project-store forget semantics are untouched (backward compatibility).
3. Supersede/uniqueness: Task 5 `memory_save` passes `status:'active'` + `supersedes` so the engine flips the target to `superseded` and the hydration filter hides it by default (spec §8.1).
4. `repo` provenance is a **plain string** (the canonical `projectId`), not spec §7.1's `{ projectId, root? }` object. The project invariant is "canonical ProjectId — never a filesystem path", so `root` provenance is deliberately dropped (portable, no absolute paths in the shared store).
5. `noir memory capture` reads raw file/stdin text and calls the `memory_capture` tool directly (which stamps `captureSource`); it does **not** run the pure `toSaveInput` mapper (spec §9). The capture-provenance requirement is met; the structured-event mapping step was relaxed for the manual CLI path.
6. If a member's own project store fails to open, the workspace daemon returns HTTP 500 and the CLI maps it to exit 4 "daemon not reachable" — the specific "could not open the store for member X" body is lost (the MCP handshake has no tool-result channel for it). Accepted as a known edge-case limitation; surfacing the 500 body would require changes to the shared daemon-client.

**Placeholder scan:** no TBD/TODO/“handle edge cases”; every code step carries real code or an exact file:line anchor. Two steps reference “mirror existing file X” only where the executor must copy an existing seam verbatim (embedded to reduce duplication risk) — the surrounding code is concrete.

**Type consistency:** `WorkspaceRegistry`/`WorkspaceMember` (Task 2) reused in Task 4/5/7; `FeedEntry` (Task 6) matches `changes_since`/`await_changes` result shapes used in Task 9; `saveCaptured`/`memory_capture` names consistent Task 8; `ObservationStatus` consistent Task 3/5/6. No name drift found.
