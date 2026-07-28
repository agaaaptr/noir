> **Status: RESOLVED 2026-07-25 — implemented & validated (247/247 tests). OQs resolved per docs/superpowers/plans/2026-07-24-v1.0-execution-plan.md §1.**

# Noir — S6 Context Management Design (`@noir-ai/context`)

- **Date:** 2026-07-24
- **Status:** DRAFT v0 — pending OQ-1…OQ-8.
- **Parent:** blueprint §6.2 (context index), §9.2/§9.3 (no sidecar, no truncation, `ProjectId` canonical), `2026-07-24-s6-s9-grounding-digest.md` §2/§4/§5/§8/§10, and the delivered S1 store.
- **Slice:** S6 — roadmap v1.0. Depends on `@noir-ai/store` (the `EmbedFn` seam + FTS5 + vec0) + `@noir-ai/core` (config, `ProjectId`) + `@noir-ai/daemon` (MCP registration).

---

## 0. TL;DR

`@noir-ai/context` is Noir's **embedded hybrid retrieval engine**: it fills the `EmbedFn` seam S1 declared but never implemented, indexes project files into the existing `docs` + `vec0` tables with **content-hash incremental** indexing, and answers queries with **BM25 ∪ cosine-kNN fused by Reciprocal Rank Fusion (k=60)**, then packs results into a **token budget** with **window-extracted snippets** (never truncated). Three MCP tools — `context_search`, `context_index`, `context_status` — expose it to the host, gated on a new optional `ctx.context` service exactly the way `store_status` is gated on `ctx.store`. Recall defaults to **local in-process embeddings** (`all-MiniLM-L6-v2`, 384-dim → zero vec0 migration); remote/Ollama embeddings are **opt-in and provider-explicit, never silent**. The single-writer daemon owns indexing; a read-only fallback keeps search working when the daemon is down.

---

## 1. Objective & problem

The host agent (Claude Code) loses focus on large repos because it re-reads files verbatim, flooding its context window with raw bytes. S1 gave us the storage primitives — `indexDoc`/`searchFt` (BM25), `upsertVec`/`knn` (384-dim vectors), and a declared-but-unimplemented `EmbedFn = (text:string)=>Promise<Float32Array>`. S6 turns those primitives into a working **just-in-time retrieval** layer: index the repo once (incrementally), then answer `context_search` with a small, ranked, snippet-windowed result set that fits a token budget. This is half of blueprint D6 (unified context+memory); S7 reuses the same engine for memory recall.

---

## 2. Scope

### 2.1 In scope
- New workspace package `@noir-ai/context` (depends on `@noir-ai/store` + `@noir-ai/core`; no cycles).
- The `EmbedFn` implementations behind the existing seam: **local** (`@huggingface/transformers` + `all-MiniLM-L6-v2`) default; **remote** (OpenAI/Voyage/Cohere, Matryoshka-truncated to 384) + **Ollama** as opt-in provider-explicit alternatives.
- A **chunker** (markdown-heading-aware for docs; line/token-bounded ~512 tok / 64 overlap for code).
- An **indexer** with SHA-256 content-hash incremental tracking in the store KV; on-demand default, `--watch` (chokidar) opt-in for the daemon.
- A **hybrid retriever**: BM25 (`searchFt`) ∪ cosine kNN (`knn`) fused with **RRF k=60**, weights 0.5/0.5, rank-based (no score normalization).
- A **token-budget packer**: greedy fill over the RRF-ranked list, collapse duplicate parent-docs (keep top chunk), return FTS5 windowed snippets.
- Three MCP tools — `context_search`, `context_index`, `context_status` — registered via the §4 pattern, gated on a new `ctx.context` service on `ServerContext`.
- A `context:` block in `NoirConfigSchema` (zod/v4, `.default({...})` idiom) for provider/model/flags.
- Tests: chunker, RRF, budget packer, content-hash incremental, MCP round-trip via `InMemoryTransport`, degraded read-only path, deterministic fake embeddings.

