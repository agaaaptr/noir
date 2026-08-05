# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Noir** is a host-agnostic, spec-driven-workflow + native-context + cross-session-memory **layer** for agentic CLIs — *not* an LLM runtime (bring your own agent). It makes an agentic CLI behave like a disciplined spec-driven engineer: escapable spec→plan→implement→verify lifecycle, hybrid retrieval so the host queries snippets instead of re-reading files, and typed cross-session memory.

- **11 packages** in a pnpm monorepo: `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory,create}`.
- **Host-agnostic**: 5 adapters (`claude` default, `agents-md`, `gemini`, `cursor`, `opencode`) via `resolveAdapter(host)`; universal `AGENTS.md` emitter. `claude` is the regression anchor — bare `noir init` is byte-identical.
- **No plugin / marketplace**: ships only native `noir-` builtin skills (+ opt-in integrations like `noir-clickup`). The predecessor `noir-workflow` plugin was removed (see ADR-0002).
- **Local-first**: embedded SQLite store (`better-sqlite3` + FTS5 + `sqlite-vec`), local 384-dim embeddings by default, zero API key required.

## Commands

```bash
pnpm install            # frozen-lockfile in CI
pnpm build              # tsup build all 11 packages (ESM + dts)
pnpm typecheck          # tsc across packages
pnpm lint               # biome check .  (use pnpm format to autofix)
pnpm test               # build + vitest run (offline/free — never needs network or a key)
pnpm docs:validate      # broken links + stale version refs + registry integrity
pnpm docs:generate      # regenerate managed docs blocks + reference docs
```

Run a single test file:

```bash
pnpm vitest run packages/store/test/readonly.test.ts --testTimeout=40000
```

The full gate (what CI enforces, in order): `pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm docs:validate`. **Do not claim a change is done until all five are green.**

## Architecture (big picture)

The core flow: the **CLI** (`@noir-ai/cli`) is the shell entry point → it talks to the **daemon** (`@noir-ai/daemon`) over MCP (stdio or Streamable HTTP) → the daemon owns the **store** (`@noir-ai/store`, single-writer, `ProjectId`-keyed at `.noir/store/<projectId>.db`) → the **workflow** engine (`@noir-ai/workflow`) runs the SDD FSM with observable gates → **context** (`@noir-ai/context`) and **memory** (`@noir-ai/memory`) layer hybrid retrieval (BM25 ∪ kNN → RRF) on top of the store → the optional **model** (`@noir-ai/model`) is a single-shot, provider-explicit completion library (agent loops impossible by construction).

Key invariants to respect:

- **The daemon is the single writer.** Store-touching CLI commands are MCP clients to it (`ensureDaemonRunning` + `@modelcontextprotocol/client`). Never open the store for writes from two processes.
- **`.noir/` is the single source of truth**, keyed by canonical `ProjectId` (never a filesystem path). Generated host artifacts are pointers/transforms, never drifting copies.
- **No silent paid calls.** The model layer resolves the provider ONLY from explicit config (`req.provider || cfg.defaultProvider`), never from env-var presence. No provider/key ⇒ `null`/`{ok:false}` before an SDK client is built. Memory consolidation is gated on `memory.consolidation.enabled` and refuses cleanly without a provider.
- **Agent loops are impossible by construction** — the model request type has no `tools`/`stream` parameter. Tool use lives in the host CLI, not in Noir's model.
- **Provider-explicit + local-first** — remote embedders and model calls are opt-in, never default.

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), **commit per scope** (`feat(skills): …`), scope per package.
- **Keep commits local** — push only on explicit user request. Commits stay on `develop` until told otherwise.
- **Test suite runs offline/free** — never add a test that needs a network call or paid key.
- **Docs reflect shipped reality** — when code changes, update the relevant `docs/` at the same checkpoint. No documentation drift.
- **Spec-first for large changes** — brainstorm → spec → plan → implement → review (dogfooded SDD). Specs/plans live in `docs/internal/{specs,plans}`; ADRs in `docs/decisions/`.

## Developer vs agent guidance

- **[`AGENTS.md`](AGENTS.md)** is the authoritative operational manual for developing Noir: toolchain contract, adding a package, the native-skills mechanism, privacy rules, commit discipline. **Read it for any code contribution.**
- **`docs/roadmap/`** is the single source of truth for direction (capability index, status, releases, backlog).
- **Project skills** in `.claude/skills/`: load **session-starter** at the start of a session (global project context: roadmap + memory + knowledge base), and **task-starter** before a task (task-level context). These use the mature plugins (agentmemory, context-mode) as references; Noir itself is not yet initialized in this repo.

