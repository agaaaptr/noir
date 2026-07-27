# Noir SDK — using the packages as a library

Noir ships as the `@noir-ai/cli` npm package (bin: `noir`), but the eleven `@noir-ai/*` workspace packages are also designed to be consumed **as a library/framework** — to embed Noir's workflow engine, hybrid retrieval, cross-session memory, bounded model layer, or scaffold engine in your own tool or host adapter.

> **What Noir is NOT:** an LLM runtime. There is no agent loop and no `tools`/`stream` generation surface. The optional model layer is single-shot, provider-explicit, and null-degrades without a key. See [`architecture/README.md`](architecture/README.md).

## Stability and versioning

The **v1.x public surface** is the set of symbols each package re-exports from its `src/index.ts` barrel — that is what this document covers. Anything imported from a deeper path (e.g. `@noir-ai/core/dist/lib/foo.js` or `@noir-ai/store/src/sqlite-store.js`) is **internal** and may change between minor versions without notice. If you need a symbol that is not in the barrel, open an issue before depending on the deep path.

Versioning: Noir follows the channel model documented in [`releasing.md`](releasing.md) — `beta` on `develop`, stable `1.x` on `main`. Within the `1.x` line the barrels are additive-only (new exports are minor-safe; removals/rename would be a major). The published packages are versioned in lockstep (all `1.x.y` together); the private workspace-root `package.json` version is not part of that release set.

## Install

The library packages are published to npm under the `@noir-ai` scope. The API documented here is in the current beta, so install the `beta` channel. Packages have small, explicit dependency surfaces (the store pulls `better-sqlite3` + `sqlite-vec`; the context engine pulls `@huggingface/transformers` + `onnxruntime-node` for local embeddings; the model layer dynamically imports provider SDKs only when their adapter is selected).

```bash
npm install @noir-ai/core@beta @noir-ai/store@beta @noir-ai/workflow@beta
```

In a pnpm workspace (the layout this repo uses), depend on `workspace:*` and consume from source.

---

## `@noir-ai/core` — config schema, project layout, managed-region markers

The shared foundation: the zod config schema, the `.noir/` path layout, the managed-region marker taxonomy, project-id minting, and the ignore-block sync. Pure (no I/O except `syncIgnores`); the lowest-dep package everything else builds on.

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `NoirConfigSchema` | zod schema | The authoritative schema for `.noir/config.yml`. Use `.parse(yaml)` to validate. |
| `parseConfig` | `(raw: string) => NoirConfig` | Parse + validate a YAML config string. |
| `loadProjectInfo(root)` | `(root: string) => ProjectInfo` | Load + validate a project's `.noir/` (id + config). Throws on parse error. |
| `paths` | object | `noirHome()`, `NOIR_DIR`, `modelsDir()`, and `.noir/`-relative path helpers (`config`, `projectId`, `storeDb`, `rulesMd`, …). |
| `managedBlock(name, hash)` | `(name, hash: boolean) => string` | Build a `<!-- noir:<name> begin -->` marker block. |
| `CONTEXT_BLOCK`, `RULES_BLOCK`, `IGNORE_BLOCK`, `CONTEXT_BLOCK_BEGIN`, `CONTEXT_BLOCK_END` | strings | The canonical marker names used across host files. |
| `readManagedBlock`, `stripManagedBlock`, `writeManagedRegion`, `commentStyleFor` | fns | Read/write/strip managed regions in host files (e.g. the `CLAUDE.md` `@import` block). |
| `createProjectId()` | `() => ProjectId` | Mint a new canonical project id (used by `noir init`). |
| `syncIgnores(root)` | `(root) => { files: string[] }` | Read `.noir/ignore`-managed files; consumed by `noir init`/`sync`. `IGNORE_BLOCK` is the marker name. |
| `NOIR_VERSION` | string | The toolkit version (semver). |

```ts
import { NoirConfigSchema, loadProjectInfo, paths, createProjectId } from '@noir-ai/core';

const project = loadProjectInfo(process.cwd());          // { id, config, root }
const cfg = NoirConfigSchema.parse(parsedYaml);           // validate a config shape
const id = createProjectId();                              // UUID, e.g. '123e4567-e89b-42d3-a456-426614174000'
const dbPath = paths.storeDb(project.root, project.id);   // .noir/store/<id>.db
```

