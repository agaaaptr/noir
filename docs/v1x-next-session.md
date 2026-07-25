# Noir v1.x — next-session handoff & playbook

> Generated 2026-07-25. **Status: 4/6 v1.x capability slices DONE on `develop` (local, NOT pushed).** This doc + `docs/specs/2026-07-25-v1x-capabilities-design.md` + the per-slice specs + `/recall noir` = full context for the next session.

## Status snapshot

| Slice | Status | Where |
|---|---|---|
| **K** Keystone (markers factory + blockWriter + emitRules) | ✅ done + verified | `docs/superpowers/specs/2026-07-25-keystone-k-design.md` |
| **R** Rules (`.noir/rules/RULES.md` seed + wired + `noir-rules`) | ✅ done + verified | commits `8f325d4`, `c5c2f0f` |
| **I** Ignore (IgnoreManager + syncIgnores into init/sync) | ✅ done + verified | commit `ad536c0` |
| **P** PRD (`prd` artifact + writePrd/readPrd + `noir-prd`) | ✅ done + verified | commit `6afe193` |
| **S** Scaffold (new `@noir-ai/create` + three-mode writer + `noir create`) | ⏳ NOT started | `docs/superpowers/specs/2026-07-25-slice-s-scaffold-design.md` |
| **X** Integration (ClickUp + gated-write-proxy + integrations_auth) | ⏳ NOT started | `docs/superpowers/specs/2026-07-25-slice-x-integration-design.md` |

- **`develop`: 746 tests green** (K/R/I/P added; range `4493783..6afe193`, 12 commits, LOCAL — not pushed). lint green, typecheck green.
- **`main` / npm beta: 729 tests** (`v1.0.0-beta.1` published). Stable 1.0.0 not yet cut.
- Builtin pack now **33** (added `noir-rules`, `noir-prd`).

## Built this session — one-line each
- **K:** `managedBlock(name,commentStyle)` factory + `CONTEXT_BLOCK`/`RULES_BLOCK` named instances (`core/markers.ts`); shared `blockWriter` (`writeManagedRegion`/`readManagedBlock`/`stripManagedBlock`/`commentStyleFor`, `core/block-writer.ts`); `cli/init.ts` refactored to use it; `HostAdapter.emitRules?` seam + claude impl. Pure refactor.
- **R:** `.noir/rules/RULES.md` Noir-curated seed (`cli/rules-seed.ts`) written at init (skip_if_exists); wired into `CLAUDE.md` via `RULES_BLOCK` managed block; `sync.ts` reconciles context+rules+ignore+skills; `noir-rules` skill.
- **I:** `IgnoreManager` (`core/ignore-manager.ts`, `IGNORE_BLOCK=managedBlock('ignore','hash')`, registry for `.gitignore`/`.dockerignore`/`.npmignore`/`.prettierignore`) + `syncIgnores` hooked into init+sync. Idempotent.
- **P:** `prd` artifact kind (`layout.prdDir/prdFile` + workflow `writePrd`/`readPrd`) + `noir-prd` skill. **No FSM change.** Explicit opt-in.

## Next-session goal (per user)
1. **Load full context** — this doc + `/recall noir` + `docs/specs/2026-07-25-v1x-capabilities-design.md` + the S/X specs.
2. **Ask ALL clarification questions in ONE discussion** (S-OQ1-3, X-OQ1-4, + debt-fix decisions below).
3. **Write a systematic plan for ALL remaining tasks** (S + X + technical-debt fixes).
4. **Execute via sub-driven agents (opus/sonnet only).**
5. **After success → push + commit on `develop`, tag for npm publish** (see checklist).
6. **Verdaccio** — decide (see §Verdaccio; recommendation: skip).

## Technical debt — FULL list (fix next session)

> Canonical source: `docs/roadmap.md` §"v1.x backlog". This is the consolidated fix list.

### A. Pre-existing v1.0-beta debt (roadmap §v1.x backlog)
- **Daemon:** backgrounded/detached + socket-activation; auth token; per-project `daemon.json` (today global `~/.noir/daemon.json` clobbers).
- **CLI/TUI:** full-screen Ink/blessed TUI; in-process read-only store fallback for `context`/`memory`/`task`; `task` id/slug distinction.
- **Workflow:** S4 dual source of truth (`task.history` vs `audit:<id>` KV — collapse to one); S4 checkpoint save/restore vestigial (wire or remove).
- **Context:** tree-sitter symbol-aware chunking; full `.gitignore` parsing (static denylist today); `trigram` tokenizer; kNN-only-hit snippet hydration; `--watch` full wiring; remote embedding SDK completion; embedding model upgrade (`bge-small-en-v1.5`).
- **Memory:** graph/temporal-KG; LLM auto-tagging; auto-capture-by-default; multi-user/org scoping.
- **Model:** OS keychain for secrets; prompt caching; provider-native JSON strict; `onUsage` sink; streaming.
- **Toolchain:** `tsconfig.test.json` (test/ not statically typechecked); `references/` skill coverage; engine naming consistency; god-file refactors (`indexer.ts`, `daemon/server.ts`); stale-skill-dir cleanup on `noir sync`; `biome.json` schema drift; first-run model-download UX.
- **S10:** host adapters (gemini/agy/opencode/qwen) + adapter registry (`resolveAdapter`) + widen `host` config + `CompileTarget`.
- **S11 remainder:** framework/SDK docs; `noir doctor` publish checks.