## Do not

- Don't reintroduce a plugin / marketplace / `noir-workflow` surface (removed deliberately, ADR-0002).
- Don't commit secrets (API keys, npm tokens) or `.superpowers/` (local session scratch; gitignored).
- Don't push to `main` without explicit go-ahead.
- Don't require `noir init` to have been run in this repo — Noir is not yet mature/initialized here; the plugin stack (agentmemory, context-mode, superpowers) is the current context layer.

## Patch release flow (beta → stable)

Noir ships two channels in parallel from git tags: `vX.Y.Z-beta.N` (pushed on `develop` → npm `beta` dist-tag) and `vX.Y.Z` (pushed on `main` → npm `latest` dist-tag). The same `.github/workflows/release.yml` runs both; the channel is detected from the tag name pattern, not the branch. The `release` GitHub Environment has a **required reviewer = agaaaptr** — every tag push pauses the `publish` job waiting for manual approval in the GitHub Actions UI (Claude cannot approve it).

### Prerequisites
- `gh` authenticated, npm logged in (granular automation token), `NPM_TOKEN` GitHub secret set.
- Local tree clean, on `develop`, HEAD pushed to origin.
- Full gate green: `pnpm lint → build → typecheck → test → docs:validate`.
- `pnpm release:compute <version> beta` and `pnpm release:compute <version> stable` to confirm no version collision on npm.

### Full checklist (run each command — do not skip)

```bash
# 1. BUMP version + update CHANGELOG + docs (roadmap/releases/STATUS/backlog/manifest)
node scripts/bump-version.mjs X.Y.Z    # bump all 11 packages
# Edit CHANGELOG.md: add X.Y.Z section at top
# Edit docs/roadmap/releases.md: update current-status block + release sequence
# Edit docs/roadmap/STATUS.md: update sprint entries + next milestone
# Edit docs/roadmap/backlog.md: update history of resolutions
# Edit docs/roadmap/roadmap.manifest.yaml: update package note

# 2. GATE + COMMIT + PUSH
pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate
git add -A && git commit -m "chore(release): vX.Y.Z + docs sync"
git push origin develop

# 3. WAIT FOR CI (develop push → ci.yml must go green)
gh run list --branch develop --limit 1  # wait: completed success

# 4. BETA TAG → TRIGGERS release.yml → USER MUST APPROVE publish job
pnpm release:tag    # creates vX.Y.Z-beta.1 (auto-computes beta number from npm)
git push origin vX.Y.Z-beta.1
# Open GitHub Actions → approve "Review deployments → Approve and deploy"
# Wait: completed success → verify: npm view @noir-ai/cli dist-tags beta = X.Y.Z-beta.1

# 5. MERGE develop → main + PUSH
git checkout develop && git pull --ff-only   # CI pushes registry back
git checkout main && git merge --ff-only develop && git push origin main

# 6. WAIT FOR CI (main push → ci.yml must go green)

# 7. STABLE TAG → TRIGGERS release.yml → USER MUST APPROVE again
pnpm release:tag    # creates vX.Y.Z (plain, no suffix)
git push origin vX.Y.Z
# Approve → wait → verify: npm view @noir-ai/cli dist-tags latest = X.Y.Z

# 8. BUMP Homebrew + Scoop then SYNC branches
# Edit packaging/homebrew/noir.rb: url/sha256/version from npm
# Edit packaging/scoop/noir.json: version/url/hash from npm
git checkout main && git pull --ff-only   # CI pushes registry back
git add packaging/ && git commit -m "chore(dist): bump Homebrew + Scoop to X.Y.Z"
git push origin main
git checkout develop && git merge --ff-only main && git push origin develop
# Verify: git ls-remote origin develop main → both same SHA
```

### Key invariants
- **Never skip beta.** The beta channel is the gate before stable — it verifies the publish pipeline + npm provenance + all 11 packages land on `beta` correctly before touching `latest`.
- **Never tag from a dirty or unpushed tree.** `pnpm release:tag` enforces this (clean + pushed-to-origin checks).
- **Never reuse or move a tag.** npm versions are immutable. If a release is bad, deprecate and ship a patch.
- **Docs sync with every patch.** CHANGELOG, releases.md, STATUS.md, backlog.md, and manifest.yaml must reflect shipped reality — no documentation drift.
- **Both branches end at the same SHA.** After the Homebrew+Scoop bump + sync, `develop` and `main` must be identical.
- **All 11 packages move together.** One version, one tag, one release.
