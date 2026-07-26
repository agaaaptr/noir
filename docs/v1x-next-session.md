# Noir — next-session handoff & playbook

> **Status (2026-07-27): session work COMPLETE — 15 commits on `develop`, 1315/1315 tests green (full gate: typecheck + lint + build + symlink-guard smoke), tags `v1.3.0-beta.7` / `v1.3.0-beta.8` / `v1.4.0` created LOCALLY. The outward push (`develop` + the 3 tags) was BLOCKED by the Claude auto-mode guardrail (don't-push-without-asking + npm-publish implication) and is PENDING the user. npm publish is additionally gated by the GitHub `release` environment (required reviewers). See "Push status (blocked)" below.** This doc + `docs/CHANGELOG.md` + `docs/roadmap.md` + `docs/superpowers/plans/2026-07-26-overnight-runtime-polish.md` + `/recall noir` = full context.

## Push status (blocked — pending user)
The Claude session was not permitted to push to the public remote or push release tags (guardrail: out-of-place publication). To ship, run from a terminal (or via `!` in the Claude prompt):
```bash
cd /Users/agaaaptr/Documents/Personal/Project/AI/noir
git push origin develop
git push origin v1.3.0-beta.7 v1.3.0-beta.8 v1.4.0
```
Each tag triggers `release.yml` → publishes to the `beta` dist-tag (channel derived from the branch holding the tag; all three are on `develop` → `beta`). The `publish` job uses `environment: release` with required reviewers — **approve it in the GitHub Actions UI** (or remove required reviewers for beta). After publish, verify: `npm view @noir-ai/cli dist-tags` (expect `beta` → `1.4.0`) and `npx @noir-ai/cli@beta --version` → `1.4.0`. `latest`/stable stays at `1.0.0-beta.1` until you merge `develop`→`main` and tag `v1.4.0` on `main`.
- Note: `v1.3.0-beta.7` / `v1.3.0-beta.8` were tagged at their natural commits (15s test timeout); `v1.4.0` is tagged at `f38513d` which includes the 40s testTimeout fix, so its CI test gate is reliable. If a beta.7/beta.8 CI doctor test times out, re-run it (the tests pass in isolation).

## What shipped this session (all on `develop`)
- **1.3.0-beta.7** — npm-warn fix (`engines >=22` + `better-sqlite3@13` removes `prebuild-install`; `boolean` muted; deprecation troubleshooting doc) + output design-system (`theme.ts`, red headers killed, responsive tables, `badge()`, `definitionList()`/`kv()`, NO_COLOR/CLICOLOR_FORCE/NOIR_ACCESSIBLE).
- **1.3.0-beta.8** — idempotent scaffold (`noir sync` true no-op; `mergeManagedRegions` default TRUE; bare-init no-op; hermetic) + universal conflict contract (3 producers routed; diff preview; apply-to-all; zdiff3; structured `--json` `conflicts[]`) + write-path semantic dedup (two-tier, content-hash cache, graceful embedder degradation).
- **1.4.0** — TUI runtime policy (`--tui`/`--no-tui`/`--no-tips`, command matrix, deprecation doc) + host handoff (`noir handoff`/`wrap` + `hostLaunchDirective` + optional `emitHandoff` + `noir-wrap` skill) + Ink `noir tui` MVP (lazy React 19, `isMainModule` guard preserved) + repo-wide cleanup (~627 internal labels stripped, 3 test files renamed, handoff path bug fixed).

## Next-session candidates
1. **Validate `1.4.0` in real projects per host** (`noir init --host gemini|cursor|opencode|agents-md`; exercise `noir tui`, `noir handoff`, the conflict/dedup flow).
2. **Promote to stable `1.x`**: merge `develop`→`main`, tag `v1.4.0` on `main` → CI publishes `--tag latest`. (`latest` still points at `1.0.0-beta.1` until then.)
3. **Richer `noir tui` widgets**: multi-pane layout, scrollback history, in-dashboard conflict resolution (documented as deferred in `docs/command-policy.md`).
4. **Upstream tracking**: bump `@huggingface/transformers` when `transformers.js#1730`/`#1718` ship (removes `boolean` for consumers).
5. **Optional polish**: the `noir doctor` Node `DEP0190` (`shell:true` in the native-deps probe); the onnxruntime-node CLI-probe workspace-hoisting artifact.

## Resume recipe
1. `/recall noir` → session-decisions + checkpoint memories.
2. `git -C …/noir log --oneline -15` + `pnpm test` (expect 1315 green at the `chore(release) 1.4.0` commit).
3. `npx @noir-ai/cli@beta --version` → `1.4.0` (smoke the PUBLISHED package, not just `node bin.js`).

## Release-process notes
- The `release.yml` `publish` job uses `environment: release` with `required_reviewers`. If the overnight push's npm publishes sat behind that approval gate, approve them in the GitHub Actions UI (or remove required reviewers for beta).
- Tags `v1.3.0-beta.7`, `v1.3.0-beta.8`, `v1.4.0` were created on `develop` (→ `beta` dist-tag). To promote `1.4.0` to `latest`, tag `v1.4.0` on `main` after merging.

## Conventions (unchanged)
Sub-agents Opus (design/review) + Sonnet (implementation) only; main loop runs all `pnpm` validation; commits local on `develop` until the release push; dogfood SDD; graceful degradation; no silent paid calls; adopt ideas, not copies. **No internal session/tier labels in code** (a defect this session corrected repo-wide).