Design record: [`specs/2026-07-23-noir-toolkit-design.md`](specs/2026-07-23-noir-toolkit-design.md) (foundation slice).

---

## `@noir-ai/store` — embedded SQLite + FTS5 + sqlite-vec

The persistence layer: `better-sqlite3` (SQLite) + FTS5 (BM25 with window-extracted snippets) + `sqlite-vec` (vector kNN). One project-local DB at `.noir/store/<projectId>.db`. The KV surface (`getState`/`setState`) is the substrate the context, memory, and workflow layers layer on.

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `openStore(opts)` | `(opts: OpenOptions) => Promise<Store>` | Open (and on a read-write open, create) the project DB. `OpenOptions = { projectId, root, readonly? }`. |
| `Store` (interface) | — | The handle returned by `openStore`. See methods below. |
| `vecAvailability()` | `() => VecAvailability` | Probe whether `better-sqlite3` + `sqlite-vec` load on this host. `{ ok: true } | { ok: false, reason }`. |
| `migrate` | `(db, ...) => ...` | Internal migration entry (run once on a fresh DB; `openStore` invokes it for you). |
| Types | — | `EmbedFn`, `FtsHit`, `IndexDoc`, `OpenOptions`, `SearchFtOpts`, `VecHit`, `VecOpts`, `VecUpsertMeta`. |

**`Store` interface methods** (the framework surface for read/write after `openStore`):

- `getState<T>(key): T | null` / `setState<T>(key, value): void` — namespaced key-value (used by workflow, memory, context for their KV layouts).
- `indexDoc(doc: IndexDoc): void` / `deleteDoc(id): void` — FTS-indexed markdown/docs rows.
- `searchFt(query, opts?): FtsHit[]` — BM25 search with window-extracted snippets (never truncated).
- `upsertVec(id, vec: Float32Array, meta?): void` / `deleteVec(id): void` — vector rows.
- `knn(vec: Float32Array, opts?: VecOpts): VecHit[]` — k-nearest-neighbour search (ascending distance).
- `countDocs()` / `countVecs()` — live row counts.
- `exportMarkdown(dir): Promise<string[]>` — export all docs rows with YAML frontmatter.
- `close(): Promise<void>` — close the handle.

```ts
import { openStore, vecAvailability } from '@noir-ai/store';

const probe = vecAvailability();
if (probe.ok !== true) throw new Error(`native layer unavailable: ${probe.reason}`);

const store = await openStore({
  projectId: '123e4567-e89b-42d3-a456-426614174000',
  root: process.cwd(),
  readonly: false,
});
store.indexDoc({ id: 'doc-1', source: 'docs', content: '…' });
const hits = store.searchFt('workflow', { limit: 5 });
store.setState('my:key', { any: 'json' });
const v = store.getState<{ any: string }>('my:key');
await store.close();
```