### 2.2 Out of scope (explicit — deferred)
- **Tree-sitter / symbol-aware code chunking** — quality upgrade, dep cost; deferred (OQ-2).
- **Knowledge graph / entity expansion** — future slice (S7 adds cheap regex entity-boost, not a graph).
- **Remote-default embeddings** — never default; remote/cloud is opt-in and provider-explicit (D6).
- **Embedding model re-training / fine-tuning** — pluggable models only.
- **Cross-project / user-global context mirror** — S7 (memory scope).
- **Full TUI for browsing results** — S9 CLI surfaces `noir context {search,index,status}` non-interactively.
- **Re-ranking with an LLM / cross-encoder** — future quality upgrade; v1 is RRF-only.
- **vec0 schema migration** — S6 reuses the existing 384-dim table as-is; model change → later migration.

---

## 3. Decisions (drafted; OQ-1…OQ-8 for review)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| DS-1 | Package shape | **New `@noir-ai/context`** (engine + indexer + chunker + embedder impls); reuses the existing `EmbedFn` seam + 384-dim `vec0` — **no store schema change** | Keeps the store a thin primitive layer (S1 DS-7/DS-8); S6 is pure logic on top. No new storage backend. |
| DS-2 | Embeddings default | **Local in-process** `@huggingface/transformers` + `all-MiniLM-L6-v2` (384-dim → zero vec0 migration); remote/Ollama **opt-in, provider-explicit** behind `EmbedFn` | D6: recall uses local embeddings, no API key; offline, free, private. ~22 MB first-run download cached in `~/.noir/models/` (not `.noir/`). Remote sends source to cloud — must be explicit. (grounds §10 Embeddings) |
| DS-3 | Hybrid fusion | **RRF k=60**, `score(d)=Σ wᵢ/(k+rankᵢ)`, weights 0.5/0.5, **rank-based (no score normalization)** | Cormack SIGIR'09 canonical; sidesteps BM25-vs-cosine scale mismatch (never sum raw scores). Per-retriever weights tunable later. (grounds §10 RRF) |
| DS-4 | Incremental indexing | **SHA-256 content-hash** tracked in store KV; **on-demand** default, `--watch` (chokidar) opt-in; seed full reindex on first run; intersect `git diff --name-only` when available | mtime is brittle across checkouts/clocks; content-hash is exact. On-demand keeps v1 simple; watch is a daemon-mode add-on. (grounds §10 indexing trigger) |
| DS-5 | Chunking | **Markdown-heading-aware** for `.md`; **line/token-bounded (~512 tok, 64 overlap)** for code; tree-sitter deferred | Heading splits give doc locality; token windows keep code chunks embeddable. Tree-sitter is the quality upgrade, not v1. (grounds §10 chunking; OQ-2) |
| DS-6 | Snippets & budget | **FTS5 `snippet()` window-extracted** (never truncated); greedy **token-budget** fill collapsing duplicate parent-docs (keep top chunk) | Blueprint §9.2 hard rule — never truncate. Budget fill keeps the result set small and focused. (grounds §10 budgeting) |
| DS-7 | Identifier handling | Keep `porter unicode61` (no migration); **index-time identifier explosion** appended to chunk content; evaluate `trigram` tokenizer later | camelCase/snake_case split poorly under unicode61; exploding identifiers at index time is migration-free. (grounds §10 correctness; OQ-6) |
| DS-8 | Vector distance | Embeddings are **L2-normalized before upsert** so the existing vec0 default (L2) yields **cosine-equivalent** ranking — no schema migration | vec0 created in S1 with default metric; MiniLM outputs unit vectors by default; remote vectors normalized client-side. (grounds §10 correctness) |
| DS-9 | MCP surface | **3 tools** — `context_search`, `context_index`, `context_status` — gated on new `ctx.context` service (mirrors `ctx.store`/`ctx.engine`); single-writer daemon owns indexing; read-only fallback keeps search working | §4 registration pattern; optional-service gating keeps stdio/HTTP paths that lack a store unblocked. (OQ-3) |
| DS-10 | Project keying + process | Canonical **`ProjectId` only** (never fs path); **embedded/in-process only, NO sidecar** | D6 hard rules. The daemon is the single writer; context reuses the daemon's store handle. |

---

## 4. Functional requirements

