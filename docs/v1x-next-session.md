# Noir — next-session handoff & playbook

> **Status (2026-07-26 overnight session): Tier A shipped as `v1.3.0-beta.7` (local on `develop`, NOT yet pushed/tagged — push+tag at session end if all tiers green).** This doc + `docs/CHANGELOG.md` + `docs/roadmap.md` + `docs/superpowers/plans/2026-07-26-overnight-runtime-polish.md` + `/recall noir` = full context.

## Session goal (autonomous, AFK)
Overnight runtime-polish across 6 areas → 3 tiered releases. The 10 locked decisions live in the session-decisions Agent Memory + the plan doc.

## Progress
- ✅ **Tier A → 1.3.0-beta.7** (committed locally on `develop`; NOT pushed/tagged yet):
  - **A1 npm-warn:** `engines >=22`, `better-sqlite3@13` (prebuild-install gone), `boolean` muted, deprecation troubleshooting doc, all Node-floor refs updated.
  - **A2 output design-system:** `theme.ts`, red headers killed, responsive tables, `badge()`, `definitionList()`/`kv()`, NO_COLOR/CLICOLOR_FORCE/NOIR_ACCESSIBLE, +23 tests. **1181/1181 green** (was 1158).
  - Commits: `docs(plan)` · `fix(deps)` · `docs(install)` · `feat(cli)` output · `chore(release) 1.3.0-beta.7`.
- ⏳ **Tier B → 1.3.0-beta.8** (NEXT): scaffold idempotency (B1) + conflict contract (B2) + write-path semantic dedup (B3).
- ⏳ **Tier C → 1.4.0**: TUI runtime policy (C1) + host handoff `noir handoff` (C2) + Ink `noir tui` MVP (C3).

## Resume recipe
1. `/recall noir` → session-decisions memory + the audit memory.
2. `git -C …/noir log --oneline -8` + `pnpm test` (expect 1181 green at the `chore(release) 1.3.0-beta.7` commit).
3. Continue at the next incomplete tier in `docs/superpowers/plans/2026-07-26-overnight-runtime-polish.md`.
4. Per tier: `node scripts/bump-version.mjs <ver>` + CHANGELOG + roadmap + this doc + memory + `chore(release)` commit. At END (all green): `git tag v1.3.0-beta.7 && git tag v1.3.0-beta.8 && git tag v1.4.0 && git push origin develop --tags`. If `release.yml` `environment: release` approval gates `npm publish`, document it (do NOT bypass lawfully).

## Known considerations (non-blocking)
- Sub-agents **Opus/Sonnet only**.
- `noir doctor` "onnxruntime-node: not resolvable from CLI probe" in the dev workspace = a probe/hoisting artifact (context-engine tests pass → the dep works); the published flattened layout resolves fine.
- Node `DEP0190` (`shell:true` child-process args) = pre-existing in the doctor native-deps probe; deferred.
- `better-sqlite3@13` is brand-new (2026-07-21); on the very newest Node it may compile from source until prebuilt coverage fills in.

## Conventions (unchanged)
Sub-agents Opus (design/review) + Sonnet (implementation) only; main loop runs all `pnpm` validation; commits local on `develop` until the release push; dogfood SDD; graceful degradation; no silent paid calls; adopt ideas, not copies.
