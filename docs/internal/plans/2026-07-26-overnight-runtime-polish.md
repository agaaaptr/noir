# Overnight Session — Runtime Polish, TUI, Idempotency, Handoff (2026-07-26)

> Autonomous AFK session. Branch `develop` @ **1.3.0-beta.6** (1158 tests, 11 packages, typecheck green, **1 pre-existing lint warning**). Sub-agents **Opus/Sonnet only** (user constraint). This doc + `docs/roadmap.md` + `docs/CHANGELOG.md` + `docs/v1x-next-session.md` + `/recall noir` = full recovery context.

## Locked decisions (10-question clarification batch, all answered)

| # | Decision |
|---|---|
| Q1 | `engines.node` `>=20 → >=22` (better-sqlite3 `^12 → ^13`, the N-API rewrite that removes `prebuild-install`; `allowedDeprecatedVersions: { boolean: '*' }`). `>=24` rejected — drops Node 22 LTS for zero benefit; `>=22` covers 22–25 incl. dev's 24.12.0. |
| Q2 | Stay `@huggingface/transformers` 3.x + track upstream (#1730/#1718); `boolean` muted dev-side. |
| Q3 | Bordered 2-col for `noir status`; borderless/dense for high-row-count lists. |
| Q4 ⚑ | **Adopt Ink now** — lazy, scoped to a `noir tui` subcommand (main CLI stays commander + @clack). React 19, hand-rolled widgets (@inkjs/ui & ink-ui stale). |
| Q5 | Flip `noir sync` to **merge-default** after ancestor seeding; `--no-merge-regions` escape. |
| Q6 | Semantic-dedup **always-on** in write path + content-hash gate; two-tier (≥0.95 action, 0.85–0.95 info). |
| Q7 | `noir handoff` → STDOUT + optional `--write` (`.noir/handoff/<id>.md`, gitignored). |
| Q8 | Bounded seed extraction (`context_search` + `memory_recall`) + MCP tool references. |
| Q9 ⚑ | **Split per tier for release, but execute as ONE session — ZERO leftover task/debt.** |
| Q10 | `engines` bump ships as **minor 1.4.0** + prominent changelog note. |

## Root causes (from the 11-agent investigation — load-bearing facts)
- **Red headers** = cli-table3 default `style.head:['red']` unoverridden in `packages/cli/src/output.ts:157-172`.
- **Multi-region merge IS shipped** (SP-H) — the stale comment at `packages/create/src/scaffold.ts:85-91` is **wrong** (audit contradiction resolved).
- **"noir init duplicates" perception** = `managedBlock` has no content-hash dedup → `noir sync` re-writes unchanged files (git churn), not real file duplication.
- **3 file producers bypass the conflict contract**: `workflow/artifacts.ts`, `skills/compiler.ts` (rm-rf orphan cleanup, no per-file guard), `store/markdown.ts`.
- **No on-demand host-handoff artifact** — transfer is 100% passive today.
- **"TUI" today** = a one-shot `@clack` menu (`home.ts:73-132`), not a runtime.

## Tiers

### Tier A → `1.3.0-beta.7` (consumer-facing, low-risk)
- **A1 npm-warn:** Node `>=22` across all 11 packages; better-sqlite3 `^13` in `@noir-ai/store`; `allowedDeprecatedVersions` in `pnpm-workspace.yaml`; troubleshooting doc (`boolean` upstream-tracked; `python` = user `.npmrc`).
- **A2 Output design-system:** new `packages/cli/src/theme.ts` (picocolors palette + `badge()` + `terminalWidth()`); rewrite `output.ts table()` (kill red header via picocolors **functions**, responsive `colWidths`, wordWrap+truncate, TTY gate); add `definitionList()`/`kv()`; refactor status/doctor/skills/task/memory/context; honor `NO_COLOR`/`CLICOLOR_FORCE`/`NOIR_ACCESSIBLE`; update snapshot tests.
  - *Acceptance:* no red headers; tables wrap at 60/80/120 cols; badge always = symbol+text+color; `--json` byte-identical; `pnpm why prebuild-install` empty; `pnpm install` 0 deprecation warns; `engines>=22` everywhere; tests green.

### Tier B → `1.3.0-beta.8` (structural, internal)
- **B1 Scaffold idempotency:** fix stale comment `scaffold.ts:85-91`; seed `.noir/ancestors.json` on every init/create/sync; extend content-hash `identical` tier from `regenerate` → `managedBlock(s)`; hermetic `interactive` flag in `ScaffoldOptions` (drop `process.env` side-channel); widen no-op guard to "scaffold-version OR project.id"; standardize 3-class artifact taxonomy (managed/runtime · co-owned · seed) across all file-writing paths.
- **B2 Conflict contract:** route `skills/compiler emitSkillsToDir` (+ `assertNotUserOwned` guard on the rm-rf orphan cleanup), `workflow/artifacts.ts`, `store/markdown.ts` through `buildConflictOpts + onConflict`; unified-diff preview (picocolors green/red → stderr) before `@clack.select`; apply-to-all scoped to artifact class; promote `mergeThreeWay` to **default** for single-region managed blocks (after ancestor seeding) + `--no-merge-regions`; 6th option "merge (with conflict markers)" (zdiff3); refresh stale NOTE `conflict.ts:26-31`.
- **B3 Write-path semantic dedup:** wire `findSemanticDuplicates` into init/create/sync write path as a non-blocking `@clack` hint; content-hash gate; two-tier threshold; structured `conflicts[]` in `--json`.
  - *Acceptance:* zero raw `writeFileSync` to generated artifacts outside the contract; diff preview shown; apply-to-all reduces N-prompt upgrade to 1; `noir sync` on unchanged tree writes nothing; `AGENTS.md ≈ CLAUDE.md` surfaces a hint; skills/compiler never rm-rf's without a guard.

### Tier C → `1.4.0` (features, minor)
- **C1 TUI policy:** `--tui/--no-tui` (default auto = `isInteractive`) + `--no-tips` global flags; bare `noir` = documented primary UX; classify every command "both-modes" vs "interactive-only" + publish matrix; `--json` on every read-side subcommand; formal deprecation policy doc (warn → redirect → never-silently-remove, zero entries). Approach B (TUI-primary, **never hard-gate**). Preserve `home(opts,deps)` signature + `isMainModule` realpath guard.
- **C2 Host handoff:** new `noir handoff` (sibling `noir wrap`) → structured markdown to STDOUT (Task/Phase/Next gate/Extracted context/Open-host directive); optional `--write`; refactor `home.ts hostDirection` → `@noir-ai/adapters hostLaunchDirective(host)` (text-only, no spawn); optional `emitHandoff?(ctx,payload)` on `HostAdapter`; deepen `noir-wrap` stub; surface (not auto-emit) at execute→verify + Home action. Never write into `CLAUDE.md`/`AGENTS.md`.
- **C3 Ink `noir tui` MVP** (stretch): Ink as **lazy** dep scoped to `noir tui`; MVP = status bar (host/mode/task-phase/daemon) + command input (`/`/`@`/`!`) + output pane + goal/context header + footer shortcuts; hand-rolled widgets; `react@>=19.2`; main CLI byte-identical; `ink-testing-library` coverage. **MVP must be complete+tested (zero debt); richer widgets documented as roadmap.**
  - *Acceptance:* bare `noir` + isInteractive opens TUI; `--json` byte-identical; `--no-tips` clean in CI; no command hard-gated; `noir handoff` emits pasteable block (+ `--write` gitignored); host-aware directive; daemon-down degrades gracefully; `noir tui` renders the MVP panes with tests.

## Execution + gates
Each tier: **spec → sub-agent impl (Opus design / Sonnet mechanical) → main-loop validate (`pnpm -r typecheck` + `pnpm lint` + `pnpm test`; reproduce in the testing project where relevant) → checkpoint → release (bump + tag if green).** Single-session, zero-debt: complete each tier fully before the next.

Testing project (ground truth, read-only during discovery): `/Users/agaaaptr/Documents/Work/BSI/Project/Back-end/Akademik - Akad/UIIAkademik/svc-academic-activity-go` @ `experiment/ai-dev-workflow` (host claude, mode full, store live, `.noir/` untracked).

## Checkpoint protocol (per tier)
Update `docs/roadmap.md` (current status) · `docs/CHANGELOG.md` · `docs/v1x-next-session.md` · Agent Memory (`memory_save`) · **local commit on `develop`**.

## Release
`1.3.0-beta.7` (Tier A) → `1.3.0-beta.8` (Tier B) → `1.4.0` (Tier C). **Push `develop` + tag at the very end, only if all targets met + validation green.** `release.yml` `publish` job uses `environment: release` with `required_reviewers` — if it gates npm publish, **document** the blocked publish (do NOT bypass lawfully). Deprecate-never-delete.

## Resume recipe
1. `/recall noir` → lands the session-decisions memory + this plan.
2. `git -C …/noir log --oneline -8` + `pnpm test` → confirm tier boundary.
3. Continue at the next incomplete tier in this doc.
