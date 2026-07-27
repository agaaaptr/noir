# Noir — next-session handoff & playbook

> **Status (2026-07-27): the overnight runtime-polish session shipped `1.4.0-beta.1` to `develop` (→ npm `beta`).** The first PUBLISHED version of this work — the intermediate `1.3.0-beta.7` / `1.3.0-beta.8` / `1.4.0` tags failed CI on a `useColor()` leak under `CI=true` (ANSI-wrapped headers broke the responsive-table width test) and were never published; the bug is fixed in `1.4.0-beta.1`. 1315/1315 tests green (verified under `CI=true`). This doc + `docs/CHANGELOG.md` + `docs/roadmap.md` + `docs/superpowers/plans/2026-07-26-overnight-runtime-polish.md` + `/recall noir` = full context.

## What shipped in `1.4.0-beta.1` (all on `develop`)
- **Install + output (from the beta.7/beta.8 work):** `engines >=22` + `better-sqlite3@13` (removes `prebuild-install`) + `boolean` muted + deprecation troubleshooting doc; output design-system (`theme.ts`, red headers killed, responsive tables, `badge()`, `definitionList()`/`kv()`, NO_COLOR/CLICOLOR_FORCE/NOIR_ACCESSIBLE).
- **Scaffold + conflict + dedup:** idempotent scaffold (`noir sync` true no-op, merge-default, hermetic); universal conflict contract (3 producers routed, diff preview, apply-to-all, zdiff3, `--json conflicts[]`); write-path semantic dedup (two-tier, content-hash cache, graceful embedder degradation).
- **Tier C:** TUI runtime policy (`--tui`/`--no-tui`/`--no-tips`, command matrix, deprecation doc); host handoff (`noir handoff`/`wrap` + `hostLaunchDirective` + optional `emitHandoff`); Ink `noir tui` MVP (lazy React 19, `isMainModule` guard preserved).
- **Repo-wide cleanup:** ~627 internal tier/task labels stripped, 3 test files renamed, handoff CWD-path bug fixed.
- **CI color fix:** `useColor()` returns false under `CI=true` (picocolors `isColorSupported` leak that broke the table-width test).

## Next-session candidates
1. **Validate `1.4.0-beta.1` in real projects per host** (`noir init --host gemini|cursor|opencode|agents-md`; exercise `noir tui`, `noir handoff`, the conflict/dedup flow).
2. **Promote to stable `1.x`**: merge `develop`→`main`, tag `v1.4.0` on `main` → CI publishes `--tag latest`. (`latest` still points at `1.0.0-beta.1` until then.)
3. **Richer `noir tui` widgets**: multi-pane layout, scrollback history, in-dashboard conflict resolution (documented as deferred in `docs/command-policy.md`).
4. **Upstream tracking**: bump `@huggingface/transformers` when `transformers.js#1730`/`#1718` ship (removes `boolean` for consumers).
5. **Optional polish**: the `noir doctor` Node `DEP0190` (`shell:true` in the native-deps probe); the onnxruntime-node CLI-probe workspace-hoisting artifact; the 3 unpublished failed tags (`v1.3.0-beta.7`/`beta.8`/`v1.4.0`) can be deleted from the remote if desired (they never published).

## Resume recipe
1. `/recall noir` → session-decisions + checkpoint memories.
2. `git -C …/noir log --oneline -15` + `CI=true pnpm test` (expect 1315 green at the `chore(release) 1.4.0-beta.1` commit).
3. `npx @noir-ai/cli@beta --version` → `1.4.0-beta.1` (smoke the PUBLISHED package).

## Release-process notes
- The `release.yml` `publish` job uses `environment: release` with `required_reviewers`. If a push's npm publish sits behind that approval gate, approve it in the GitHub Actions UI (or remove required reviewers for beta).
- Tags `v1.3.0-beta.7`, `v1.3.0-beta.8`, `v1.4.0` were pushed but their CI FAILED (color bug) — they never published. `v1.4.0-beta.1` (the fix) is the published release. The failed tags are harmless historical markers; delete from the remote if desired.

## Conventions (unchanged)
Sub-agents Opus (design/review) + Sonnet (implementation) only; main loop runs all `pnpm` validation; commits local on `develop` until the release push; dogfood SDD; graceful degradation; no silent paid calls; adopt ideas, not copies. **No internal session/tier labels in code** (a defect this session corrected repo-wide).