### 4.1 Indexing
- **F1** `indexPaths(paths, opts?)` walks the given files/dirs, skips `.gitignore` + `.noir/` + binary by default, chunks each file (DS-5), computes SHA-256, and skips chunks whose content-hash is already current in KV.
- **F2** Each chunk → `store.indexDoc({id, source, content, meta})` (FTS5 sync via existing triggers) **and** → `store.upsertVec(id, embed(chunk), {source})` with the **same `id`** so RRF can join BM25 and kNN hits.
- **F3** Content-hash state lives in store KV: `ctx:file:<path>` → `{sha256, chunkIds[], mtime?, language?}` and a registry `ctx:registry` → `path[]` for full reindex / forget. Removed files delete their chunks + vectors.
- **F4** First call on a fresh store seeds a **full reindex** of the configured roots; subsequent calls are incremental (DS-4).
- **F5** `--watch` mode (daemon opt-in) uses `chokidar` to debounce change events into `indexPaths` (single-writer serialization via the daemon's event loop).

### 4.2 Retrieval
- **F6** `search(query, opts?:{limit?, budgetTokens?, sources?, weights?})` runs `store.searchFt(query)` **and** `store.knn(embed(query))`, fuses with RRF k=60 (DS-3), collapses duplicate parent-docs, packs to `budgetTokens` (DS-6), returns `{results:[{id, source, score, snippet, path, parentDocId}], consumedTokens, truncated:boolean}`.
- **F7** `context_search` **never truncates snippets** — uses FTS5 `snippet(docs_fts,0,'<<','>>','…',16)` window extraction (already wired in S1). If kNN returns a hit FTS5 didn't, a window is extracted around the chunk's first `limit` tokens.
- **F8** When the embedder is unavailable (native load failed / no provider), `search` **degrades to BM25-only** and the payload carries `degraded:true, mode:'bm25-only'` — never crashes.

### 4.3 MCP tools (§4 pattern, gated on `ctx.context`)
- **F9** `context_search { query: string, limit?: number, budgetTokens?: number, sources?: string[] }` → ranked snippets (F6/F7).
- **F10** `context_index { paths: string[], watch?: boolean }` → `{indexed, skipped, deleted, degraded}` (F1/F3/F4).
- **F11** `context_status {}` → `{ok, projectId, docCount, vecCount, indexedFiles, embedder:{kind, model, dim}, degraded}` (mirrors `store_status`, adds embedder + index stats).
- **F12** All three wrap errors as `textResult({ok:false, degraded:true, error})` (existing helper); write-tools (`context_index`) surface the read-only/daemon-down error clearly when `storeDegraded`.

---

## 5. Non-functional requirements

- **NFR-1 Privacy:** local embeddings by default — no network, no key. Remote/Ollama require an explicit `context.embedder` provider block in config **and** the env var; absence ⇒ degraded BM25-only (D6/§8 hard rule).
- **NFR-2 Offline:** the full test suite runs offline (deterministic fake `EmbedFn`; MiniLM weights fetched once, cached).
- **NFR-3 Performance:** `context_search` p95 < 150 ms on a 5k-chunk index (single-writer SQLite, kNN limit capped). Indexing throughput ≥ 200 chunks/s on local embedder (warm).
- **NFR-4 No sidecar:** in-process only (D6). The `onnxruntime-node` native dep loads inside the daemon process; load wrapped in `try/catch` → BM25-only fallback.
- **NFR-5 Determinism:** RRF is rank-based — identical inputs produce identical ordering (no random seeding, no score-float normalization).
- **NFR-6 Compatibility:** no store schema migration in S6; existing configs without a `context:` block parse and behave as BM25-only-with-local-embedder-attempted.
- **NFR-7 License:** `@huggingface/transformers` (Apache-2.0) + `onnxruntime-node` (MIT) — MIT-compatible. Avoid any Elastic-2.0 / GPL dep (§9 stance).

---

## 6. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ @noir-ai/daemon (single writer; owns Store + ContextEngine)   │
│  ServerContext.store / .engine / .context  (optional services)│
│  createNoirServer(ctx) → registers context_{search,index,status}│
│      gated on ctx.context (§4 pattern)                        │
├──────────────────────────────────────────────────────────────┤
│ @noir-ai/context                                              │
│  ├─ embedders/                                                │
│  │    localEmbedder(model='Xenova/all-MiniLM-L6-v2') → EmbedFn│
│  │    remoteEmbedder({provider,apiKey,model,dim:384}) → EmbedFn│
│  │    ollamaEmbedder({baseURL,model}) → EmbedFn (opt-in)      │
│  │    L2-normalize all outputs (DS-8)                          │
│  ├─ chunker.ts   markdown-heading | line/token(512/64) (DS-5) │
│  ├─ indexer.ts   content-hash KV + F2/F3/F4 (DS-4)            │
│  ├─ rrf.ts       fuse BM25 + kNN, k=60, 0.5/0.5 (DS-3)        │
│  ├─ retriever.ts search() → BM25∪kNN → RRF → budget (DS-6)    │
│  ├─ contextEngine.ts  wires embedder+store+indexer+retriever  │
│  └─ index.ts                                                 │
├──────────────────────────────────────────────────────────────┤
│ @noir-ai/store  (EmbedFn seam; indexDoc/searchFt/upsertVec/knn)│
│   docs + docs_fts(porter unicode61) + vec0(float[384])        │
├──────────────────────────────────────────────────────────────┤
│ @noir-ai/core   NoirConfigSchema.context + ProjectId           │
└──────────────────────────────────────────────────────────────┘
```

`ContextEngine` is constructed once per serve lifecycle (mirroring `buildWorkflowEngine`), handed the daemon's existing `Store` handle, and injected as `ctx.context`. It is the only thing allowed to call `indexDoc`/`upsertVec` for context (the daemon stays the single writer). Read-only fallback: when `storeDegraded === true`, `context_search`/`context_status` still work (live reads off the same handle); `context_index` returns a clear degraded error.

### Config extension (`packages/core/src/config.ts`, zod/v4)
```ts
context: z.object({
  roots: z.array(z.string()).default(['.']),
  embedder: z.object({
    kind: z.enum(['local','remote','ollama','none']).default('local'),
    model: z.string().default('Xenova/all-MiniLM-L6-v2'),
    provider: z.string().optional(),      // 'openai'|'voyage'|'cohere' when kind:'remote'
    baseURL: z.string().optional(),       // when kind:'ollama'
    dimensions: z.number().int().default(384),
  }).default({ kind:'local', model:'Xenova/all-MiniLM-L6-v2', dimensions:384 }),
  chunk: z.object({ maxTokens: z.number().int().default(512), overlap: z.number().int().default(64) }).default({}),
  rrf: z.object({ k: z.number().int().default(60), weights: z.tuple([z.number(),z.number()]).default([0.5,0.5]) }).default({}),
  budgetTokens: z.number().int().positive().default(4096),
}).default({}),
```
`kind:'none'` ⇒ BM25-only v1 (OQ-1 alt). Absent block ⇒ defaults (local embedder attempted; degrade gracefully).

---

## 7. Data model (mapping onto the existing store)

- **Chunk → doc row.** Each chunk is `store.indexDoc({ id: chunkId, source, content, meta })` where:
  - `id` = `<sha256(path)>#chunk-<n>` (stable across re-indexing).
  - `source` ∈ `{'codebase','docs','spec','memory'}` — reused by S7 for memory.
  - `content` = chunk text **+ appended identifier-exploded stream** (DS-7): split camelCase/snake_case/kebab-case into lowercase tokens (e.g. `contextEngine` → `context engine`), so BM25 matches identifier queries without a tokenizer migration.
  - `meta` = `{ path, parentDocId, chunkIndex, language, sha256 }`.
- **Chunk → vector.** `store.upsertVec(chunkId, embed(content), {source})` — **same `id`** as the doc so RRF joins on it (DS-3). Embeddings L2-normalized first (DS-8).
- **Content-hash KV (DS-4).**
  - `ctx:file:<path>` → `{ sha256, chunkIds:string[], language }` — per-file tracking; re-index compares SHA-256, skips unchanged, deletes+reinserts changed, deletes removed.
  - `ctx:registry` → `string[]` of indexed paths (for full reindex / `context_index` deletes).
  - `ctx:embedder` → `{ kind, model, dim }` — recorded once so a model swap is detectable (mismatch ⇒ warn + offer reindex, not silent).
- **Chunk→parent-doc linkage.** `meta.parentDocId = sha256(path)`; the budget packer collapses on this field (keep the top-ranked chunk per parent) so a single file can't flood the result set (DS-6).
- **Identifier-aware FTS5 (DS-7).** No schema change in v1. The index-time explosion gives identifier queries a BM25 signal under the existing `porter unicode61` tokenizer; switching to `trigram` is a follow-up (OQ-6).

---

## 8. Workflow

**Index → embed → store**
1. `indexPaths` resolves paths (respect `.gitignore` + skips).
2. For each file: hash → compare `ctx:file:<path>` → if unchanged, skip; if changed/missing, chunk (DS-5).
3. For each chunk: explode identifiers into content, `indexDoc(...)`, `upsertVec(chunkId, embed(content), {source})`.
4. Update `ctx:file:<path>` + `ctx:registry`. Single-writer serialization via the daemon's event loop.

**Query → BM25+vec → RRF → budget → snippets**
1. `search(query)` runs `store.searchFt(query, {limit})` and `store.knn(embed(query), {limit})` in parallel.
2. RRF: for each unique `id`, `score = Σ wᵢ/(k+rankᵢ)` (k=60, w=[0.5,0.5]); a doc in only one list gets only that term (DS-3).
3. Collapse duplicate `parentDocId` (keep top chunk).
4. Greedy token-budget fill (DS-6): iterate ranked list, accumulate `snippet` tokens until `budgetTokens`, set `truncated:true` if the budget is hit.
5. Snippets via FTS5 `snippet()` for BM25 hits; window-extract first `N` tokens around chunk start for kNN-only hits (F7).

---

## 9. Dependencies

- **`@huggingface/transformers`** (Apache-2.0) — local embedder. **Native dep flag:** pulls **`onnxruntime-node`** (prebuilt binaries; `pnpm.onlyBuiltDependencies` already lists `better-sqlite3` — add `onnxruntime-node` if it needs a build step). Load wrapped in `try/catch` → BM25-only fallback (NFR-4). ~22 MB model weights fetched once into `~/.noir/models/` (user-global, **not** `.noir/` — keeps projects portable; OQ-7).
- **`chokidar`** (MIT) — `--watch` mode only (lazy/dynamic import so non-watch paths don't pay for it).
- **No new sqlite/FTS5 deps.** Reuses `better-sqlite3` + `sqlite-vec` from S1.
- No Elastic-2.0 / GPL deps (NFR-7; §9 stance — explicitly reject anything licensing-incompatible).

---

## 10. Assumptions *(each flagged — confirm at review)*

- **A1** *(assumption — confirm)* the existing S1 `vec0` table uses the **default L2** distance metric, so L2-normalized embeddings yield cosine-equivalent ranking (DS-8). If S1 already set cosine, the normalization is a harmless no-op.
- **A2** *(assumption — confirm)* `onnxruntime-node` prebuilts cover the CI matrix (ubuntu + macOS, node 22) — mirror the `better-sqlite3` gating story; skip vec/embed tests (reason) if a platform lacks a binary.
- **A3** *(assumption — confirm)* MiniLM-L6-v2 embeddings are unit-normalized at output (sentence-transformers convention); remote providers' vectors are normalized client-side before Matryoshka truncation to 384.
- **A4** *(assumption — confirm)* the host (Claude Code) consumes `context_search` as a normal MCP tool call and respects the `budgetTokens` result size — no host-side re-fetching.
- **A5** *(assumption — confirm)* `chunkId = <sha256(path)>#chunk-<n>` is stable enough that re-indexing after a move (same content, new path) is acceptable as a delete+insert (the registry is path-keyed; content-addressing across renames is a future quality upgrade).
- **A6** *(assumption — confirm)* v1 does not need a "references/"-style power skill to be useful (OQ-5); the MCP tools alone are the contract.

---

## 11. Risks

- **R1 Native-dep friction.** `onnxruntime-node` first-run download / platform gaps break `pnpm install`. **Mitigation:** try/catch load + BM25-only fallback (F8); gate tests (A2); `kind:'none'` escape hatch in config.
- **R2 Retrieval quality under `porter unicode61`.** camelCase identifiers match poorly. **Mitigation:** index-time identifier explosion (DS-7); measure with a retrieval eval fixture (§13); `trigram` follow-up (OQ-6).
- **R3 RRF weight tuning.** 0.5/0.5 may over/under-weight vec on short queries. **Mitigation:** config-tunable (§6); per-source weights later.
- **R4 Indexing cost on large repos.** Full reindex of a 10k-file monorepo is slow on local embedder. **Mitigation:** incremental content-hash (DS-4); `git diff` intersection; `budgetTokens` keeps query cost bounded.
- **R5 Silent paid calls.** A misconfigured remote embedder sends source to cloud without the user noticing. **Mitigation:** D6 hard rule — provider-explicit block + env var required; `context_status` always reports `embedder.kind`; refuse to use remote if block absent.
- **R6 Store lock contention.** Indexer writes while `context_search` reads. **Mitigation:** WAL mode (S1); single-writer serialization; reads never block on the writer.

---

## 12. Alternatives considered

- **Vercel AI SDK / LangChain ensemble retriever.** Rejected — over-buys (streaming/tool machinery Noir forbids, Zod/bundle cost); the RRF math is ~20 lines (grounds §10). Keep it native (§9 stance).
- **BM25-only for v1 (defer vectors).** OQ-1 alt — simplest, but loses semantic recall (the whole point of S6). Recommended default keeps local vectors (DS-2).
- **Remote-only embeddings.** Rejected as default — violates D6 (no silent paid calls, no key required); remote stays opt-in.
- **`trigram` FTS5 tokenizer now.** OQ-6 alt — better identifier matching but a schema migration (FTS5 table recreate + reindex). v1 uses index-time explosion (DS-7) and evaluates `trigram` as a follow-up.
- **sqlite-vec cosine metric via migration.** Rejected for v1 — L2-normalize instead (DS-8), no migration.
- **Full-screen TUI browser.** Deferred to S9 (v2 Ink) — v1 ships MCP tools + non-interactive CLI.
- **Always-on `--watch`.** Rejected as default — on-demand content-hash is simpler and daemon-safe; watch is opt-in (DS-4).

---

## 13. Testing strategy

- **Unit (vitest, tmpdir fixtures, deterministic fake `EmbedFn`):**
  - **Chunker:** markdown-heading splits; line/token windows + overlap; binary skip.
  - **RRF:** known BM25/kNN rank lists → expected fused order; k=60; a doc in one list gets only that term; weights respected.
  - **Budget packer:** collapses duplicate `parentDocId`; stops at `budgetTokens`; sets `truncated`.
  - **Indexer:** content-hash skip on unchanged; delete+reinsert on changed; delete on removed; `ctx:registry` consistency; embedder-model-mismatch detection.
  - **Identifier explosion:** `contextEngine` query matches `contextEngine` chunk via exploded tokens under `porter unicode61`.
- **MCP round-trip:** `InMemoryTransport` (`@modelcontextprotocol/server`) — register `context_search`/`context_index`/`context_status` via `createNoirServer({context})`, call from a client, assert payloads + degraded envelopes.
- **Degraded path:** open store `readonly:true` + `storeDegraded:true` → `context_search` returns BM25-only results (`degraded:true`); `context_index` returns the read-only error envelope.
- **Native-embedder integration (opt-in, gated on A2):** real `localEmbedder` over a tiny fixture — dimensional correctness (384), unit-norm, kNN ordering sanity. Skipped with a reason if `onnxruntime-node` unavailable.
- **Retrieval eval fixture:** a small curated `{query → expected-path}` set (≥10) to guard RRF quality against regressions (R2); reported as a recall@k number, not a hard gate in v1.
- **No network** in the default suite; remote/ollama embedders tested with a mocked fetch.

---

## 14. Acceptance criteria

- **AC-1** `context_index {paths:['src']}` indexes a sample tree; a subsequent identical call reports `indexed:0, skipped:N` (content-hash hit).
- **AC-2** `context_search {query:'ContextEngine'}` returns the relevant chunk with a `<<…>>`-windowed snippet (F7), within `budgetTokens`, `degraded:false` under local embedder.
- **AC-3** RRF unit tests pass (k=60, 0.5/0.5, single-list term, no score normalization).
- **AC-4** With embedder load failed (or `kind:'none'`), `context_search` returns BM25-only results with `degraded:true, mode:'bm25-only'` (F8).
- **AC-5** Read-only store: `context_search`/`context_status` work; `context_index` returns the degraded error envelope.
- **AC-6** `context_status` reports `{docCount, vecCount, indexedFiles, embedder:{kind,model,dim}, degraded}`.
- **AC-7** No store schema migration; a config without `context:` parses and defaults to local-embedder-attempted (NFR-6).
- **AC-8** Full vitest suite green offline; new package builds under tsup; Biome lint clean.

---

## 15. Definition of done

- `@noir-ai/context` package exists, builds (`tsup`), exports `ContextEngine`, the embedders, chunker, indexer, rrf, retriever.
- `ServerContext` extended with optional `context?: ContextEngine`; `createNoirServer` registers the 3 tools gated on it (§4 pattern).
- `NoirConfigSchema` extended with `context:` (zod/v4 defaults); existing configs unchanged.
- All AC-1…AC-8 pass; vitest green offline; retrieval eval fixture reports a recall@k baseline.
- Roadmap + `agentmemory` refreshed: S6 marked delivered, gaps/goals current. *(assumption — confirm the roadmap doc path.)*

---

## 16. Open questions (each with a recommended default)

- **⚡ OQ-1 — Embedding default.** Local transformers.js MiniLM-L6-v2 **(recommended, DS-2)** vs BM25-only-for-v1-defer-vectors vs remote-only. *Gating* — determines the native dep, first-run download, and whether v1 ships semantic recall at all.
- **OQ-2 — Chunking depth.** Markdown + line/token-overlap now, tree-sitter deferred **(recommended, DS-5)** vs tree-sitter now.
- **⚡ OQ-3 — MCP tool surface scope.** 3 tools — `context_search` / `context_index` / `context_status` **(recommended, DS-9)** vs fewer (fold into `store_status`) vs more (`context_forget`, `context_reindex`). *Gating* — defines the v1 contract the host + S7 depend on.
- **OQ-4 — Indexer trigger default.** On-demand (content-hash incremental) + `--watch` opt-in **(recommended, DS-4)** vs always-watch.
- **OQ-5 — `noir-context` power skill.** Ship a thin `references/`-style power skill describing when to reach for `context_search`/`context_index` **(recommended — matches the S5 skill pack)** vs skip (MCP tools alone).
- **OQ-6 — FTS5 tokenizer for code identifiers.** Keep `porter unicode61` + index-time identifier explosion **(recommended, DS-7)** vs switch to `trigram` now (schema migration).
- **OQ-7 — Embedding model cache location.** `~/.noir/models/` (user-global, keeps `.noir/` portable) **(recommended)** vs project-local `.noir/models/`.
- **OQ-8 — Model upgrade (bge-small-en-v1.5).** Ship MiniLM default, keep model pluggable, document bge as a same-dim drop-in **(recommended)** vs ship bge default.

---

## 17. References

- Grounding: `.superpowers/sdd/2026-07-24-s6-s9-grounding-digest.md` §2 (store), §4 (MCP pattern), §5 (config), §8 (blueprint rules), §10 (S6 research).
- Store seam: `packages/store/src/types.ts` (`EmbedFn`, `IndexDoc`, `FtsHit`, `VecHit`, `Store`).
- MCP registration: `packages/daemon/src/server.ts` (`ServerContext`, `createNoirServer`, `store_status` gating).
- Config: `packages/core/src/config.ts` (`NoirConfigSchema`, zod/v4).
- Parent specs: `2026-07-23-s1-stores-design.md` (the store this builds on), `2026-07-24-s5-skills-design.md` (section structure).
- Cormack, Clarke, Büttcher — Reciprocal Rank Fusion (SIGIR 2009).
- sqlite-vec (JS): https://alexgarcia.xyz/sqlite-vec/js.html · SQLite FTS5: https://www.sqlite.org/fts5.html.
- Local embeddings (transformers.js + MiniLM): https://huggingface.co/Xenova/all-MiniLM-L6-v2.

---

## 18. Next steps

1. **User reviews this draft** — resolve OQ-1…OQ-8 (especially the ⚡ gating ones: OQ-1, OQ-3).
2. On approval → **writing-plans** → subagent-driven implementation (embedders → chunker → indexer → RRF → retriever → MCP tools → config → tests), reviewer + final opus whole-branch review per the SDD dogfood rule (§1).
