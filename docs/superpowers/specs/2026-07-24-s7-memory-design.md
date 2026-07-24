# Noir — S7 Cross-Session Memory Design (`@noir-ai/memory`)

> **Status: DRAFT v0 — pending clarification answers (OQ-1..OQ-8). Do not implement until resolved.**

- **Date:** 2026-07-24
- **Spec type:** Implementation design (next slice after S6 Context).
- **Parent:** blueprint §6.3 (memory), §9 / D6 (unified context+memory), §9 feature-adoption stance (do **not** copy Agent-Memory's silent paid consolidation) + `.superpowers/sdd/2026-07-24-s6-s9-grounding-digest.md` §2, §4, §5, §8 (D6), §10 (S7 research).
- **Slice:** S7 — roadmap v1.0. Depends on `@noir-ai/core` + `@noir-ai/store` (S1); recall **reuses** the S6 retriever (DS-5); consolidation **consumes** the S8 bounded model (DS-6).

---

## 0. TL;DR

A **local-first, in-process cross-session memory** for Noir: append-only **observations** (pattern / preference / architecture / bug / workflow / fact / decision / lesson) stored **on top of the existing store** (FTS5 docs + sqlite-vec, no migration), recalled via the **S6 hybrid retriever reused as-is**, and consolidated into derived `type:lesson` rows by an **explicit, provider-gated job** that consumes the S8 model layer. **Capture / store / retrieve are always local and free.** Any LLM touch (consolidation, future semantic dedup) requires a **user-written provider block** — Noir refuses and logs if absent, **never** making a silent paid call (the Agent-Memory anti-pattern, §9). Default capture mode is **explicit save**; auto-capture ships as an **opt-in Claude Code hooks template the user installs**, never auto-wired.

S7 acceptance: ***a user saves an insight in one session and recalls it (BM25 + vec + RRF) in another, `memory_forget` removes it, and consolidation refuses cleanly when no provider is configured.***

---

## 1. Goals & scope

### 1.1 In scope
- A new package **`@noir-ai/memory`** (8th): the observation data model, a `MemoryService`, an explicit consolidation job, and an opt-in Claude Code hooks template.
- **Observations layer on top of the store** — reuses `indexDoc` (FTS5) + `upsertVec` (sqlite-vec) + KV; **no schema migration**.
- **Hybrid recall that reuses the S6 retriever** (BM25 + vec + RRF, `k=60`) scoped to `source:'memory'`, plus a cheap regex **entity-boost** (identifiers / paths, no LLM).
- **Explicit-save as default**; auto-capture via a host-neutral event schema + a **Claude Code hooks template the user opts into** (PreToolUse / PostToolUse / UserPromptSubmit / Stop).
- **Append-only consolidation** — an explicitly-invoked, provider-gated job (`noir memory consolidate`) that consumes S8 `complete()` and emits derived `type:lesson` rows with `provenance:[ids]`; originals never mutated.
- **MCP tools** `memory_save` / `memory_recall` / `memory_search` / `memory_sessions` / `memory_forget`, gated on `ctx.memory` (mirrors `ctx.store` / `ctx.engine`).
- Tests: save → recall round-trip across a re-opened store; forget; sessions list; consolidation refuse-without-provider; hooks template validates + is opt-in only.

### 1.2 Out of scope (deferred — explicit)
| Deferred | Target | Why |
|---|---|---|
| **Graph expansion / temporal knowledge graph** (Zep/Graphiti-style entities+edges) | v1.x | Adds a graph layer + an extraction LLM call; observations + cheap entity-boost cover v1 recall. |
| **LLM auto-tagging** (auto `concepts`/`type` on save) | v1.x | Another silent LLM touch; explicit user `type`/`concepts` is enough for v1. |
| **Multi-user / org scoping** (per-user memory namespaces) | v1.x | v1 = solo power-user (blueprint §0). |
| **Semantic dedup / merge on save** | v1.x | Append-only is the safe default; dedup needs an embed-compare + policy decision. |
| **Remote sync / cloud memory** | never default | Violates D6 (local+free). A remote *embedding* provider is already opt-in via S6. |

---

## 2. Decisions (drafted; OQ-1..8 for review)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| DS-1 | Package location | **New `@noir-ai/memory`** (8th; depends `core` + `store`; optional `S6 retriever`, optional `S8 model`) | Keeps the store I/O-pure and the memory concern isolated, mirroring `@noir-ai/workflow` (S4 DS-1). Retrieval + model are optional injections so S7 can ship before S6/S8 finalize. |
| DS-2 | Storage realization | **Observations live ON TOP of the store — no migration.** Each observation → `indexDoc({id, source:'memory', content, meta})` (FTS5 auto-synced) + `upsertVec(id, embed(content), {source:'memory'})`; the authoritative structured row in KV `memory:obs:<id>`; session rollups in KV `memory:sessions`. | Reuses the exact S1 primitives (digest §2). Zero migration risk; the single-writer daemon discipline is inherited for free. |
| DS-3 | Taxonomy | **Dev-flavored open enum** — `pattern \| preference \| architecture \| bug \| workflow \| fact \| decision \| lesson`; `lesson` reserved for consolidation output. Unknown values accepted + stored (forward-compat). | Digest §10 S7: dev-flavored primary, cognitive type as a secondary tag. Open enum avoids a closed set that needs migrations. |
| DS-4 | Capture default | **Explicit-save only.** Auto-capture = a **host-neutral event schema** (`CaptureEvent`) + a **Claude Code hooks template the user explicitly installs** (`noir memory hooks install`); never auto-wired by `noir init`/`sync`. | Digest §10 S7 + §9: portable + safe default; MCP instrumentation alone misses Bash/Edit/Read so hooks are the honest auto-capture path. Opt-in = no surprise captures. |
| DS-5 | Recall engine | **Reuse the S6 hybrid retriever** (BM25 + vec + RRF `k=60`) scoped to `source:'memory'`; add a cheap regex **entity-boost** (identifiers / paths, no LLM). **Fallback:** if the S6 retriever is absent, S7 recall degrades to store BM25 only (no vec) so S7 can land independently. | D6: recall uses local embeddings, no API key. One retriever for context + memory avoids divergence; the S6 seam is the contract. |
| DS-6 | Consolidation | **Append-only observations** (mem0 v3 model). Consolidation = a **separate explicitly-invoked job** (`noir memory consolidate` / `memory_consolidate` MCP tool) that consumes **S8 `complete()`** and emits derived `type:lesson` with `provenance:[ids]`; originals stay. **Refuses + logs if no provider configured — never a silent paid call.** If S8 is not yet built, consolidation is a documented no-op stub. | §9 anti-pattern (Agent-Memory silent paid consolidation); D5/D6 provider-explicit. Originals preserved = reversible + auditable. |
| DS-7 | MCP surface | **`memory_save`, `memory_recall`, `memory_search`, `memory_sessions`, `memory_forget`**, registered only when `ctx.memory` is present (mirrors `ctx.store` / `ctx.engine` gating in `server.ts`). | Digest §4 registration pattern. Tool names match `^[a-zA-Z0-9_-]+$` (underscores, no dots). `memory_search` is the cheap BM25-only instant path; `memory_recall` is the hybrid path. |
| DS-8 | Config | **New top-level `memory:` block** (`capture`, `hooksTemplate`, `recall`, `consolidation`) via Zod `.default({})` — existing `.noir/config.yml` files keep working. | Digest §5: extend idiomatically (mirrors `daemon:`). Provider never inferred from env-var presence (S8 rule). |
| DS-9 | Snippet integrity | **Never truncate recall snippets** — window-extract is inherited from the store/S6; the full observation `content` is hydrated from the authoritative KV row on every recall. | §9 hard rule; `FtsHit.snippet` is a preview, the returned `Observation.content` is complete. |
| DS-10 | Privacy hard rule | **Capture / store / retrieve always local + free.** Any LLM touch (consolidation now; semantic dedup / auto-tag later) requires a user-written provider block; Noir **refuses + logs** if absent. | D6; §9. The line between free (store/embed-local) and paid (LLM) is explicit and enforced. |

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  @noir-ai/memory  (new, 8th)                                   │
│   MemoryService                                                │
│     · save()        → indexDoc + upsertVec + KV(memory:obs:*)  │
│     · recall()      → S6 Retriever.search(source:'memory')     │
│                       + regex entity-boost → hydrate from KV   │
│     · search()      → store.searchFt (BM25-only, instant)      │
│     · sessions()    → KV(memory:sessions)                      │
│     · forget()      → delete KV + best-effort doc/vec purge    │
│   Consolidator (explicit job; consumes S8 complete())          │
│   CaptureEvent schema + hooks-template/ (opt-in, Claude Code)  │
├────────────────────────────────────────────────────────────────┤
│  @noir-ai/store  (FTS5 docs + vec0 + KV — UNCHANGED, S1)       │
│  @noir-ai/core   (ProjectId, config — ProjectId NEVER fs path) │
│  @noir-ai/skills (optional noir-recall / noir-remember stubs)  │
└────────────────────────────────────────────────────────────────┘
   injections (optional): S6 Retriever (recall) · S8 complete() (consolidation)

@noir-ai/daemon
├─ memory-seam.ts   buildMemoryService(store, retriever?, model?) — one per serve lifecycle
└─ server.ts        registers memory_* tools gated on ctx.memory
```

Dependency direction: `core` ← `store` ← `memory` ← `daemon`/`cli`. `memory` depends only on `core` + `store` at runtime; `retriever` (S6) and `model` (S8) are **optional injected** — S7 builds + tests without them. No cycles.

---

## 4. Data model

### 4.1 `Observation` (the canonical row)

```ts
// @noir-ai/memory types.ts
import type { ProjectId } from '@noir-ai/core';

export type MemoryType =
  | 'pattern' | 'preference' | 'architecture' | 'bug'
  | 'workflow' | 'fact' | 'decision' | 'lesson';

export type MemorySource = 'explicit' | `auto:${string}`;

export interface Observation {
  id: string;                  // ulid — sortable + unique
  type: MemoryType;            // open enum: unknown values accepted + stored
  content: string;             // full, never truncated (DS-9)
  project: ProjectId;          // canonical ProjectId, NEVER a fs path (D6)
  session_id: string | null;   // host session if known
  ts: number;                  // created (ms)
  last_access_ts: number;      // bumped on recall hit
  importance: number;          // 0..1, default 0.5
  concepts: string[];          // user tags (no auto-LLM tagging in v1)
  files: string[];             // repo-relative paths mentioned
  source: MemorySource;        // 'explicit' | 'auto:stop' | 'auto:posttooluse' ...
  parent_id: string | null;    // set on derived rows
  provenance: string[];        // [observation ids] for consolidated lessons
}
```

### 4.2 Realization on the store (DS-2)

| Store primitive | What lives there |
|---|---|
| `indexDoc({ id, source:'memory', content, meta: <Observation minus content> })` | FTS5-searchable content (porter unicode61, external-content). `meta` carries the structured fields. |
| `upsertVec(id, embed(content), { source:'memory' })` | 384-dim vector (S6 `EmbedFn`, MiniLM-L6-v2 default → **zero vec0 migration**). |
| `setState('memory:obs:<id>', observation)` | **Authoritative full row** (the source of truth for hydration; survives even if FTS snippet is a window). |
| `setState('memory:sessions', SessionInfo[])` | Per-project session rollup for `memory_sessions`. |

`searchFt({ source:'memory' })` and `knn(vec, { source:'memory' })` filter to memory rows only — context (S6) and memory never collide. Recall hydrates the full `Observation` from KV `memory:obs:<id>` and bumps `last_access_ts`.

> **OQ-7** — whether the authoritative row lives in KV (recommended, zero store change) or we add a tiny `Store.getDoc(id)` and keep the row solely in `docs.meta`.

---

## 5. Capture flow

**Explicit (default):** host (or user via `noir memory save` / `memory_save` MCP tool) calls:
```ts
MemoryService.save(input: SaveInput, projectId: ProjectId): Promise<Observation>
// SaveInput = { content, type?: MemoryType, concepts?: string[], files?: string[],
//                importance?: number, session_id?: string }
```
→ builds an `Observation` (`id`=ulid, `ts`=now, `source:'explicit'`, defaults) → writes docs+vec+KV (§4.2) → returns the row. Single-writer discipline inherited from the daemon store handle.

**Auto (opt-in via hooks template):** the user runs `noir memory hooks install`, which writes a Claude Code hooks block mapping `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` to `noir memory capture --stdin`. Each invocation emits a host-neutral `CaptureEvent { hook, tool?, input?, summary?, ts, session_id }`; the `capture` command applies an opinionated policy (default: persist `Stop` session summaries + decision-shaped `UserPromptSubmit`s, skip noisy `PreToolUse`) as `source:'auto:<hook>'` observations. **`noir init` / `noir sync` never install the hooks** — the template ships as a file the user wires deliberately (DS-4).

---

## 6. Recall flow

```ts
MemoryService.recall(query: RecallQuery, projectId: ProjectId): Promise<Observation[]>
// RecallQuery = { query: string, limit?: number, type?: MemoryType, session_id?: string }
```

1. **Hybrid path** via the injected S6 `Retriever`: `retriever.search({ query, source:'memory', limit })` → RRF-fused BM25+vec hits (`k=60`, weights 0.5/0.5). **Fallback** (no retriever): `store.searchFt(query, { source:'memory', limit })` — BM25 only, still useful.
2. **Entity-boost** (cheap, no LLM): regex-extract identifiers / paths from `query`, bump rank of hits whose `files`/`concepts`/`content` mention them.
3. **Filter** by `type` / `session_id` if requested.
4. **Hydrate** each hit to a full `Observation` from KV `memory:obs:<id>`; bump `last_access_ts` (best-effort, single writer).
5. Return observations with **complete `content`** (DS-9) — never the truncated FTS snippet.

`memory_search` is the **instant** BM25-only path (`store.searchFt`) for "does anything mention X" lookups without paying for an embed.

---

## 7. Consolidation flow (DS-6)

```ts
MemoryService.consolidate(projectId: ProjectId): Promise<ConsolidationResult>
// ConsolidationResult =
//   | { ok: true; lessons: Observation[]; from: string[] }
//   | { ok: false; reason: 'no-provider' | 's8-unavailable' | 'no-candidates'; logged: boolean }
```

1. **Explicit trigger only** — `noir memory consolidate` (CLI) or the `memory_consolidate` MCP tool. Never runs on a timer, never runs at session end automatically.
2. **Provider gate:** if `config.memory.consolidation.provider` is unset → return `{ ok:false, reason:'no-provider', logged:true }` and write a `memory:consolidation:miss` KV audit entry. **No S8 call. No paid request. No silent degradation to "best-effort LLM".** (§9 anti-pattern.)
3. **S8 gate:** if the S8 `complete()` injection is absent (S8 not yet built) → return `{ ok:false, reason:'s8-unavailable', logged:true }`. S7 ships this as a documented stub so the slice is not blocked on S8 (see OQ-3 / OQ-8).
4. **Candidates:** gather recent observations (`type != 'lesson'`, above an importance floor or within a lookback window) — deterministic selection, no clustering LLM.
5. **Derive:** `complete({ system: CONSOLIDATION_PROMPT, prompt: serializedCandidates, schema: lessonSchema, provider, model })` — single-shot, no tools, no loop (D5).
6. **Append:** write one new `Observation { type:'lesson', content: derived, provenance:[candidate ids], source:'explicit' }`. **Originals are never mutated or deleted** (append-only; reversible + auditable).

---

## 8. MCP surface (gated on `ctx.memory`)

Registered in `createNoirServer` exactly like `store_status` / `workflow_status` (digest §4):

| Tool | Input (ZodRawShape) | Output |
|---|---|---|
| `memory_save` | `{ content: z.string(), type?: z.enum([...]), concepts?: z.array(z.string()), files?: z.array(z.string()), importance?: z.number().min(0).max(1), session_id?: z.string() }` | `{ id, observation }` |
| `memory_recall` | `{ query: z.string(), limit?: z.number().int().positive(), type?: z.enum([...]), session_id?: z.string() }` | `{ results: Observation[] }` (hybrid) |
| `memory_search` | `{ query: z.string(), limit?: z.number().int().positive() }` | `{ hits: FtsHit[] }` (BM25-only, instant) |
| `memory_sessions` | `{}` | `{ sessions: SessionInfo[] }` |
| `memory_forget` | `{ ids: z.array(z.string()) }` | `{ deleted: number, ids: string[] }` |

Errors wrapped as `textResult({ ok:false, degraded:true, error })` (existing convention). A read-only store (`storeDegraded`) makes `memory_save` / `memory_forget` return a clear degraded envelope instead of crashing — mirroring `checkpoint { save }`.

---

## 9. Config (DS-8)

Extends `NoirConfigSchema` (`packages/core/src/config.ts`) with a top-level `memory:` block, Zod-defaulted so existing configs are unaffected:

```ts
memory: z.object({
  capture: z.enum(['explicit']).default('explicit'),         // explicit-only v1
  hooksTemplate: z.enum(['none', 'claude-code']).default('none'), // opt-in
  recall: z.object({
    retriever: z.enum(['s6', 'builtin-bm25']).default('s6'),
    limit: z.number().int().positive().default(10),
  }).default({ retriever: 's6', limit: 10 }),
  consolidation: z.object({
    enabled: z.boolean().default(false),
    provider: z.string().optional(),   // e.g. 'anthropic' | 'openai' | 'ollama'
    model: z.string().optional(),
  }).default({ enabled: false }),
}).default({})
```

Provider is **never inferred from env-var presence** (S8 rule); no explicit `provider` ⇒ consolidation refuses (DS-6).

---

## 10. Dependencies

- **Runtime:** `@noir-ai/core` (ProjectId, config), `@noir-ai/store` (FTS5 + vec0 + KV, unchanged). `ulid` (tiny, already common).
- **Optional injections:** S6 `Retriever` (recall hybrid path; absent → BM25 fallback), S8 `complete()` (consolidation; absent → documented stub). **Neither blocks S7 build/test.**
- **Embeddings:** provided by the S6 `EmbedFn` seam (local MiniLM-L6-v2, 384-dim → zero vec0 migration). S7 adds **no** embedding code of its own.
- **No new native deps.** No sidecar, no external server (D6 — in-process only).

---

## 11. Assumptions *(FLAG — confirm)*

- **A1** *(assumption)* the S6 retriever exposes a `search({ query, source?, limit? }): Promise<Hit[]>` contract that S7 can call with `source:'memory'`. If S6 finalizes a different shape, S7 adds a thin adapter. *(confirm at S6 review)*
- **A2** *(assumption)* deleting an observation only needs best-effort doc/vec purge (the store has no `deleteDoc`/`deleteVec` today); the authoritative KV row is the source of truth and `forget` always removes that. A future store extension adds clean delete. *(confirm acceptable for v1)*
- **A3** *(assumption)* per-project session rollups in KV are small enough (solo user, v1) that no separate sessions table is needed. *(confirm)*
- **A4** *(assumption)* auto-capture hooks template ships in S7 as **opt-in files** even if OQ-1 resolves to "explicit-only"; the template is dead code until the user runs `noir memory hooks install`. *(confirm)*

---

## 12. Risks

- **R1 — Recall quality without S6 vec.** If S6 lands late, S7 recall is BM25-only until the retriever is injected. *Mitigation:* BM25 + entity-boost is genuinely useful; the seam lets vec arrive without an S7 refactor.
- **R2 — Consolidation deadlock on S8.** If S8 slips, consolidation is a stub. *Mitigation:* DS-6/OQ-3 explicitly decouple — ship S7 (save/recall/forget/sessions) without consolidation; wire after S8.
- **R3 — Auto-capture noise / privacy surprise.** Hooks that capture every `PreToolUse` flood memory + leak sensitive content into the store. *Mitigation:* opt-in only (DS-4); default policy persists only `Stop` summaries + decision-shaped prompts; the user owns the policy file.
- **R4 — KV row vs docs.meta drift.** Two places hold observation state. *Mitigation:* KV is authoritative; `docs.meta` is a denormalized search payload written in the same transaction-like sequence as the KV row; `forget` removes both.
- **R5 — Silent paid-call creep.** A future "auto-tag on save" or "semantic dedup" feature could smuggle in an LLM call. *Mitigation:* DS-10 enforcement — the `MemoryService` has exactly one LLM entry point (`Consolidator`) and it is provider-gated; any new LLM touch must go through the same gate.

---

## 13. Alternatives considered

- **External Rust memory server (Agent-Memory pattern).** *Rejected* — §9: sidecar + 53-tool surface + silent paid consolidation; violates D6 (in-process, local+free, provider-explicit).
- **New `observations` SQL table (migration).** *Rejected for v1* — the store already has FTS5 + vec0 + KV; a migration adds risk for no query gain. Revisit if KV hydration becomes a bottleneck.
- **Graph KG (Zep/Graphiti).** *Deferred* — v1.x; needs an extraction LLM + graph storage, out of scope for solo MVP.
- **Vercel AI SDK / LangChain memory abstractions.** *Rejected* — over-buys streaming/tool/agent machinery Noir forbids (D5); a thin internal `MemoryService` is enough.
- **Always-on auto-capture.** *Rejected* — surprise privacy surface; explicit-save default + opt-in hooks (DS-4).

---

## 14. Open questions (OQ-1..8) — each with a recommended default

- **OQ-1 ⚡ (gating)** Auto-capture scope — **(a) explicit-save-only** *(recommended default)* vs **(b) + ship the Claude Code hooks template as opt-in**. *Default:* ship both — explicit-save is the wired default, the hooks template ships as opt-in files (`noir memory hooks install`). Gating: if the user wants zero auto-capture surface in v1, (a) drops the template + `capture` command entirely (small scope cut).
- **OQ-2 ⚡** Taxonomy — **(a) dev-flavored open enum** *(recommended default)* vs (b) fixed closed set vs (c) cognitive-type primary. *Default:* (a) — `pattern|preference|architecture|bug|workflow|fact|decision|lesson`, unknown values accepted + stored.
- **OQ-3 ⚡ (gating)** Consolidation timing — **(a) defer consolidation to post-S8** *(recommended default; S7 ships save/recall/forget/sessions now, consolidation wires when S8 lands)* vs (b) build a minimal `complete()` inside S7. *Default:* (a) — keep the provider gate + stub today, implement after S8.
- **OQ-4 ⚡** Recall retriever — **(a) reuse the S6 retriever** *(recommended default)* vs (b) S7-own hybrid. *Default:* (a) with a BM25-only fallback so S7 is not blocked on S6.
- **OQ-5 ⚡** MCP tool surface — **(a) the five tools above** (`save`/`recall`/`search`/`sessions`/`forget`) *(recommended default)* vs (b) adding `memory_consolidate` as an MCP tool vs (c) fewer. *Default:* (a) + expose `memory_consolidate` only when `config.memory.consolidation.enabled === true` (conditional registration).
- **OQ-6 ⚡** Power skills `noir-recall` / `noir-remember` — **(a) add both as stub skills** *(recommended default; cheap, high discoverability, fits the S5 pack)* vs (b) defer. *Default:* (a) — stub `SKILL.md`s under `@noir-ai/skills`, auto-discovered.
- **OQ-7 ⚡** Authoritative row store — **(a) KV mirror `memory:obs:<id>`** *(recommended default; zero store change)* vs (b) extend `Store.getDoc(id)` + keep row solely in `docs.meta` vs (c) docs.meta-only. *Default:* (a).
- **OQ-8 ⚡ (gating)** Slice ordering / S8 dependency — **(a) ship S7 (recall+save+forget+sessions) now, wire consolidation after S8** *(recommended default)* vs (b) block S7 on S8. *Default:* (a) — matches the roadmap (S6→S7→S8) and OQ-3.

---

## 15. Testing & CI

- **Unit:** `save` writes docs+vec+KV (assert via `countDocs`/`countVecs`/`getState`); `recall` round-trip; `search` BM25-only path; `sessions` rollup; `forget` removes the KV row + best-effort doc/vec.
- **Integration:** recall across a re-opened store (state survives `close()` / re-`openStore()`, mirroring the S4 resume test); recall scoped to `source:'memory'` does not return S6 context docs; entity-boost reranks correctly.
- **Consolidation gate:** `consolidate()` returns `{ ok:false, reason:'no-provider' }` + writes the miss audit when no provider; returns `{ ok:false, reason:'s8-unavailable' }` when S8 absent; appends a `type:lesson` with `provenance` when configured (S8 stubbed).
- **Hooks template:** the Claude Code hooks JSON validates against the host's schema; `noir init`/`sync` do **not** install it; `noir memory hooks install` is the only path.
- **Privacy invariant (property-style):** no test path triggers a network call; any LLM touch is gated behind an explicit provider config (assert via a no-provider run).
- No network; no real LLM (S8 stubbed). CI matrix unchanged (ubuntu+macos, node 22).

---

## 16. Acceptance

S7 is accepted when ***a user saves an insight in one session, recalls it in another via the hybrid path, forgets it, and the sessions list reflects both — while consolidation refuses cleanly without a configured provider.*** Specifically:

1. `memory_save` → `memory_recall` returns the same observation (full content) across a store close/reopen.
2. `memory_search` (BM25-only) returns instant hits scoped to memory only.
3. `memory_forget` removes the observation from subsequent recall + sessions.
4. `memory_sessions` lists sessions with first/last ts + count.
5. `consolidate()` without a provider returns `{ ok:false, reason:'no-provider' }` and writes the miss audit — **no paid call, no crash.**
6. The Claude Code hooks template is opt-in: absent from `noir init` output, installable on demand.

---

## 17. Definition of Done

- `@noir-ai/memory` package exists, builds (`tsup`), passes Biome lint, full Vitest suite green offline.
- `ctx.memory` wired into `ServerContext`; the five `memory_*` MCP tools register when present.
- `config.memory` block merged with Zod defaults; existing configs parse unchanged.
- S7 consolidation stub returns the documented refuse reasons; S8 wiring is a tracked follow-up (not a blocker).
- Grounding rules enforced: local+free capture/store/retrieve; provider-gated LLM; canonical ProjectId; in-process; never-truncated snippets.
- Docs + roadmap updated; agent-memory refreshed at session end (per memory hygiene note).

---

## 18. References

- Parent: `.superpowers/sdd/2026-07-24-s6-s9-grounding-digest.md` §2 (store), §4 (MCP pattern), §5 (config), §8/D6, §10 (S7 research).
- Sibling specs: `2026-07-24-s4-sdd-engine-design.md` (Document phase → memory hook; "S7 lifts decisions into memory"), `2026-07-24-s5-skills-design.md` (DS/OQ format + skill pack).
- Research: [mem0 v3](https://github.com/mem0ai/mem0) · [Letta/MemGPT](https://github.com/letta-ai/letta) · [Zep/Graphiti](https://github.com/getzep/graphiti) · Generative Agents · [Claude Code hooks](https://docs.claude.com/en/docs/claude-code/hooks).

---

## 19. Next steps

1. **User reviews this draft** — resolve OQ-1..OQ-8 (the ⚡ gating ones first: OQ-1, OQ-3, OQ-8).
2. On approval → **writing-plans** → subagent-driven implementation (implementer + reviewer, sonnet; final opus whole-branch review; 1 fix wave) per the SDD dogfood rule.
3. Coordinate with S6 (retriever contract, A1) and S8 (consolidation wiring, OQ-3/OQ-8).
