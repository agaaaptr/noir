# S1 Stores — Manual Acceptance Checklist

**Date:** 2026-07-24
**Task:** S1-T8 (Final verification and acceptance)
**What:** Verify the Noir embedded store exists and is queryable via the daemon→store round-trip.

---

## Acceptance Gate: daemon→store round-trip via `store_status`

### Prerequisites

1. A fresh project directory (empty or existing)
2. Noir CLI built: `pnpm build` from repo root

### Steps

#### 1. Initialize a Noir project

```bash
cd /tmp/test-noir-store          # or any empty dir
node /path/to/noir/packages/cli/dist/bin.js init
```

**Expected:** `.noir/` directory created with `project-id` file containing a UUID.

#### 2. Start the daemon

```bash
node /path/to/noir/packages/cli/dist/bin.js daemon start
```

**Expected:** Daemon process starts; logs show "Noir daemon running" and store opened successfully (or degraded read-only if writable open failed).

#### 3. Invoke `store_status` MCP tool via Claude Code

In Claude Code with the Noir MCP server connected (stdio/HTTP), invoke the `store_status` tool:

```
Claude: Use the store_status tool to report the store health.
```

**Expected response:**

```json
{
  "ok": true,
  "projectId": "<UUID from .noir/project-id>",
  "docCount": 0,
  "vecCount": 0,
  "dbPath": "/tmp/test-noir-store/.noir/store/<projectId>.db",
  "degraded": false
}
```

#### 4. Verify read-only degradation (daemon down)

Stop the daemon (Ctrl+C or `kill`), then attempt a read-only open:

In a test file or REPL:

```typescript
import { openStore } from '@noir-ai/store';
import { createProjectId } from '@noir-ai/core';
import { readFileSync } from 'node:fs';

const projectId = readFileSync('.noir/project-id', 'utf-8').trim();
const root = process.cwd();

// Open read-only (daemon is down)
const store = await openStore({ projectId, root, readonly: true });
console.log('Read-only store opened:', store.projectId);
store.close();
```

**Expected:** Read-only open succeeds without attempting migrations. Write operations (`indexDoc`, `upsertVec`, `setState`) throw with message containing "store is read-only (daemon down)".

---

## Acceptance Criteria

- [ ] `noir init` creates `.noir/project-id`
- [ ] `noir daemon start` opens the store and registers `store_status` tool
- [ ] `store_status` returns `{ok:true, projectId, docCount, vecCount, dbPath, degraded}` with correct values
- [ ] When daemon is down, read-only direct open still reports store metadata (no write operations allowed)
- [ ] Store DB exists at `.noir/store/<projectId>.db`

---

## Notes

- **Native dependencies:** `better-sqlite3` and `sqlite-vec` require native binaries. Prebuilts are fetched via `pnpm install` for Linux + macOS. If compilation fails on your platform, skip this test.
- **Degraded mode:** If the daemon cannot open the store writable (e.g., permissions), it falls back to read-only. `store_status.degraded` will be `true` in this case.
- **Counts are live:** `docCount` and `vecCount` come from the single-writer handle; they reflect the latest indexed data immediately after `indexDoc`/`upsertVec`.

---

## S1 Scope Reminder

S1 (Stores) provides the persistence layer + the daemon→store seam + the `store_status` diagnostic tool. It does **not** include (later slices — see `docs/roadmap/`):
- **Embeddings model** (transformers.js / MiniLM) — injected via `EmbedFn` in S6/S7.
- **SDD workflow engine** (S4).
- **Noir skill pack + host compiler** (S5).
- **Context management** — indexing/watcher, RRF fusion, `context_search` (S6).
- **Memory management** — typed lifecycle, capture, recall/consolidation/governance, `recall`/`memory_save` (S7).
- **Bounded model layer** (S8).
- **CLI/TUI home screen** (S9).

S1 acceptance confirms that persistence exists and is queryable (FTS5 hits + kNN + `store_status`).
