# Noir — S1 Stores Design (`@noir-ai/store`)

- **Date:** 2026-07-23
- **Status:** Reviewed (2026-07-24) — OQ-1…OQ-6 resolved (see §9); ready for implementation planning.
- **Owner:** agaaaptr
- **Spec type:** Implementation design (next slice after the walking skeleton)
- **Parent:** `docs/specs/2026-07-23-noir-toolkit-design.md` (blueprint §5.3, §6.2, §6.3, §9.2, §9.3) + `docs/superpowers/specs/2026-07-23-noir-walking-skeleton-design.md` (delivered skeleton)
- **Slice:** S1 (Stores) — roadmap v0.x. Depends on the walking-skeleton packages (`core`, `daemon`).

---

## 0. TL;DR

`@noir-ai/store` is Noir's **embedded persistence layer**: one in-process SQLite database (no sidecar server) augmented with **FTS5** (full-text, BM25) and **sqlite-vec** (vector kNN). It provides the storage primitives that S6 (context management) and S7 (memory management) build on — plus the state store the SDD engine (S4) will use. The daemon opens and owns it as the **single writer** (D7).

S1's acceptance: ***persistence exists and is queryable*** — the daemon opens a project-scoped DB; a round-trip works (write a doc → FTS5 returns it ranked by BM25 with a window-extracted snippet; write a vector → kNN returns the nearest neighbours).

**Tech (grounded via websearch, 2026-07-23):** `better-sqlite3` (engine) + `sqlite-vec` (vectors, loadExtension) + FTS5 (built-in). Embeddings are **not** in S1 — the store holds 384-dim blobs and exposes kNN; the embedding model (`@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2`) is injected by S6/S7.

---

## 1. Goals & scope

### 1.1 In scope
- New workspace package `@noir-ai/store` (depends on `@noir-ai/core`).
- A `Store` interface + `SqliteStore` implementation over `better-sqlite3`.
- Storage primitives:
  - **State KV** — typed key/value for workflow state + SDD artifact metadata.
  - **FTS5 index** — upsert/search documents, BM25 ranking, `snippet()` window extraction (never truncated — blueprint §9.2).
  - **Vector store** — upsert/kNN over 384-dim blobs via `sqlite-vec`.
- Schema + a lightweight versioned migration runner.
- Project-scoped DB keyed by the **canonical `ProjectId`** (never a filesystem path — D6/§9.3).
- The daemon opens/owns the store (single writer).
- **Read-only FS-fallback** (principle 5): a `Store` can be opened read-only; when the daemon is down, the diagnostic path opens it read-only directly (degraded reads, no writes).
- A diagnostic MCP tool **`store_status`** (returns `{ ok, projectId, docCount, vecCount, dbPath }`) — end-to-end daemon→store proof; degrades to read-only direct-open when the daemon is down.
- Markdown export (minimal — memory rows → `.noir/memory/*.md`); full governance in S7.
- Tests: DB round-trips, FTS5 BM25 + snippet, vec kNN, migrations, project-ID keying.

### 1.2 Out of scope (later slices)
- **S6** context management: file watcher, incremental indexing, RRF fusion of BM25 + kNN, essential-brief budgeting, the `noir.context_search` MCP tool.
- **S7** memory management: typed memory lifecycle, auto-capture, recall consolidation, governance (`forget`/audit), the `noir.recall`/`noir.memory_save` MCP tools.
- **Embeddings model** (transformers.js / MiniLM) — S6/S7 inject an `EmbedFn`; S1 only defines the contract + stores the blobs.
- The MCP tool surface that *exposes* the store (S6/S7). S1 may add one diagnostic tool (`store_status`) only if needed to prove the daemon→store seam — see open question OQ-5.

---