### B. NEW deferred items (this session, K/R/I/P)
- **K3:** skills-compiler generalization → **lands in X** (`discoverIntegrations` etc.).
- **R4:** config `rules:` block (`{enabled, lengthBudgetKb}`).
- **R5:** `noir doctor` RULES.md budget check (≤6 KB).
- **P3:** `@noir-ai/model` `draftPrd(intake, clarify, memory)` (offline → template).
- **P4:** config `prd:` block (`mandatoryFor:[feature,epic]`) + `advance()` soft gate predicate (feature/epic entering spec with no PRD → remind; escapable).
- **Lint:** 10 warnings remain (`noCommaOperator`/`noNonNullAssertion` in `cli/test/*` — pre-existing, non-auto-fixable, cosmetic, not in CI). ⚠️ Note: `pnpm lint` was RED on the develop baseline before this session (pre-existing v1.0-beta `useOptionalChain`/`useLiteralKeys`); now GREEN via `biome --write --unsafe` (committed).

### C. Verify-live (X execution only — not blockers)
- ClickUp `GET /list/{id}` `statuses` field; tag auto-create behavior.

## Push / tag / publish checklist (next session, after S+X + debt-fixes done)
1. `pnpm build && pnpm lint && pnpm typecheck && pnpm test` → all green.
2. **Decide version** (clarify): `v1.1.0-beta.1` (v1.x capabilities) OR promote to stable `v1.0.0` first (merge develop→main)?
3. `node scripts/bump-version.mjs <ver>` (unified versioning across 10 pkgs).
4. Commit on develop: `chore(release): <ver>`.
5. Push develop: `git push origin develop`.
6. Tag: `git tag v<ver> && git push origin v<ver>` → `release.yml` derives dist-tag from which branch holds the tag.
7. (Stable 1.0.0 path: merge `develop`→`main`, tag `v1.0.0` on `main` → CI publishes `--tag latest`.)

## Verdaccio

**Is it necessary? — No, not for Noir's current stage.** Verdaccio (self-hosted npm registry) is for: private distribution, **local staging to test the publish+install flow before a real npm release**, air-gapped/offline, or a caching proxy. Noir is already published to public npmjs (`v1.0.0-beta.1`) with a working `release.yml`. Verdaccio is **overkill** unless you want repeatable local publish-testing.

**Recommendation: skip it.** To validate a release locally without a registry, use `npm pack` + `npm install <tarball>` (or `pnpm pack`). Verdaccio is worth setting up only if you need a private registry for unreleased work OR repeatable publish CI tests.

**How (if you still want it):**
1. Run Verdaccio: `docker run -d -p 4873:4873 verdaccio/verdaccio` (or `npm i -g verdaccio && verdaccio`).
2. Create a user: `npm adduser --registry http://localhost:4873`.
3. Publish target — pick one: per-publish `npm publish --registry http://localhost:4873` · OR `publishConfig.registry` in each `package.json` · OR `.npmrc` with `@noir-ai:registry=http://localhost:4873`.
4. For Noir's `release.yml`: add a `NPM_REGISTRY` env (default npmjs) so CI can target Verdaccio when set, OR a separate `release:verdaccio` workflow.
5. Install from it: `.npmrc` `@noir-ai:registry=http://localhost:4873` then `npx @noir-ai/cli@beta init`.

## Resume recipe (next session)
1. `cd` to repo; `/recall noir` → lands on the v1.x execution checkpoint.
2. Read this doc + the S/X specs + `docs/specs/2026-07-25-v1x-capabilities-design.md`.
3. Confirm `develop` is at `6afe193` (746 tests green) via `git log --oneline -1 && pnpm test`.
4. Run the clarify→plan→subagent-execute→push/tag workflow above.
5. Conventions: commits LOCAL on develop until push asked; per-slice `pnpm build/lint/typecheck/test` gate; `biome check --write` after new files (import-order is error-level); dogfood SDD.
