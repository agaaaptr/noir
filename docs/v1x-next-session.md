# Noir — next-session handoff & playbook

> **Status (2026-07-25): v1.1.0-beta.1 PUBLISHED on npm (dist-tag `beta`).** All 6 v1.x capability slices (K/R/I/P/S/X) + the consolidated debt batch are DONE on `develop` (merged to the release tag). **965/965 tests green**, build/typecheck/lint (0 warnings) clean. This doc + `docs/roadmap.md` + `docs/CHANGELOG.md` + `/recall noir` = full context for the next session.

## What this session shipped (v1.1.0-beta.1)

| Area | What | Key commits |
|---|---|---|
| **Slice S — Scaffold** | New `@noir-ai/create` (three-mode writer `regenerate`/`managedBlock`/`skipIfExists` generalizing keystone-K `blockWriter`; declarative manifest; `{{var}}` templates; `.noir/scaffold-version`; migrations registry w/ inline-conflict; read-only stack-detect). CLI: `noir init`/`sync` consume the engine; **new `noir create [dir]`** (AI-layer only); `noir init --upgrade`; `noir doctor` scaffold-version drift. Opus-reviewed (project.id heal, CLAUDE.md idempotency, legacy NOIR.md self-heal). | `f2730da` |
| **Slice X — Integration** | First-class integration layer; first integration = **ClickUp**. `noir-clickup` skill + `integration.json` (`runtime:'gated-write-proxy'`) + real `references/`. `discoverIntegrations()` + `integration.json` Zod schema (= the deferred **K3**); `discoverAll()` emits builtins+integrations (pack 34). Daemon `integrations_auth` (resolves `CLICKUP_API_TOKEN` server-side) + `noir.clickup_write` gated-write-proxy (HARD confirm gate; allowlist; id-charset; 429 backoff; audit JSONL). Core `integrations` config; adapter `emitMcpConfig` overload. Opus security-reviewed (no CRITICAL; fixed assignee-plural + runtime-gating). **Live-verified** (token resolves, `GET /user`→200). | `5a1817a` |
| **Debt batch** | R4 (rules config) · R5 (doctor RULES budget) · P3 (model `draftPrd`) · P4 (prd config + soft gate) · W1 (workflow dual-SoT collapsed) · W2 (checkpoint→audit export) · W3 (S4 nits) · C1 (kNN snippet hydration) · T2 (stale-skill cleanup) · T1 (`tsconfig.test.json` pilot on cli) · lint 10→0. | `e071460` |

Test trajectory: 729 (1.0.0-beta.1) → 857 (Slice S) → 914 (Slice X) → 953 (debt A) → 965 (debt B). 11 packages (added `@noir-ai/create`).

## Release state
- **v1.1.0-beta.1** published to npm (dist-tag `beta`, SLSA provenance), cut from `develop` via `release.yml` (tag on `develop` → `channel=beta`).
- `main` / npm `latest` still at **1.0.0-beta.1** (729 tests). Stable `1.x` promotion is a separate decision (see below).

## Next-session goal candidates (pick with the user)
1. **Validate 1.1.0-beta.1 in a real project** (`npx @noir-ai/cli@beta init` + exercise ClickUp / scaffold / context / memory end-to-end), then **promote to stable `1.0.0` or `1.1.0`** (merge `develop`→`main`, `node scripts/bump-version.mjs <ver>`, tag on `main` → CI publishes `--tag latest`).
2. **S10 — more host adapters** (gemini/agy/opencode/qwen) — the largest remaining v1.x line. REQUIRES an adapter registry (`resolveAdapter(host)`) + widening `host` config from `z.literal('claude')` + replacing direct `claudeAdapter` imports in the CLI + widening the skills `CompileTarget`. The single-host assumption is the S10 gate.
3. **Finish the `tsconfig.test.json` rollout** to the remaining 9 packages (cli is the pilot; ~8 errors each is the representative upper bound).
4. **Daemon detach / socket-activation / auth token / per-project `daemon.json`** (foreground + global singleton today).
5. Any item from the **v1.x backlog** below.

## Deferred to a later beta / v1.x (NOT abandoned — see `docs/roadmap.md` §v1.x backlog)
- **Embedding-model upgrade (`bge-small-en-v1.5`)** — *needs a model-version stamp on vec rows + re-index-on-change mechanism*; doing it without corrupts the vector space (mixed MiniLM/BGE). Implementation sketch: stamp `embedding:model` KV on index; on embedder load, if stamped model ≠ current, clear vecs + reindex.
- S10 multi-host adapters (+ adapter registry + `CompileTarget` widening). S11 remainder (framework/SDK docs, `noir doctor` publish checks).
- Daemon: detach/socket-activation/auth/per-project `daemon.json`. CLI/TUI: full-screen Ink/blessed TUI; in-process read-only store fallback for `context`/`memory`/`task`; `task` id/slug distinction.
- Context: tree-sitter symbol-aware chunking; full `.gitignore` parsing; `trigram` tokenizer; `--watch` full daemon wiring; remote embedding SDK completion; embedding model upgrade.
- Memory: graph/temporal-KG; LLM auto-tagging; auto-capture-by-default (opt-in template only today); multi-user/org (v2).
- Model: OS keychain; prompt caching; provider-native JSON strict; `onUsage` sink; streaming (forbidden by D5).
- Toolchain: `tsconfig.test.json` rollout (9 pkgs); `references/` skill coverage (ClickUp ships one real ref now); engine-naming consistency; `indexer.ts` + `daemon/server.ts` god-file refactors; `biome.json` schema drift; first-run model-download UX.
- S1 micro-hardening (mkdir readonly guard, idempotent `close()`, `exportMarkdown` mkdir, `db.transaction()`, YAML escaping, chmod-555 test guard) + S5 micro (`compiler.ts` comment, `discover.ts` catch-all narrowing).

## Slice-X known refinement (flagged in review, non-blocking)
- The `noir.clickup_write` op vocabulary accepts both short (`status|subtask|comment|batch`) and `task:`-prefixed forms + flat/`payload` input (dual-form, normalized). A future tighten could pick one canonical form.
- ClickUp 2-way sync is at `/wrap` only (no standalone `noir clickup sync` command for v1.x).
- Cassette strategy is `mcp-record`-style record/replay (no MockServer dep).

## Resume recipe
1. `cd` to repo; `/recall noir` → lands on the v1.1.0-beta.1 checkpoint.
2. Read this doc + `docs/roadmap.md` "Current status" + `docs/CHANGELOG.md` §1.1.0-beta.1.
3. Confirm `develop` baseline: `git log --oneline -1 && pnpm build && pnpm typecheck && pnpm test` (expect 965/965).
4. Pick a next-session goal (above) with the user; follow the dogfooded SDD cadence (brainstorm→spec→plan→subagent-driven implement+review→main-loop validates→opus review→docs/memory checkpoint→local commit).

## Conventions (unchanged)
Skill prefix `noir-`; commits LOCAL on `develop` until a release push (don't push/publish without asking); per-slice `pnpm build/lint/typecheck/test` gate; `biome check --write` after new files (import-order is error-level); dogfood SDD; graceful degradation; no silent paid calls; adopt ideas, not copies. Sub-agents: Opus (review/judgment) + Sonnet (implementation) only; main loop runs all `pnpm` validation.
