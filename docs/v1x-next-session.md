# Noir — next-session handoff & playbook

> **Status (2026-07-26): v1.2.0-beta.1 PUBLISHED on npm (dist-tag `beta`).** Tag `v1.2.0-beta.1` is pushed; GitHub Actions `release.yml` published all 11 `@noir-ai/*` packages with provenance; `npm view @noir-ai/cli dist-tags` shows `beta: 1.2.0-beta.1`. The v1.x capability set — keystone refactor (K) + extensions (R/I/P/S/X) + the consolidated debt batch (shipped as 1.1.0-beta.1) **plus S10 multi-host adapters + the S11 SDK/doctor remainder (shipped as 1.2.0-beta.1)** — is live. **1089/1089 tests green**, build/typecheck/lint (0 warnings) clean. `main` / npm `latest` stay at 1.0.0-beta.1 until the beta is validated and merged. This doc + `docs/roadmap.md` "Current status" + `docs/CHANGELOG.md` + `/recall noir` = full context.

## What shipped (v1.2.0-beta.1)

Two beta cuts are live on the `beta` dist-tag. **1.1.0-beta.1** added the six v1.x capability slices + debt; **1.2.0-beta.1** adds multi-host + the SDK remainder and **supersedes 1.1.0-beta.1** on the tag.

**1.1.0-beta.1 (the v1.x capability slices + debt):**

| Area | What | Key commits |
|---|---|---|
| **Slice S — Scaffold** | New `@noir-ai/create` (three-mode writer `regenerate`/`managedBlock`/`skipIfExists` generalizing keystone-K `blockWriter`; declarative manifest; `{{var}}` templates; `.noir/scaffold-version`; migrations registry w/ inline-conflict; read-only stack-detect). CLI: `noir init`/`sync` consume the engine; **new `noir create [dir]`** (AI-layer only); `noir init --upgrade`; `noir doctor` scaffold-version drift. Opus-reviewed (project.id heal, CLAUDE.md idempotency, legacy NOIR.md self-heal). | `f2730da` |
| **Slice X — Integration** | First-class integration layer; first integration = **ClickUp**. `noir-clickup` skill + `integration.json` (`runtime:'gated-write-proxy'`) + real `references/`. `discoverIntegrations()` + `integration.json` Zod schema (= the deferred **K3**); `discoverAll()` emits builtins+integrations (pack 34 = 33 builtins + 1 integration). Daemon `integrations_auth` (resolves `CLICKUP_API_TOKEN` server-side) + `noir.clickup_write` gated-write-proxy (HARD confirm gate; allowlist; id-charset; 429 backoff; audit JSONL). Core `integrations` config; adapter `emitMcpConfig` overload. Opus security-reviewed; **live-verified** (token resolves, `GET /user`→200). | `5a1817a` |
| **Debt batch** | R4 (rules config) · R5 (doctor RULES budget) · P3 (model `draftPrd`) · P4 (prd config + soft gate) · W1 (workflow dual-SoT collapsed) · W2 (checkpoint→audit export) · W3 (S4 nits) · C1 (kNN snippet hydration) · T2 (stale-skill cleanup) · T1 (`tsconfig.test.json` pilot on cli) · lint 10→0. | `e071460` |

Plus docs curation (`48230a3`) and the doctor fresh-project fix (`f3b7e8f`).

**1.2.0-beta.1 (multi-host + SDK remainder — commits `0d072bb`…`aa5618a`):**
- **S10 multi-host adapters** — `HostId` enum + `resolveAdapter(host)` registry (`0d072bb` foundation, `89e53e9` four adapters, `4a22e9c` CLI `--host` flag + host-aware scaffold + `doctor` host row). Noir is cross-CLI: **claude** (default, regression anchor) / **agents-md** / **gemini** / **cursor** / **opencode**. A bare `noir init` is byte-identical to pre-multi-host. The universal `AGENTS.md` is the 32-platform baseline; cursor skills compile to flat `.cursor/rules/<name>.mdc`; opencode emits a distinct `type`-tagged `opencode.json` MCP shape.
- **S11 remainder** (`f037ddf`): `docs/sdk.md` (per-package framework/library API surface — "usable as a framework") + `noir doctor publish` check (advisory package-metadata validation). **S11 is now fully resolved.**
- S10+S11 review fixes (`eb8c431`), README/usage/architecture multi-host sync + ADR-0004 + CHANGELOG (`3982949`), release commit (`414fa85`), pnpm-lock regen (`aa5618a` — HEAD).

Test trajectory: 729 (1.0.0-beta.1) → 966 (1.1.0-beta.1) → **1089 (1.2.0-beta.1)**. 11 packages (added `@noir-ai/create` at 1.1.0-beta.1). **Locked decisions:** [ADR-0004](decisions/0004-multi-host-adapters.md). **Design records:** `superpowers/specs/2026-07-25-s10-multihost-design.md` (S10), `specs/2026-07-25-v1x-capabilities-design.md` (v1.x slices).

## Release verification (DONE)

- Tag `v1.2.0-beta.1` pushed; `release.yml` derived `channel=beta` from the tag on `develop` → npm publish with provenance.
- `npm view @noir-ai/cli dist-tags` → `beta: 1.2.0-beta.1`.
- `npx @noir-ai/cli@beta --version` prints `1.2.0-beta.1`.
- `main` / npm `latest` stay at 1.0.0-beta.1 (the beta tag lives on `develop`).
- 1089/1089 tests green at the tag; build/typecheck/lint (0 warnings) clean.

