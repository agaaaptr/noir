# Noir — next-session handoff & playbook

> **Status (2026-07-26 overnight session): `1.3.0-beta.7` (install fixes + output design-system) and `1.3.0-beta.8` (idempotent scaffold + conflict contract + semantic dedup) shipped (local on `develop`, NOT yet pushed/tagged — push+tag at session end if all green).** This doc + `docs/CHANGELOG.md` + `docs/roadmap.md` + `docs/superpowers/plans/2026-07-26-overnight-runtime-polish.md` + `/recall noir` = full context.

## Session goal (autonomous, AFK)
Overnight runtime-polish across 6 areas → 3 releases. The 10 locked decisions live in the session-decisions Agent Memory + the plan doc.

## Progress
- ✅ **1.3.0-beta.7 (install + design-system)**: npm-warn (`engines >=22` + `better-sqlite3@13` removes prebuild-install + `boolean` muted + deprecation troubleshooting doc) + output design-system (`theme.ts`, red headers killed, responsive tables, `badge()`, `definitionList()`/`kv()`, NO_COLOR/CLICOLOR_FORCE/NOIR_ACCESSIBLE).
- ✅ **1.3.0-beta.8 (scaffold + conflict + dedup)** (1263 green, was 1181):
  - **Idempotent scaffold**: `noir sync` unchanged-tree true no-op (managed-region content-hash dedup); ancestors seeded every run; `mergeManagedRegions` default TRUE (`--no-merge-regions` escape); bare-init no-op (incl. pre-1.3.0 via `project.id`); hermetic `interactive` flag; latent newline-drift fix.
  - **Universal conflict contract**: 3 bypass producers routed through `buildConflictOpts`+`onConflict` (skills `emitSkillsToDir` w/ `assertNotUserOwned` orphan guard, `workflow/artifacts`, `store/markdown`); colored diff preview (stderr); apply-to-all (regenerate); zdiff3 "merge with markers"; structured `--json` `conflicts[]`.
  - **Write-path semantic dedup**: init/create/sync surface near-dup host files as non-blocking Replace/Mirror/Skip/Create (two-tier, `.noir/dedup-cache.json` hash cache, graceful embedder degradation). The conflict contract's CLI-wiring gap closed.
- ⏳ **1.4.0 (NEXT)**: TUI runtime policy (`--tui/--no-tui/--no-tips`, command matrix, `--json` on read commands, deprecation policy doc, + close the ~5-line `bin.ts` `--json conflicts[]` emit gap from beta.8) · host handoff (`noir handoff`/`wrap` + `hostLaunchDirective` + `emitHandoff` + skill + menu) · Ink `noir tui` MVP (lazy, React 19, hand-rolled widgets).

## Resume recipe
1. `/recall noir` → session-decisions + checkpoint memories.
2. `git -C …/noir log --oneline -10` + `pnpm test` (expect 1263 green at the `chore(release) 1.3.0-beta.8` commit).
3. Continue at the 1.4.0 work in `docs/superpowers/plans/2026-07-26-overnight-runtime-polish.md`.
4. Per release: `node scripts/bump-version.mjs <ver>` + CHANGELOG + roadmap + this doc + memory + `chore(release)` commit. At END (all green): `git tag v1.3.0-beta.7 && git tag v1.3.0-beta.8 && git tag v1.4.0 && git push origin develop --tags`. If `release.yml` `environment: release` approval gates `npm publish`, document it (do NOT bypass lawfully).

## Known considerations (non-blocking)
- Sub-agents **Opus/Sonnet only**.
- `noir doctor` "onnxruntime-node: not resolvable from CLI probe" in the dev workspace = probe/hoisting artifact (context tests pass → dep works); published flattened layout resolves.
- Node `DEP0190` (`shell:true` child-process args) = pre-existing in the doctor native-deps probe; deferred.
- `better-sqlite3@13` may compile from source on the newest Node until prebuilt coverage fills in.
- Residual (~5 lines, landing in 1.4.0): `bin.ts` `--json` doesn't yet emit `init/sync/create` `conflicts[]` to stdout.

## Conventions (unchanged)
Sub-agents Opus (design/review) + Sonnet (implementation) only; main loop runs all `pnpm` validation; commits local on `develop` until the release push; dogfood SDD; graceful degradation; no silent paid calls; adopt ideas, not copies.