## 2. Decisions (drafted; confirm at review)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| DS-1 | Embedded engine | **`better-sqlite3`** (MIT) | Fastest Node SQLite driver; synchronous API fits SQLite's single-writer model; mature/battle-tested; FTS5 built in; `loadExtension` loads sqlite-vec. `node:sqlite` (Node 22 built-in) is a future zero-native-build alternative but is still experimental and less mature — note, don't adopt for S1. ([better-sqlite3 #1266](https://github.com/WiseLibs/better-sqlite3/issues/1266)) |
| DS-2 | Vectors | **`sqlite-vec`** via `better-sqlite3` `loadExtension` + `sqlite-vec` npm helper | In-process, no server; "small, fast-enough, runs anywhere"; matches blueprint §9.3. ([sqlite-vec JS docs](https://alexgarcia.xyz/sqlite-vec/js.html), [repo](https://github.com/asg017/sqlite-vec)) |
| DS-3 | Full-text | **FTS5** with `bm25()` ranking + `snippet()` | Built into SQLite; BM25 is the standard ranker; `snippet()` yields window-extracted snippets (never truncated — §9.2). Use **external-content** FTS5 tables pointing at source rows to avoid duplicating content. ([SQLite FTS5](https://www.sqlite.org/fts5.html)) |
| DS-4 | Single writer | **The daemon opens/owns the store** (D7) | The daemon is the runtime authority; CLI/hosts reach the store through the daemon (MCP), not by opening the file directly. This is what makes cross-session shared state real (the daemon's reason to exist, proven by the walking skeleton's Gate 2). |
| DS-5 | DB location + keying | Project-local primary: `.noir/store/<projectId>.db`; optional user-global mirror `~/.noir/store/<projectId>.db` | Keyed by canonical `ProjectId`, **never** a filesystem path (paths break across machines — §9.3). Project-local is the S1 default; the user-global mirror (for cross-project memory) is wired in S7. **(OQ-1: confirm project-local primary for S1.)** |
| DS-6 | Migrations | Lightweight versioned runner (`schema_version` table + ordered SQL files) | No ORM; explicit, inspectable, reversible-in-principle. Keeps the "usable as framework, no fragility" stance (§9.2 rejects Context Mode's `heal-*` script sprawl). |
| DS-7 | API shape | `Store` interface (no I/O in types) + `SqliteStore` impl | Interface in `@noir-ai/store` (this package *is* allowed I/O, unlike `core`); enables a future in-memory fake for fast tests + an alternative backend. |
| DS-8 | Embeddings | **Not in S1.** Store holds 384-dim blobs + kNN; `EmbedFn` is a typed seam S6/S7 inject | Keeps S1 focused on storage; avoids pulling a model runtime into the store layer. Dimension pinned to **384** (MiniLM-L6-v2). |
| DS-9 | Markdown export | Minimal in S1 (memory rows → `.noir/memory/*.md`); full governance in S7 | Blueprint §6.3 wants markdown export; S1 ships the mechanic, S7 owns the lifecycle/governance. |

---

## 3. Architecture

```
┌─────────────────────────────────────────────┐
│  @noir-ai/daemon  (single writer; owns Store) │
│   └─ openStore(projectId, root) → Store       │
├─────────────────────────────────────────────┤
│  @noir-ai/store                              │
│   Store (interface)                          │
│   SqliteStore (better-sqlite3 + FTS5 + vec)  │
│   migrations/  schema/  markdown-export      │
├─────────────────────────────────────────────┤
│  @noir-ai/core  (ProjectId, types — no I/O)  │
└─────────────────────────────────────────────┘
   .noir/store/<projectId>.db   (project-local SQLite file)
```

Dependency direction: `core` ← `store` ← `daemon` (and later `cli`). `store` depends only on `core` (+ better-sqlite3, sqlite-vec). No cycles.

---

## 4. Store interface (draft)

```ts
// @noir-ai/store — the contract S6/S7 will consume
export interface Store {
  readonly projectId: ProjectId;
  close(): Promise<void>;

  // --- state KV (S4 workflow state, artifact metadata) ---
  getState<T>(key: string): T | null;
  setState<T>(key: string, value: T): void;

  // --- FTS5 full-text (S6 context index) ---
  indexDoc(doc: { id: string; source: string; content: string; meta?: Record<string, unknown> }): void;
  searchFt(query: string, opts?: { limit?: number; source?: string }): FtsHit[];
  //   FtsHit = { id; source; score: number /* bm25, lower = better */; snippet: string /* window-extracted */; meta }

  // --- vectors (S6/S7 semantic) ---
  upsertVec(id: string, vec: Float32Array, meta?: Record<string, unknown>): void;
  knn(vec: Float32Array, opts?: { limit?: number; source?: string }): VecHit[];
  //   VecHit = { id; score: number /* distance */; meta }

  // --- markdown export (S7 governance mechanic) ---
  exportMemoryMarkdown(dir: string): Promise<string[]>;

  // transactions (single-writer; daemon serializes)
  tx<T>(fn: () => T): T;
}
```

> `EmbedFn = (text: string) => Promise<Float32Array>` is defined in `store` (the seam) but **implemented** in S6/S7 (transformers.js). S1's `knn`/`upsertVec` take ready-made vectors.

---

## 5. Schema (initial migration `v1`)

```sql
-- state KV (JSON values)
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL              -- JSON
);

-- FTS5 external-content full-text index (content lives in docs; fts indexes tokens)
CREATE TABLE IF NOT EXISTS docs (
  id      TEXT PRIMARY KEY,
  source  TEXT NOT NULL,           -- e.g. 'codebase' | 'spec' | 'memory'
  content TEXT NOT NULL,
  meta    TEXT                     -- JSON
);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  id UNINDEXED, source UNINDEXED, content,
  content_rowid='rowid', tokenize='porter unicode61'
);
-- triggers keep docs_fts in sync with docs (insert/update/delete)

-- vectors (sqlite-vec); 384-dim
CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(
  embedding float[384], source TEXT, id TEXT
);

-- migration bookkeeping
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
```

Notes:
- FTS5 is **external-content** (`docs_fts` references `docs`); `snippet(docs_fts, …)` produces window-extracted snippets around matches — never a blind `head`/`tail` cut (§9.2). `tokenize='porter unicode61'` gives Porter stemming.
- `vec0` is sqlite-vec's virtual table; kNN = `SELECT id, distance FROM vec WHERE embedding MATCH ? ORDER BY distance LIMIT k`.
- BM25: `SELECT … FROM docs_fts WHERE docs_fts MATCH ? ORDER BY bm25(docs_fts) LIMIT k` (bm25 returns negative numbers; lower = more relevant).

---

## 6. Single-writer & project keying

- The daemon calls `openStore(projectId, root)` once at startup (lazy on first store-using tool). `better-sqlite3` is synchronous; the daemon serializes writes within its event loop (single process = single writer). WAL mode (`PRAGMA journal_mode=WAL`) for concurrent readers.
- The DB path is derived from `ProjectId`, not `root`: `paths.storeDb(root, projectId) → .noir/store/<projectId>.db`. Moving the project dir does not orphan the DB (the id travels with `.noir/project.id`).
- **Read-only FS-fallback** (D7/principle 5, **in scope for S1** per OQ-2): `Store` supports a read-only open (better-sqlite3 `?mode=ro` / `PRAGMA query_only=1`). When the daemon is unavailable, the CLI/diagnostic path opens the store read-only directly — **degraded reads** (KV get, FTS5 search, vec kNN work; writes fail with a clear "daemon down, read-only" error). The daemon stays the only writer. Full degraded-reads for `context_search`/`recall` arrive with S6/S7; S1 wires the mechanism + uses it in `store_status`.

---

## 7. Testing & CI

- **Unit/ integration (vitest):** temp-dir DB per test (no global state); round-trip KV; FTS5 BM25 ranking + `snippet()` window correctness (assert the snippet contains the match, not truncated); vec kNN ordering; migration runner (v1 applies; re-open is idempotent); project-ID keying (DB path uses id, not path).
- The `sqlite-vec` extension loads in CI via the `sqlite-vec` npm helper (per-platform prebuilt binary) + better-sqlite3 `loadExtension`. **OQ-3 resolved:** prebuilts cover linux + macOS (the CI matrix); if a platform ever lacks a binary, gate the vec tests (skip + reason).
- No network; embeddings are faked in S1 tests (deterministic `Float32Array`).

---

## 8. Out of scope (deferred — explicit)

| Deferred | Target | Why |
|---|---|---|
| Context indexing/watcher, RRF fusion, essential-brief | S6 | Logic on top of the store. |
| Memory lifecycle, capture, consolidation, governance, MCP tools | S7 | Logic on top of the store. |
| Embeddings model (transformers.js) | S6/S7 | Injected via `EmbedFn`. |
| Store read-only FS-fallback → **moved INTO S1** per OQ-2 | — | see §6. |
| User-global memory mirror | S7 | Cross-project memory needs identity/scope work. |

---

## 9. Open questions — RESOLVED (2026-07-24 review)

- **OQ-1 → project-local primary:** DB at `.noir/store/<projectId>.db` (travels with the project via `.noir/project.id`); user-global mirror (`~/.noir/store/`) added in S7. (confirms DS-5)
- **OQ-2 → read-only FS-fallback IN S1:** `Store` supports a read-only open; the CLI/diagnostic path opens it read-only directly when the daemon is down (degraded reads — KV/FTS/vec queries work, writes fail clearly). `store_status` uses it. Full degraded-reads for `context_search`/`recall` come with S6/S7.
- **OQ-3 → covered (controller-resolved):** `better-sqlite3` v12+ and `sqlite-vec` ship prebuilts for linux + macOS (the CI matrix); load via the `sqlite-vec` npm helper (per-platform binary). Gate vec tests (skip + reason) if a platform ever lacks a binary.
- **OQ-4 → 384-dim** (`Xenova/all-MiniLM-L6-v2`). A future model change → schema migration. (confirms DS-8)
- **OQ-5 → add `store_status` MCP tool:** returns `{ ok, projectId, docCount, vecCount, dbPath }`; end-to-end daemon→store proof + useful diagnostic; degrades to read-only direct-open when daemon down.
- **OQ-6 → hand-rolled versioned-SQL runner:** `schema_version` table + ordered SQL files (~30 lines, no dep, inspectable). (confirms DS-6)

---

## 10. References

- better-sqlite3 vs node:sqlite: https://github.com/WiseLibs/better-sqlite3/issues/1266
- sqlite-vec (JS/Node usage): https://alexgarcia.xyz/sqlite-vec/js.html · https://github.com/asg017/sqlite-vec
- Local embeddings (transformers.js + MiniLM): https://sachinsharma.dev/blogs/local-first-vector-embeddings-transformer-js-2026 · https://huggingface.co/Xenova/all-MiniLM-L6-v2
- SQLite FTS5: https://www.sqlite.org/fts5.html
- Parent blueprint: `docs/specs/2026-07-23-noir-toolkit-design.md` (§5.3, §6.2, §6.3, §9.2, §9.3)

---

## 11. Next steps

1. ~~User reviews this draft — confirm OQ-1…OQ-6.~~ **Reviewed 2026-07-24: all OQs resolved (§9).**
2. → invoke **writing-plans** to produce the S1 implementation plan (task breakdown: package scaffold → schema/migrations v1 → KV → FTS5 + snippet → vec + kNN → daemon `openStore` seam + read-only FS-fallback → `store_status` MCP tool → markdown export → tests), then subagent-driven execution.