The store is single-writer (the daemon owns the write handle in normal operation). Read-only opens (used by `noir doctor`, the CLI's MCP clients, and tests) are always safe. Design record: [`specs/2026-07-23-noir-toolkit-design.md`](specs/2026-07-23-noir-toolkit-design.md).

---

## `@noir-ai/workflow` — the SDD lifecycle FSM

A hand-rolled finite-state machine for spec-driven development: `intake → specified → planned → implemented → done`, with an escapable, observable gate between each phase. Every gate decision is recorded. State survives daemon restarts (stored in the `workflow:<id>` KV row).

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `WorkflowEngine` | class | The orchestrator. Construct with `(store, root, projectId, gateConfig?)`. Methods below. |
| `STATES`, `PHASES`, `TASK_CLASSES` | readonly arrays | The canonical state / phase / task-class enumerations. |
| `stateForPhase`, `nextPhase`, `canTransition`, `applyTransition` | fns | The pure FSM helpers (transition legality, phase→state mapping). |
| `gateFor`, `readGateHistory`, `recordGate` | fns | The observable-gate audit surface. |
| `runQuick`, `resumeTask`, `QUICK_SPEC_STUB` | fns | Quick-mode + cross-session resume (`resumeTask(store)` reads the latest task from KV). |
| Artifact writers | fns | `writeIntake`, `writeSpec`, `writePlan`, `writePrd`, `readPrd`, `writeTask`, `writeDecisionStub`, `writeChangelogStub`, `writeAuditExport`. **These are standalone functions** (there is no `ArtifactWriter` class). |
| Types | — | `AdvanceOpts`, `GateResult`, `GateResultInput`, `Mode`, `Phase`, `TaskClass`, `TaskState`, `WorkflowGateConfig`, `WorkflowState`. |

**`WorkflowEngine` methods** (the framework surface):

- `startTask(taskId, slug, mode, taskClass?): Promise<TaskState>` — create a task at the `intake` phase (the caller supplies the `taskId`; re-starting an id overwrites the KV row).
- `advance(taskId, opts?: AdvanceOpts): Promise<TaskState>` — drive the FSM forward one phase; records the landing gate. `AdvanceOpts` carries `force?: { reason?: string }` (the explicit override) and the bypass/skip escape hatches.
- `status(taskId): TaskState | null` — read the current state.
- `setBlocked(taskId, reason?): Promise<TaskState>` — mark/unmark a task blocked (captured on `TaskState` for surfacing).
- `checkpoint(taskId): Promise<void>` — observable-checkpoint hook (cross-session resume reads `workflow:<id>` from KV directly).

```ts
import { WorkflowEngine } from '@noir-ai/workflow';
import { openStore } from '@noir-ai/store';

const store = await openStore({ projectId, root, readonly: false });
// The engine takes (store, root, projectId, gateConfig?) — the last is optional.
const engine = new WorkflowEngine(store, root, projectId);
const task = await engine.startTask('task-001', 'add-auth', 'full', 'feature');
await engine.advance(task.taskId);                          // intake → specified (records the spec gate)
await engine.advance(task.taskId, { force: { reason: 'spike' } }); // bypass with audit
console.log(engine.status(task.taskId)?.phase);
```

Design record: [`specs/2026-07-23-noir-toolkit-design.md`](specs/2026-07-23-noir-toolkit-design.md). Debt-batch W1/W2 collapsed the dual source of truth and removed the vestigial checkpoint save/restore.

---

## `@noir-ai/adapters` — host abstraction

The `HostAdapter` interface + a registry of builtin adapters. Each adapter knows how to emit its host's context file, skills directory, and MCP config. Adding a host means authoring an adapter and registering it; the CLI `--host` flag and `resolveAdapter` do the dispatch.

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `HostAdapter` (interface) | — | The contract every host implements (`id`, `agentsMdPath?`, `mcpConfigPath?`, skill-dir resolver, `emitMcpConfig?`, …). |
| `HostId` (type) | union | `'claude' | 'agents-md' | 'gemini' | 'cursor' | 'opencode'`. |
| `resolveAdapter(host)` | `(host: HostId) => HostAdapter` | Registry lookup; exhaustiveness-checked. |
| `SUPPORTED_HOSTS` | `readonly HostId[]` | Frozen iteration list (parity with `HostId`). |
| `emitAgentsMd`, `AGENTS_MD_FILENAME` | fn / string | Emit the universal AGENTS.md baseline. |
| `buildMcpServersJson` | fn | Build an MCP server-config JSON shape (host-agnostic base). |
| Builtin adapters | `HostAdapter` values | `claudeAdapter`, `agentsMdAdapter`, `geminiAdapter`, `cursorAdapter`, `opencodeAdapter`. |
| Types | — | `EmitContext`, `McpConfigOptions`, `IntegrationMcpEmission`. |

```ts
import { resolveAdapter, SUPPORTED_HOSTS, emitAgentsMd } from '@noir-ai/adapters';

const adapter = resolveAdapter('cursor');         // the cursor adapter
const ectx = { root: process.cwd() };
const mcpPath = adapter.mcpConfigPath?.(ectx);    // '.cursor/mcp.json'
const agentsMd = emitAgentsMd(ectx);
for (const h of SUPPORTED_HOSTS) console.log(h);  // iterate every host
```

Design record: [`superpowers/specs/2026-07-25-s10-multihost-design.md`](superpowers/specs/2026-07-25-s10-multihost-design.md).

---

## `@noir-ai/skills` — builtin skill pack + compiler

The native skill library (**33 builtins + 1 integration = 34 skills**) and a copy-and-validate compiler that transforms each skill into a host's emission format. The `noir-*` namespace is managed: `noir init`/`sync` overwrite it idempotently.

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `compileSkill(skill, target?)` | `(skill: BuiltinSkill, target?: CompileTarget) => CompiledSkill` | Transform one skill for a host (`target` defaults to `'claude'`). |
| `emitSkillsToDir(dir, opts?)` | `(dir, opts?: { target?: CompileTarget }) => Promise<EmitSummary>` | Compile + write all discovered skills to a directory. |
| `validateSkill(skill)` | `(skill: BuiltinSkill) => ValidationResult` | Lint a skill's frontmatter + body. |
| `discoverAll`, `discoverBuiltin`, `discoverIntegrations` | fns | Discover skills from the builtin pack (+ any configured integrations). |
| `BUILTIN_DIR`, `INTEGRATIONS_DIR` | strings | Filesystem roots for the two skill sources. |
| `parseFrontmatter`, `bodyOf`, `looksLikeWhenDescription` | fns | Frontmatter + body helpers for skill authoring. |
| Integration schema | — | `compileIntegration`, `parseIntegration`, `validateIntegration`, `IntegrationAuthSchema`, `IntegrationDeclarationSchema`, `IntegrationMcpSchema`, `IntegrationSddSchema`, `runtimeEmitsHostMcp`. |
| `FORBIDDEN_RESIDUE` | regex/const | Residue lint (forbidden tokens after compile). |
| Types | — | `BuiltinSkill`, `BuiltinReference`, `CompiledSkill`, `CompiledIntegration`, `CompileTarget`, `EmitSummary`, `EmittedFile`, `IntegrationDeclaration`, `IntegrationSkill`, `SkillFrontmatter`, `ValidationResult`. |

```ts
import { discoverAll, compileSkill, emitSkillsToDir, validateSkill } from '@noir-ai/skills';

// discoverAll() returns `{ builtins, integrations }`; iterate either/both.
const all = discoverAll();
const skills = all.builtins;
for (const s of skills) {
  const v = validateSkill(s);
  if (!v.ok) console.warn(v.errors);
}
const compiled = compileSkill(skills[0], 'cursor');      // CompiledSkill (host-shaped)
await emitSkillsToDir('.cursor/rules', { target: 'cursor' });
```

Design records: [`specs/2026-07-23-noir-toolkit-design.md`](specs/2026-07-23-noir-toolkit-design.md) (builtin pack) and [`superpowers/specs/2026-07-25-slice-x-integration-design.md`](superpowers/specs/2026-07-25-slice-x-integration-design.md) (integrations).

---

## `@noir-ai/context` — hybrid retrieval engine

Fills the `EmbedFn` seam declared (but never implemented) by `@noir-ai/store`: local embeddings (all-MiniLM-L6-v2, 384-dim) or remote/ollama, SHA-256 content-hash incremental indexing into the store's existing tables (no schema migration), and BM25 ∪ cosine-kNN retrieval fused by Reciprocal Rank Fusion into a token-budget packer with window-extracted snippets.

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `ContextEngine` | class | The `ctx.context` service. Construct with `ContextEngineOptions`. |
| `createIndexer(opts)` | `(opts) => Indexer` | The standalone content-hash incremental indexer (the ONLY context-side writer). |
| `createRetriever(opts)` | `(opts) => Retriever` | The standalone hybrid retriever (BM25 ∪ kNN → RRF → budget → snippets). |
| `fuseRrf(lists, opts?)` | `(lists, opts?) => RrfResult[]` | Pure Reciprocal Rank Fusion (k=60, weights default `[0.5, 0.5]`). Reused by `@noir-ai/memory`. |
| Embedders | — | `createEmbedFn` (factory), `localEmbedder`, `remoteEmbedder`, `ollamaEmbedder`, `fakeEmbedFn`, `l2normalize`, `DEFAULT_LOCAL_MODEL`, `EMBED_DIM` (384), `MODELS_DIR`. |
| Chunker | — | `chunkFile`, `estimateTokens`, `explodeIdentifiers`, `inferLanguage`, `withIdentifierExplosion`, `DEFAULT_CHUNK_MAX_TOKENS`, `DEFAULT_CHUNK_OVERLAP`. |
| Config | — | `resolveEmbedderConfig(cfg)` — map a `@noir-ai/core` user config to the runtime embedder shape (pure; no `core→context` cycle). |
| Constants | — | `DEFAULT_RRF_K`, `DEFAULT_RRF_WEIGHTS`, `DEFAULT_BUDGET_TOKENS`, `DEFAULT_SEARCH_LIMIT`, `DEFAULT_SNIPPET_WINDOW_TOKENS`, `SKIP_DIRS`, `SOURCES`. |
| Types | — | `ContextEngineOptions`, `ContextStatus`, `Indexer`, `Retriever`, `RetrieverDeps`, `FuseRrfOptions`, `RrfResult`, `EmbedFn` (re-exported from store), `SearchOptions`, etc. |

```ts
import { ContextEngine, resolveEmbedderConfig } from '@noir-ai/context';
import { openStore } from '@noir-ai/store';

const store = await openStore({ projectId, root, readonly: false });
// embedderCfg is an EmbedderConfig resolved from the core user block via
// resolveEmbedderConfig (pure; defers native/network to the first embed() call).
const engine = new ContextEngine({
  store,
  root,
  projectId,
  embedderCfg: resolveEmbedderConfig({ kind: 'local', dim: 384 }),
});
await engine.indexPaths(['src/auth.ts']);          // content-hash incremental (the only context writer)
const results = await engine.search('login flow', { limit: 5, budgetTokens: 4096 });
console.log(engine.status());                      // ContextStatus: embedder info + indexed-file count
```

The `EmbedFn` seam is the integration point for swapping embedders (local MiniLM by default; OpenAI/Voyage/Cohere/Ollama opt-in). Design record: [`superpowers/specs/2026-07-24-s6-context-design.md`](superpowers/specs/2026-07-24-s6-context-design.md).

---

## `@noir-ai/memory` — cross-session memory layer

Local-first, in-process memory layered **on top of** the store (FTS5 docs + sqlite-vec + KV — no schema migration). Append-only observations typed by a taxonomy, recalled via the S6 hybrid retriever (reused as-is, scoped to `source:'memory'`), consolidated into derived `type:'lesson'` rows by an explicit, provider-gated job.

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `createMemoryEngine(opts)` | `(opts: MemoryEngineOptions) => MemoryEngineImpl` | The factory (the `ctx.memory` service). |
| `MemoryEngine` (interface) | — | The contract. See methods below. |
| `MemoryEngineImpl` | class | The implementation (returned by the factory). |
| `recallMemory(deps, query, opts?)` | fn | The standalone hybrid recall pipeline (BM25 ∪ kNN → RRF → entity-boost → KV hydration). |
| `runConsolidation(deps, opts?)` | fn | The explicit, provider-gated consolidation job. Pure helpers: `gatherCandidates`, `serializeCandidates`, `dedupeConcepts`. |
| Capture bridge | — | `toSaveInput`, `buildContent`, `captureSource`, `describeToolCall`, `extractFiles`, `inferType`, `CAPTURE_HOOKS`, `DEFAULT_CAPTURE_HOOKS`, `DEFAULT_CAPTURE_POLICY` — host-neutral capture-event → SaveInput mapper. |
| Config | — | `resolveMemoryConfig(cfg)` — map the core user `memory` block to the runtime `MemoryConfig` (pure; refuses consolidation when no provider). |
| KV layout helpers | — | `getObservation`, `setObservation`, `clearObservation`, `getObservationIds`, `setObservationIds`, `obsKey`, `OBS_PREFIX`, `INDEX_KEY`, `getSessions`, `setSessions`, `bumpSession`, `decrementSession`. |
| Taxonomy | — | `MEMORY_TYPES` (`pattern | preference | architecture | bug | workflow | fact | decision | lesson`), `DEFAULT_IMPORTANCE`. |
| Types | — | `Observation`, `SaveInput`, `MemoryHit`, `MemoryType`, `MemorySource`, `SessionInfo`, `ConsolidationConfig`, `MemoryConfig`, `ConsolidateOptions`, `ConsolidationResult`, `RecallOptions`, `SearchOptions`, `ForgetResult`, `MemoryEngineOptions`. |

**`MemoryEngine` interface methods** (the framework surface):

- `save(input: SaveInput): Promise<Observation>` — append an observation (always local + free).
- `recall(query, opts?: RecallOptions): Promise<MemoryHit[]>` — hybrid recall (BM25 ∪ kNN via RRF).
- `search(query, opts?: SearchOptions): Promise<MemoryHit[]>` — BM25-only instant path.
- `sessions(): SessionInfo[]` — per-session rollups.
- `forget(ids: string[]): ForgetResult` — remove observations (KV row + best-effort index cleanup).
- `consolidate?(opts?: ConsolidateOptions): Promise<ConsolidationResult>` — optional (registered only when `memory.consolidation.enabled`).

```ts
import { createMemoryEngine } from '@noir-ai/memory';
import { openStore } from '@noir-ai/store';

const store = await openStore({ projectId, root, readonly: false });
// `embed` is the shared EmbedFn (the daemon resolves one and passes the SAME
// fn to context + memory). `model` is optional; omit it ⇒ consolidation refuses.
const memory = createMemoryEngine({ store, root, projectId, embed: async () => new Float32Array() });
await memory.save({ content: 'Use ESM imports everywhere', type: 'preference' });
const hits = await memory.recall('import style');
```

Hard rules (blueprint D6): in-process only (no sidecar); canonical `ProjectId` (never a filesystem path); capture/store/retrieve always local + free; any LLM touch is opt-in + provider-explicit (refuses + logs if no provider, never a silent paid call). Design record: [`superpowers/specs/2026-07-24-s7-memory-design.md`](superpowers/specs/2026-07-24-s7-memory-design.md).

---

## `@noir-ai/model` — bounded single-shot model layer

A thin library (NOT a host/MCP surface): one `complete()` function backed by provider adapters. Consumed in-process by the workflow (artifact drafting), memory (consolidation), and CLI (home help) to fill bounded content slots on explicit request. It can express ONLY a single completion — there is no `tools` / `stream` parameter. When no provider is configured (or a keyed provider's env var is missing), `complete()` returns `null` and callers substitute a template.

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `complete(req, cfg?)` | `(req: CompleteRequest, cfg?: ModelConfig) => Promise<CompleteResult>` | The single entry. Returns `null` (degradation) or `{ ok: false, reason }` (attempted-call failure) or `{ ok: true, text, usage? }`. |
| `draftPrd(opts, input, cfg?)` | `(opts: DraftPrdOptions, input: DraftPrdInput, cfg?: ModelConfig) => Promise<string \| null>` | Bounded PRD drafting; returns `null` to degrade to `PRD_FALLBACK_TEMPLATE`. |
| `PRD_FALLBACK_TEMPLATE` | string | The offline-template body (use when `draftPrd` returns null). |
| `resolveModelConfig(cfg)` | fn | Map the core user `model` block to the runtime resolved shape (providers, tiers, key presence). Pure projection — reads env-var NAMES only, never a live call. |
| `TIER_MAX_TOKENS` | record | Per-tier token caps (`draft`, …). |
| Registry | — | `registerProviderAdapter`, `getProviderAdapter`, `clearProviderAdapters`. |
| Types | — | `CompleteRequest`, `CompleteResult`, `CompleteSchema`, `CompleteUsage`, `ModelConfig`, `ProviderAdapter`, `ProviderConfig`, `Tier`, `DraftPrdInput`, `DraftPrdOptions`, `ResolvedModelConfig`. |

**Provider adapters.** Three are wired by side-effect import on any `import '@noir-ai/model'`: `anthropic` (`@anthropic-ai/sdk`, loaded dynamically inside `complete()`), `openai` (`openai` SDK, loaded dynamically), and `openai-compatible` (global `fetch`, zero deps). They are **not exported as named symbols** — they self-register into the registry at module load. Dispatch is by `req.provider || cfg.defaultProvider`.

```ts
import { complete, resolveModelConfig } from '@noir-ai/model';

const result = await complete(
  { provider: 'anthropic', model: 'claude-sonnet-4', system: '…', prompt: '…', tier: 'draft' },
  { defaultProvider: 'anthropic', providers: { anthropic: { model: 'claude-sonnet-4', apiKeyEnv: 'ANTHROPIC_API_KEY' } } },
);
if (result === null) {
  // no provider configured or key missing → degrade to a template
} else if (result.ok === true) {
  console.log(result.text);
}
```

Design record: [`superpowers/specs/2026-07-24-s8-model-design.md`](superpowers/specs/2026-07-24-s8-model-design.md).

---

## `@noir-ai/create` — the scaffold engine

The orchestrator behind `noir init` / `noir sync` / `noir create`. A three-mode writer (regenerate / managedBlock / skipIfExists), a declarative manifest of artifact entries, `{{var}}` template interpolation, a `.noir/scaffold-version` stamp, read-only stack detection, and inline-conflict migrations.

**Key exports**

| Symbol | Shape | Notes |
|---|---|---|
| `scaffold(opts)` | `(opts: ScaffoldOptions) => Promise<ScaffoldResult>` | The orchestrator. `ScaffoldOptions` requires `root` and `mode`; it also accepts `host`, `transport`, `url`, `projectId`, `upgrade`, `force`, `dryRun`, `conflictPolicy`, `onConflict`, `mergeManagedRegions`, and `interactive`. |
| `buildManifest(ctx)` | `(ctx: BuildManifestContext) => ManifestEntry[]` | The host-aware artifact manifest for the `init`/`sync` modes. |
| `buildHostArtifacts(adapter, ctx)` | `(adapter: HostAdapter, ctx: BuildHostArtifactsContext) => ManifestEntry[]` | The host-specific artifact list (AGENTS.md where applicable, host context file, and MCP config). Skills are emitted separately. |
| Three-mode writers | fns | `regenerate`, `managedBlock` (alias for the core marker helper), `skipIfExists`. The three write policies an entry can declare. |
| `render` | fn | `{{var}}` template interpolation. |
| `detectStack` | fn | Read-only stack detection (returns `StackInfo`). |
| `loadTemplate`, `templatesDir` | fn / string | Template loader + the templates root. |
| Version stamp | — | `CURRENT_SCAFFOLD_VERSION`, `readScaffoldVersion(root)`, `writeScaffoldVersion(root, v)`, `scaffoldVersionPath(root)`. |
| Migrations | — | `runMigrations`, `MIGRATIONS`, `applyWithConflict`, `applyInlineConflict`. |
| Types | — | `ScaffoldMode`, `ScaffoldOptions`, `ScaffoldResult`, `BuildManifestContext`, `BuildHostArtifactsContext`, `ManifestEntry`, `HostTag`, `WriteMode`, `WriteOutcome`, `MigrationContext`, `MigrationResult`, `MigrationScript`, `StackInfo`. |

```ts
import { scaffold, buildManifest, detectStack } from '@noir-ai/create';
import { resolveAdapter } from '@noir-ai/adapters';

const adapter = resolveAdapter('claude');
const stack = detectStack(process.cwd());        // read-only
const result = await scaffold({
  root: process.cwd(),
  mode: 'init',
  host: 'claude',
  projectId: '123e4567-e89b-42d3-a456-426614174000',
});
// buildManifest({ root, host: 'claude', projectId, transport: 'stdio' }) → ManifestEntry[]
```

Design records: [`superpowers/specs/2026-07-25-slice-s-scaffold-design.md`](superpowers/specs/2026-07-25-slice-s-scaffold-design.md).

---

## `@noir-ai/daemon` and `@noir-ai/cli`

The remaining two packages are **runtime/command surfaces**, not framework libraries:

- **`@noir-ai/daemon`** is the runtime authority: it owns the store's single write handle, resolves the embedder once per serve lifecycle, and exposes the Noir MCP server (`noir mcp serve`). It is meant to be run as a process (stdio or HTTP), not embedded.
- **`@noir-ai/cli`** is the `noir` command tree (commander + @clack/prompts). It is the shell entry point; consume it as a binary, not a library. (`@noir-ai/create` is the embedded-friendly subset of what `noir init`/`sync` do.)

If you are building a host integration, the entry points are `@noir-ai/adapters` (emit the host's files) and `noir mcp serve` (the MCP server the host connects to). See [`architecture/README.md`](architecture/README.md) for the connection topology.

---

## See also

- [`architecture/README.md`](architecture/README.md) — how the eleven packages fit together and how a host connects.
- [`usage.md`](usage.md) — the `noir` CLI command reference + config schema (user-facing).
- [`packaging.md`](packaging.md) — how to add a new `@noir-ai/*` package (the `scripts/new-package.mjs` conventions).
- [`releasing.md`](releasing.md) — the npm publish runbook (automation token, provenance, beta/stable channels).
- [`specs/2026-07-23-noir-toolkit-design.md`](specs/2026-07-23-noir-toolkit-design.md) — the v1.0 design blueprint.
- Per-slice design records under [`superpowers/specs/`](superpowers/specs/).