## Next-session goal candidates (pick with the user)

1. **Validate `v1.2.0-beta.1` in a real project, per host** — `npx @noir-ai/cli@beta init` then exercise the lifecycle with `--host claude` (default), `--host gemini`, `--host cursor`, `--host opencode`, `--host agents-md`. Confirm `noir doctor` is exit-0 on each, the emitted artifacts land in the right places, and the universal `AGENTS.md` is byte-identical across hosts. Then **promote to stable `1.x`**: merge `develop`→`main`, `node scripts/bump-version.mjs <ver>`, tag on `main` → CI publishes `--tag latest`.
2. **S10 remainder — `qwen` and `agy` adapters** — the universal `AGENTS.md` covers them today; their native adapters land next. Single-host select is the v1.x surface; multi-host emit (`hosts:[...]` → emit for several hosts at once) is a later beta.
3. **`tsconfig.test.json` rollout** to the remaining 9 packages (cli is the pilot; ~8 errors each is the representative upper bound). Tests/typecheck stay green today via runtime; this hardens the static surface.
4. **Daemon detach / socket-activation / auth token / per-project `daemon.json`** (foreground + global singleton today).
5. **Embedding-model upgrade (`bge-small-en-v1.5`)** — needs a model-version stamp on vec rows + re-index-on-change mechanism (stamp `embedding:model` KV on index; on embedder load, if stamped model ≠ current, clear vecs + reindex). Without it the vector space corrupts (mixed MiniLM/BGE).
6. Any item from the **v1.x backlog** in `docs/roadmap.md` (context: tree-sitter chunking, full `.gitignore`, `trigram` tokenizer, `--watch` wiring; memory: graph/temporal-KG, LLM auto-tagging; model: OS keychain, prompt caching, provider-native JSON strict; toolchain: god-file refactors, `references/` skill coverage, first-run model-download UX).

## Deferred to a later beta / v1.x (NOT abandoned — see `docs/roadmap.md` §v1.x backlog)

- **S10 remainder:** `qwen` / `agy` native adapters; multi-host emit (`hosts:[...]` → emit for several hosts at once).
- **Daemon:** detach/socket-activation/auth token/per-project `daemon.json`. **CLI/TUI:** full-screen Ink/blessed TUI (v2 — S9 ships a `@clack/prompts` menu only); in-process read-only store fallback for `context`/`memory`/`task`; `task` id/slug distinction.
- **Context:** tree-sitter symbol-aware chunking; full `.gitignore` parsing; `trigram` tokenizer; `--watch` full daemon wiring; remote embedding SDK completion; embedding model upgrade.
- **Memory:** graph/temporal-KG; LLM auto-tagging; auto-capture-by-default (opt-in template only today); multi-user/org (v2).
- **Model:** OS keychain; prompt caching; provider-native JSON strict; `onUsage` sink; streaming (forbidden by D5).
- **Toolchain:** `tsconfig.test.json` rollout (9 pkgs); `references/` skill coverage (ClickUp ships one real ref now); engine-naming consistency; `indexer.ts` + `daemon/server.ts` god-file refactors; `biome.json` schema drift; first-run model-download UX; stale-skill-dir cleanup on `noir sync`.

## Slice-X / S10 known refinements (flagged in review, non-blocking)

- ClickUp integration is gated-write-proxy only (read + scoped write); broader CRUD surfaces as real usage demands. The `noir.clickup_write` op vocabulary accepts both short (`status|subtask|comment|batch`) and `task:`-prefixed forms + flat/`payload` input (dual-form, normalized); a future tighten could pick one canonical form.
- The `--host` override on `noir sync` is not written back to `.noir/config.yml` (intentional — the config host is the source of truth; `--host` on sync is an advanced one-shot override).
- `noir skills list` is host-aware: only `claude` and `cursor` have a skills directory; for `gemini`/`opencode`/`agents-md` the context file is the surface.

## Resume recipe

1. `cd` to repo; `/recall noir` → lands on the v1.2.0-beta.1 checkpoint.
2. Read this doc + `docs/roadmap.md` "Current status" + `docs/CHANGELOG.md` §1.2.0-beta.1.
3. Confirm `develop` baseline: `git log --oneline -1` (expect `aa5618a`) and, if desired, `pnpm build && pnpm typecheck && pnpm test` (expect 1089/1089). The published beta is the source of truth — no re-cut needed unless a new slice lands.
4. Pick a next-session goal (above) with the user; follow the dogfooded SDD cadence (brainstorm→spec→plan→subagent-driven implement+review→main-loop validates→opus review→docs/memory checkpoint→local commit).

## Conventions (unchanged)

Skill prefix `noir-`; commits LOCAL on `develop` unless the user explicitly asks to push (the beta is already published — no outward action is pending at session start); per-slice `pnpm build/lint/typecheck/test` gate; `biome check --write` after new files (import-order is error-level); dogfood SDD; graceful degradation; no silent paid calls; adopt ideas, not copies. Sub-agents: Opus (review/judgment) + Sonnet (implementation) only; main loop runs all `pnpm` validation. Keep `docs/roadmap.md` "Current status" + this doc current as slices ship; refresh agentmemory at session end so a fresh `/recall noir` lands on the right checkpoint. Historical point-in-time records (CHANGELOG entries, `docs/decisions/*` ADRs, `docs/specs/*`, `docs/superpowers/specs/*`) are NOT edited retroactively — their old version/test/skill counts are correct-as-history.
