# Changelog

## 1.11.2 (2026-08-14) — TUI fix + polish

### Fixed
- **OOM crash** — two root causes: (1) `process.env.NODE_ENV` is now forced to `production` before the lazy TUI load, so react-reconciler's DEV build (which calls `performance.measure()` on every render, filling Node's 1M-entry performance buffer) is no longer selected; (2) `useInputBuffer`'s returned functions are now `useCallback`-stable, so the `seed`-in-a-`useEffect`-dep anti-pattern no longer causes an infinite re-render loop. Both previously OOM'd `noir tui` after a minute of typing or idle.
- **`noir run` variadic prompt** — a multi-word prompt was parsed as empty ("a prompt is required") because commander delivers `[prompt...]` as a nested array; the `run` action now reads the joined positional args off the trailing `Command`.
- **Conflict "apply to all" for skills** — the resolver now offers the "apply this choice to all remaining conflicts" prompt for the `skill` emit path (previously only `regenerate`), so a `noir sync` re-emitting N divergent skills prompts once instead of per-file.

### Changed
- **Palette redesign** — two-column layout (bold label + dim `/argv` hint), reverse-video active row, the full command description shown as a `↳` detail line on the active row (word-wrapped, never ellipsis-truncated), and blank spacers between sections for scannability.
- **Snapshot polling** — added an in-flight guard (no concurrent `gatherStatusPayload` stacking on a slow daemon) and kept the last-good payload on a transient probe failure (no more flapping to "down").

---

## 1.11.0 (2026-08-14) — v2 orchestrator TUI: single-surface consolidation + headless host-driving

### Added
- **Single command surface (v2 TUI consolidation)** — the `home` quick-action menu (`h`), the static `?` help, and the `Ctrl+F` output search are collapsed into ONE corpus-aware command palette (`Ctrl+K`). The palette now has three corpora switched with `Tab`: `commands` (all leaf commands + curated quick-actions + recents), `output` (find-in-output), and `help` (keybindings). `h`/`?`/`Ctrl+F` open the same surface at the relevant corpus. The `Mode` union collapses to `dashboard | palette{corpus} | confirm`; keyboard routing is unified in the App's single `useInput` (the palette is now presentational). Shared hint copy lives in `tui/hints.ts` (one source for the footer + palette + help corpus).
- **`noir run <prompt>`** — the v2 orchestrator (Archetype B): drive the host CLI headless and render its `stream-json` (`claude -p --output-format stream-json --verbose` by default). `--host <id>` selects the host; `--command <binary>` overrides the per-host binary so users with multiple profiles (`claude` vs `claude-work`) can point at their own. Reports token/cost from the `result` event (labeled "API-equivalent estimate, not billed") and persists a raw stream-json transcript to `.noir/transcripts/`. Scriptable under `--json`. See ADR-0008.
- **Token/cost reducer** — `UsageReducer` (`packages/cli/src/orchestrator.ts`) accumulates usage with the `max per message.id` dedup rule (Claude emits one cumulative JSONL line per content block; summing over-counts ~2.5-3x). Pure + unit-tested.
- **Update-available notice** — the bare-`noir` home menu now advertises a newer cached version with install-type-specific advice (`brew upgrade noir`, `scoop update noir`, `npm install -g @noir-ai/cli@latest`, or `noir update` for native). Semver downgrade-guarded; reads the cached latest (the async startup check refreshes it).

### Changed
- **Unified recents** — shell recall (`↑`/`↓` on `/`) and the palette recents now share ONE persisted source (`tui-history.json`); `useInputBuffer` gained `seed()` and move-to-front dedup, so a command run via the palette appears in shell recall and vice-versa.
- **Destructive confirm covers all paths** — a destructive typed `/command` (e.g. `/sync`) now routes through the same `y/N` confirm gate as palette selections (previously the typed path bypassed it).
- Removed dead `HomeSection.key` (legacy `selectKey` digit) and the stale `['context','forget']` destructive prefix.

### Fixed
- `noir doctor` install row already surfaced "update available"; the home menu now does too (see Added).

## 1.10.1 (2026-08-13) — C3 generated-artifact standard

### Added
- **Generated-artifact standard** — a single naming/frontmatter/outline contract for every `.noir/` file a C3 skill generates. New `ARTIFACT_TYPES` registry (`packages/core/src/artifacts.ts`) is the single source of truth; filenames follow `<CODE>-<NNNN>-<taskId>-<slug>.md` with a 12-kind type-code registry (`TS`/`SP`/`PL`/`PRD`/`AN`/`ADR`/`BG`/`BR`/`RP`/`CL`/`IN`/`HO`) and a per-type monotonic `NNNN` (scan-based `max+1`, reuse-on-rewrite). Reference: `docs/reference/artifact-format.md`; decision: ADR-0007.
- **Canonical frontmatter** — `kind`/`id`/`slug`/`title`/`status`/`date`/`generated_by`/`generated_at` (+ optional `version`/`author`/`tags`/`related`/`supersedes`/`source`/`checksum`). The decision stub now writes `ADR-<NNNN>-<slug>.md` with `status: proposed` + the Nygard Context/Decision/Consequences shape (replacing the `<!-- Status: pending -->` comment).
- **Per-type outlines** — full for SPEC/PLAN/TASK/ANALYSIS/ADR; PRD reconciled to the richer 9-section `draftPrd` canon (`noir-prd` now lists the same 9); light outlines for bug/brief/report/handoff/intake/clarification.
- **Quality-gate enforcement** — `artifactPathDrift()` (hard error via `validateSkill`) cross-checks every `.noir/<dir>/<name>` a skill prescribes against the registry; `layout.ts` gains `analysis`/`bugs`/`subagents` dirs.

### Changed
- `writeIntake`/`writeSpec`/`writePrd`/`writePlan`/`writeTask`/`writeClarifications` resolve paths via `resolveArtifactPath` (reuse-or-allocate) and emit the canonical frontmatter.
- `noir handoff --write` persists to `.noir/handoff/HO-<NNNN>-<id>.md`.
- `noir task advance → done` numbers decision records via `nextArtifactSequence(root, 'adr')`.

### Fixed
- **Naming drift** across 4 skills (`noir-planning` `<date>`, `noir-subagent` `.noir/sdd/`, `noir-spec`/`noir-prd` `<id>`) — now caught mechanically by the gate.
- **Stale docs** — `sdd-workflow.md` described a nested `.noir/tasks/<id>-<slug>/` layout that never existed; corrected to the flat per-type layout.

## 1.10.0 (2026-08-11) — C4 end-to-end AI development workflow

### Added
- **Surface wiring (c4-surface-wiring):** `noir task resume` + `workflow_resume` MCP tool (cross-session resume briefing — in-flight/blocked resumable, done/abandoned terminal); `taskClass` plumbed through `workflow_start` + `noir task new --class` (soft PRD gate live end-to-end for feature/epic); quick-mode `runQuick` wired into `workflow_start mode:'quick'` (stub spec + skipped gates + fast-forward to executing); `setBlocked`/`abandon` surfaced via `workflow_block`/`workflow_abandon` + `noir task block|abandon` (abandon has destructive confirm); `prd.mandatoryFor` config bridge (`resolveGateConfig`). `noir status` shows resume hint. **Zero FSM change.**
- **Verify-gate recovery (c4-verify-gate-recovery):** Evidence-backed verify gate — `GateEvidence` (ranAt + checks[{name,exitCode,outputDigest,command,tier}]) + `failed` decision + `VerifyGateError`; default OFF (byte-identical to v1.9.4 when unconfigured); `noir task verify` resolves checks from `workflow.gate.verify.checks` config, runs them (CLI owns shell access; engine never shells out), hashes output, submits evidence to `workflow_advance`; HARD checks block advance on non-zero + offer recovery (retry/force/skip/block), SOFT checks record + nudge. Block-and-offer-recovery with bounded retry. Document-phase artifact wiring: `noir task advance` → `done` writes a changelog entry + a pending decision-record stub via the artifact conflict seam (`--no-artifacts` escapes).
- **Research grounding (c4-research-grounding):** Soft research grounding sub-step — `ResearchEntry` type + `recordResearch`/`readResearch` engine methods (append-only `research:<taskId>` KV, source-required rule, 220-char text cap); soft grounding recommendation at the spec gate (mirrors PRD gate); clarify gating (`openQuestions` blocks clarify→spec, `--force`/`--skip`/jump escape); `setOpenQuestions` engine method; `writeClarifications` artifact writer; `workflow_research_record` MCP tool + `noir task research-record` CLI; `workflow.gate.research` config bridged via `resolveGateConfig`. Research is a **soft sub-step**, not a 10th hard FSM state (per research: no leading tool uses a hard research state).
- **Project discovery (c4-project-discovery):** `StackInfo` gains `pmSource`, `pmConflict`, `ci`, `existingAiFiles`; two-half PM detection (packageManager field > lockfile > user-agent, conflict surfaced); CI detection (github/gitlab/circleci/jenkins); existing-AI-tooling probe (AGENTS.md/CLAUDE.md/.cursorrules/.cursor/rules/GEMINI.md/.github/copilot-instructions.md — detection only, never clobber).
- **Capability → slice decomposition (c4-decomposition):** `SlicePlan`/`Slice` schema with deterministic validation (duplicate ID, missing field, dependency cycles, parallel file conflicts) in `slices.ts`; `noir task decompose <capability>` CLI (offline template, mirrors `draftPrd` P3); `rollback_plan` per slice (Noir's differentiation).
- **Release orchestrator (c4-release-phase):** `noir release <version> [--channel beta|stable] [--dry-run]` guided orchestrator over the patch-release flow (preflight→bump→gate→commit→CI→beta-tag→hands off at human-approval gates). Build-once/idempotent (tags immutable). Never auto-approves the publish job. The optional FSM release phase (`done→released`) is spec'd but deferred.
- **Clarify artifact + gating:** `writeClarifications` artifact writer (`.noir/clarifications/<id>-<slug>.md`); clarify→spec exit criterion: `openQuestions` non-empty blocks advance (`--force`/`--skip` escape).
- **Config bridge:** `prd.mandatoryFor` config override reaches the engine via `resolveGateConfig` (daemon http/stdio + CLI in-process read fallback); `workflow.gate.verify` and `workflow.gate.research` config blocks added to `NoirConfigSchema`.
- **6 design specs** in `docs/internal/specs/2026-08-11-c4-*.md` — each with acceptance criteria, testing strategy, and rollback plan.

### Changed
- **Engine constructor:** deep-merges partial `WorkflowGateConfig` with defaults (a partial config with only `prd` won't crash on `verify`/`research` access).
- **`detectStack`:** PM detection uses a defined cascade (packageManager field → lockfile → user-agent, with conflict surface); CI and AI-tooling probes added.

### Fixed
- **Wiring gaps:** `resumeTask`, `taskClass`, `runQuick`, `setBlocked`/`abandon`, `prd.mandatoryFor` config bridge, and `writeDecisionStub`/`writeChangelogStub` — all already implemented in the engine but unreachable from the CLI/MCP surface — are now fully wired.

## 1.9.4 (2026-08-10) — C3 skills enhancement

### Added
- **Skill pack curation (34→26):** 5 merges + gerund renames per Anthropic naming canon and collision-reduction research (~30-skill selection cliff).
- **Runtime-derived skill registry** (`buildRegistry()`, `noir skills registry --json`). No committed file — frontmatter metadata is the source of truth.
- **Structural quality gate** in `validateSkill`: metadata presence, required sections, line budget (<500), one-level refs, WHAT+WHEN descriptions.
- **`noir skills lint`** CLI — per-skill errors + warnings.
- **Offline evals harness:** `evals/evals.json` (agentskills.io format) + vitest runner, 2 shipped example evals (noir-tdd, noir-debug).
- ClickUp integration: STEP-0 auth gate, 12 API pitfalls with corrective patterns (subtasks, pagination, custom task IDs, attachments, status values, rate limits, auth header), verb dispatch grammar (`fetch|update|create|comment|batch`), attachment handling.

### Changed
- **All 26 builtins are full playbooks** (zero stubs). Every skill: WHAT+WHEN trigger-first description with boundary, when_to_use section, numbered procedure, verification checklist, notes, and "when done → next skill" footer.
- **Gerund renames:** brainstorm→brainstorming, plan→planning, execute→executing-plans, debug→systematic-debugging, tdd→test-driven-development, skill-author→writing-skills, explore→exploring.
- **Merges:** intake+clarify+brainstorm→brainstorming, verify+review→verifying, commit+pr+branch→shipping, document→wrap, test→test-driven-development.
- **Frontmatter expanded:** `metadata.{category,version}`, `license`, `compatibility`, `argument-hint` on args-taking skills.
- **`FORBIDDEN_RESIDUE` enforced** — no Superpowers rhetoric in native skills.
- **All descriptions WHAT+WHEN** (Anthropic canon; the WHEN-only school was fully migrated).

## 1.9.3 (2026-08-07) — TUI polish (Panel component, block cursor, fixed-width palette, clear screen)

### Added
- **Shared `<Panel>` component** — one rounded-border container for all 5 TUI surfaces, eliminating duplicated props across 5+ files.
- **Block cursor on empty input** (`▌`) — the command input field shows a static block cursor so users immediately see where to type.
- **Terminal clear on TUI entry** — `noir tui` and `noir palette` emit ANSI clear-screen before mounting so leftover home-menu / banner text doesn't linger above the TUI frame.

### Changed
- **Fixed-width palette** — 64-column panel (not full terminal); command labels truncate to fit; query row no longer nests a border inside the outer panel.

### Removed
- **`.superpowers/` folder** — legacy, no longer in use.

## 1.9.2 (2026-08-07) — TUI visual redesign (rounded borders + clear input fields)

### Added
- **Rounded borders across every TUI surface** — the dashboard, home menu, command palette, search overlay, confirm prompt, and help screen now render each major region inside a `╭─╮│╰╯` rounded panel (dim gray border) so components are visually separated instead of an undifferentiated wall of text.
- **Bordered input fields** — the command input, palette query, and destructive-confirm prompt each render inside their own rounded field, so the interactive surface is unmistakable at a glance.
- `contentWidth()` + `divider()` helpers in `theme.ts` — centralize the border (2) + padding (2) width budget so panels and their content agree on usable columns.

### Changed
- **Output pane truncation** — lines are truncated to `contentWidth()` (terminal − border − padding) and rendered with `wrap="truncate-end"`, so the `noir status` table and long output no longer overflow or wrap inside the bordered panel.
- **Dashboard layout** — StatusBar, OutputPane, and CommandInput stack inside one rounded panel with dim divider lines separating the regions; the footer hints sit below the panel.

### Notes
- Presentational only — no keybinding, routing, or logic changes. All 66 TUI tests pass (their regex assertions are border-agnostic); full gate green (1539 tests).

## 1.9.1 (2026-08-07) — home-menu crash fix

### Fixed
- **Bare `noir` home menu crashed on Enter** (`Cannot read properties of undefined (reading 'label')`), and arrow keys / Esc did nothing at the section picker. Root cause: the Level-1 picker used `@clack/prompts` `selectKey`, which in 0.7.0 is a *select-by-typed-letter* prompt — no arrow/enter/esc handling, and Enter leaves `value` `undefined`, so the submit render dereferences `options.find(o => o.value === undefined)` → crash. Both menu levels now use `select` (arrow + Enter + Esc/Ctrl+C all work).

### Changed
- **`@clack/prompts` upgraded `^0.7.0 → ^1.7.0`** (with `@clack/core` 1.4.3). This is ESM-only (matches Noir's `"type":"module"`), requires Node `>=20.12` (Noir requires `>=22` — satisfied), and brings native **Esc→cancel** (`settings.aliases`), arrow navigation, and empty-options handling. The one API break (`validate` now receives `string | undefined`) was adapted in `memory.ts`.
- **Home-menu Level 1 section picker** switched from `selectKey` to `select`; `selectKey` is removed from the home flow. The `HomeSection.key` field (legacy 1-9 selectKey binding) is now documented as unused-but-retained for TUI/test compat.

## 1.9.0 (2026-08-06) — home consolidation + `noir palette` + TUI bridge

### Added
- **Grouped home menu** — bare `noir` now renders a two-level section picker + action list backed by a new shared curated-section module (`packages/cli/src/tui/commands/sections.ts`, React-free). Five sections (Status & context, Memory, Workflow, Setup & maintenance, Dashboard) expose every interactive surface. Per-option hints, keybindings (1-6), destructive-command confirmation, back/next/previous navigation, and the non-interactive arms preserved exactly.
- **`noir palette` command** — the existing Ink fuzzy command palette mounted palette-first. `requireInteractive`-gated, lazy-imported, zero new routing. Accessible from the home menu ("All commands") and directly via `noir palette`.
- **TUI home Mode (`h`)** — a curated quick-action screen inside the Ink dashboard consuming the same `sections.ts` module. Bidirectional bridge: home menu → dashboard (`['tui']`), dashboard → home menu (`h`).
- **Shared palette-command registry** — `buildPaletteCommands(createProgram())` injected as `HomeDeps.commands` so the clack menu AND the TUI palette derive from the same single-source-of-truth — no drift possible (this structurally prevents the blank-Ctrl+K class of bug).
- **Enhanced dashboard help cheatsheet** — `?` now lists the home quick-actions and `h` bridge in addition to the existing keybindings.

### Changed
- **Bare `noir` home menu rebuilt** from a flat 8-item `select` to a grouped `selectKey` + `select` navigation. `deps.commands` injected by `bin.ts` from `buildPaletteCommands(createProgram())` (memoized at module scope).
- **`TuiDeps`/`AppProps` widened** — `AppProps.initialMode` lets `noir palette` render palette-first; `{ kind: 'home' }` added to the `Mode` union.
- **`runTui` deduplicated** — shared `buildTuiDeps` helper supplies both `runTui` and `runPalette` (projectId-keyed recents + palette source identical for both).

### Fixed
- **Ctrl+K/Cmd+K in the home menu** no longer routes to the `@clack` vim-map "Exit" option (the root cause was the disjoint home-menu ↔ TUI split — the palette only lived in `noir tui`). Now every surface is reachable from bare `noir`.

## 1.8.0 (2026-08-05) — C2 TUI delta + capability completion (beta on `develop`, then stable)

Capability 2 (CLI Runtime & UX) completed in one session (ADR-0006): the **TUI command palette + richer widgets** and **all four acceptance-condition gaps** closed. Executed as a 10-agent implementation Workflow + an 11-agent final-verification Workflow (find → adversarial verify); all changes reviewed, the full gate green at **1525 tests**. Cut as `1.8.0-beta.1` on `develop`, then promoted to stable `1.8.0` on `main`.

### Added
- **`Ctrl+K` command palette** in `noir tui` — a modal overlay (`packages/cli/src/tui/palette/Palette.tsx`) backed by a **data-driven command registry derived from the commander tree** (`buildPaletteCommands`). Fuzzy ranking via a hand-rolled subsequence + gap-penalty scorer behind a `FuzzyMatcher` swap seam (label > keywords > description; matched-char highlighting; recent-commands on empty query; grouped by category).
- **Input history + recall** — `↑`/`↓` on an empty `/`-input recalls the session's commands (shell-like, in-memory, adjacent-dedup).
- **Persistent recent commands** — the palette's recent list persists across sessions at `~/.noir/<projectId>/tui-history.json` (canonical ProjectId-keyed, `atomicWriteFile`, capped at 50, opt-out `NOIR_DISABLE_TUI_HISTORY`).
- **In-TUI destructive confirmation** — commands flagged `destructive` in the registry (e.g. `context index --force`) show a `y/N` confirmation overlay before dispatching; the direct input bar is unchanged.
- **Searchable output pane** — `Ctrl+F` enters search over captured dispatch output (incremental, smart-case, match highlighted); `n`/`N` next/prev (only when a query already matches, so the letter `n` stays typeable); `Esc` exits.
- **`daemon start --detach` real backgrounding** — `spawnDetachedDaemon` spawns a detached child (`detached:true, stdio:'ignore', windowsHide:true` + `unref`), waits for its record + `/health`, writes an honest `mode:'detached'` daemon record; `daemon stop`/`status` work unchanged (SIGTERM + probe). A hidden `--_detached-child` flag tells the child to run foreground-style within itself.
- **`context index --force` forces a full reindex** — the daemon `context_index` tool forwards `force` to the indexer's existing `reindex()`; default stays content-hash incremental.
- **`init`/`create`/`sync` `--dry-run` / `--preview`** — report the planned writes (paths, grouped by write/skip/identical category) to stderr without writing anything (reuses the scaffold engine's `dryRun`).
- **In-process read-only fallback** — `context search`, `memory recall`/`sessions`, `task status` keep working when the daemon is down via `withInProcessRead` (readonly store + engines, single-writer preserved); writes keep the daemon-required exit-4 path.

### Changed
- `probeDaemon` (daemon-client) now bounds its `/health` fetch with `AbortSignal.timeout(1500)` so a stale/blackhole port never hangs the probe (reads fall back instead).
- The TUI `App` state is a discriminated `Mode` union (`dashboard` | `palette` | `search` | `confirm`), replacing the growing boolean set — overlay input routing cannot collide with the dashboard's keybindings.
- `bin.ts` dangling references to nonexistent `docs/command-policy.md` + `docs/deprecation.md` removed (the deprecation registry is self-documenting; CHANGELOG + `docs/reference/cli.md` are the record).

### Documentation
- `docs/decisions/0006-c2-tui-and-daemon-detach.md` — records the palette architecture, hand-rolled-matcher-behind-seam, projectId-keyed recent persistence, real daemon detach, and the deferred **v2 orchestrator TUI** (Archetype B).
- `docs/roadmap/capability-02-cli-runtime.md` — status → **Completed**; gaps closed; acceptance criteria flipped `[DONE-CONDITION]` → `[MET]`.
- `docs/roadmap/STATUS.md`, `releases.md`, `roadmap.manifest.yaml` — C2 → Completed; next milestone = v2 orchestrator TUI (research).
- `docs/reference/cli.md` — new flags/commands documented.

---

## 1.7.4 (2026-08-05) — shim exec-bit defense-in-depth (beta on `develop`, then stable)

One critical fix that permanently prevents the recurring "noir update → permission denied: noir" bug. Cut as `1.7.4-beta.1` on `develop`, then promoted to stable `1.7.4` on `main`.

### Fixed
- **`noir update` produced a non-executable shim → `permission denied: noir`.** This was a **chicken-and-egg** bug: the update installing version X was orchestrated by version X-1's running code, which lacked the `chmod +x` fix — so the freshly-written shim landed as `0o644` and every subsequent `noir` command failed. The fix (`6120bf1`) was correct but could not self-heal during the transition. Two layers of defense now permanently close this: (1) `atomicWriteFile()` (core) **preserves the existing file's POSIX mode** across overwrites — a rewrite of an already-executable shim keeps `0o755` regardless of which binary version performs the write. (2) `ensureShimExecutable()` (core) **re-asserts `0o755`** after every install/update — a freshly-installed binary (1.7.4+) heals its own shim even if the OLD updater forgot to chmod. This closes the chicken-egg permanently: future updates can never produce an unrunnable binary. (`fix(core,cli)` `c458770`)

---

## 1.7.3 (2026-08-04) — post-1.7.2 bugfixes (beta on `develop`, then stable)

Four post-1.7.2 fixes, found by systematic root-cause debugging + a pre-release audit workflow (23-agent find→adversarial-verify sweep). Cut as `1.7.3-beta.1` on `develop`, then promoted to stable `1.7.3` on `main`.

### Fixed — bundling (`Dynamic require of "X" is not supported`)
A class of latent bugs where a `require()` inside a conditional code path survived tsup bundling as an ESM-incompatible `__require` shim. All three only fired on non-happy paths, which is why they survived multiple releases; all are fixed by converting to static top-level imports.
- **`noir init --upgrade` crashed with "Dynamic require of @noir-ai/create is not supported"** — `conflict.ts` used a lazy `require('@noir-ai/create')` that only fired when a file conflict triggered the diff preview. Pre-existing since v1.7.0. (`fix(cli)` `2c6fc63`)
- **`noir init --upgrade` crashed with "Dynamic require of crypto is not supported"** — `scaffold.ts` `sha256Hex12()` only ran AFTER a conflict was resolved (audit-record hash). (`fix(create)` `0376dbb`)
- **The 'rename' conflict case crashed with "Dynamic require of fs is not supported"** — `store/markdown.ts` + `workflow/artifacts.ts` lazily `require('node:fs')` for `renameSync` only in the `'rename'` conflict branch. (`fix(store,workflow)` `5e8def7`)

### Fixed — native install
- **`noir update` left the shim non-executable → `permission denied: noir`.** `installManagedNode()` wrote the shim with `atomicWriteFile` (which sets `0o644`) but never `chmod +x`'d it — every update produced an unrunnable binary. Now `chmodSync(shim, 0o755)` (matching `install.sh`). (`fix(install)` `6120bf1`)
- **`install.sh` gained progress spinners + auto shell-profile PATH.** `noir install`/`update`/`daemon {start,stop,status}` now show ora spinner feedback in TTY (no-op in CI/pipes); `install.sh` auto-adds `~/.noir/bin` to the right shell profile (zsh→`.zshrc`, bash→`.bashrc`, fish→`config.fish`, fallback→`.profile`) idempotently, and detects when a legacy install (nvm/npm) shadows the new shim. (`fix(install)` `6120bf1`, `5964a38`, `b4e6bb9`)
- **`.mcp.json` now emits the absolute native shim path** when a native install is detected, fixing `spawn noir ENOENT` from GUI MCP clients (VS Code launched from the Dock doesn't read shell profiles). (`fix` `2f28f91`)

### Fixed — adapters + store (from the pre-release audit)
- **opencode adapter dropped `opts.command`.** The ENOENT fix threaded the absolute shim path through 4/5 adapters but missed opencode (it uses a different config shape and hardcoded `'noir'`). A native install with `noir init --host opencode` emitted a bare `'noir'` the OpenCode GUI couldn't spawn. Now threads `opts.command ?? 'noir'`. (`fix(adapters,store)` `db99639`)
- **Store had no `busy_timeout`.** better-sqlite3's default is 0 (throw immediately on lock contention); WAL alone doesn't prevent `SQLITE_BUSY` if a second writer opens the same `.db` (a stdio MCP + a stray `noir` CLI, a stale daemon pid). Added `db.pragma('busy_timeout = 5000')`. (`fix(adapters,store)` `db99639`)
- **Added a table-driven cross-adapter parity test** (claude/agents-md/gemini/cursor/opencode) so the command-threading contract is locked — no adapter can silently regress. (`+11 tests` → 1439 total)

### Deferred (pre-existing, Windows-only — need a Windows VM to verify)
These were surfaced by the audit but are **not** fixed in 1.7.3 (Windows is excluded from the CI smoke matrix; better-sqlite3@13 is source-only and the runner lacks VS Build Tools):
- win32 managed-Node provisioning computes `npmBin = npm.exe` (Node ships `npm.cmd`, not `npm.exe`) and extracts with `unzip` (not present on stock Windows) → degrades to system-Node fallback.
- `install.ps1` lacks the auto-PATH + shadow-detection parity that `install.sh` gained.
- Scoop manifest `bin` entry points a Windows shim directly at a `.js` file with no `node` invocation.

Tracked in `docs/roadmap/backlog.md` (C1 "known Windows limitations").

---

## 1.7.2 (2026-08-04) — post-1.7.1 bugfixes

Three fixes shipped in 1.7.2 (patch bump 1.7.1 → 1.7.2):

### Fixed
- **`noir init --upgrade` crashes with "Dynamic require of @noir-ai/create is not supported"** — `conflict.ts` used a lazy `require('@noir-ai/create')` that survived tsup bundling as an ESM-incompatible `__require` shim. It only fired on file conflicts (existing host files during `init --upgrade`), quietly succeeding on clean-dir init. Replaced with a static import — pre-existing since v1.7.0.
- **`spawn noir ENOENT` from GUI MCP clients** — `.mcp.json` emitted `command: "noir"`, but GUI apps on macOS (VS Code launched from Dock) don't read shell profiles, so `~/.noir/bin` wasn't on the MCP client's PATH. When native-installed, `.mcp.json` now emits the absolute shim path (`~/.noir/bin/noir`), stable across upgrades. Non-native installs (npm/Homebrew) keep the bare `noir`.

### Changed — installer UX
- **install.sh now auto-adds `~/.noir/bin` to the shell profile** — detects the user's shell (zsh → `.zshrc`, bash → `.bashrc`, fish → `config.fish`, fallback `.profile`), appends an idempotent `# Noir CLI` + PATH export block, creates the file if missing.
- **install.sh detects PATH shadowing** — after writing the shim, verifies `command -v noir` resolves to the new path, and warns with instructions when a legacy binary (nvm, npm global) shadows the native install (the user sees "✓ noir is on PATH" but runs the old version).

> **Known limitation:** `noir install` is a 1.7.0+ command — users still on 1.6.0 must upgrade via the native installer one-liner first.

---

## 1.7.1 (2026-08-04) — post-1.7.0 bugfixes (beta on `develop`, then stable)

Two user-facing bugs were fixed after the 1.7.0 publish. Version bump 1.7.0 → 1.7.1 (patch). Cut as `1.7.1-beta.1` on `develop`, then promoted to stable `1.7.1` on `main`.

### Fixed
- **`noir_clickup_write` (daemon MCP tool) — dotted name broke the whole MCP session.** The MCP protocol restricts tool names to `[a-z0-9_-]`; the daemon served `noir.clickup_write`, but the host (Claude Code) rejected it during `tools/list` and aborted the session with `-32000`. Renamed to `noir_clickup_write` repo-wide (daemon src, `noir-clickup` skill, specs, ADR-0003, capability docs, tests) and added a **protocol regression guard** in `integration-tools.test.ts` asserting every registered tool name matches the MCP charset.
- **`install.sh` piped `curl | bash` now works.** `${BASH_SOURCE[0]}` is empty when the script is piped, so `SCRIPT_DIR` collapsed to `$PWD` and `node-version.env` was "not found next to install.sh" (plus a `set -u` unbound-variable error on the empty array element). When piped, the installer now fetches `node-version.env` from the repo raw URL (mirrors `install.ps1`'s `iex` fallback) and requires `NODE_DIST_BASE_URL`.

> **Note for users still on 1.6.0:** `noir install` is a 1.7.0 command — the native-installer one-liner is the upgrade path, and this `curl | bash` fix is what makes the piped one-liner work.

---

## 1.7.0 (2026-08-04) — C1 managed-Node provisioning + registry accuracy (published)

The C1 capability-1 completion: managed-Node auto-provisioning from the CLI, release-registry accuracy, and C1 -> Completed. **Published on npm as `1.7.0` (latest) + `1.7.0-beta.1` (beta) on 2026-08-04.** Decision record: [ADR-0005](docs/decisions/0005-native-installer-managed-node.md) (managed-Node, not single-binary; Windows = PowerShell + Scoop; winget/Chocolatey deferred).

### Added — managed-Node auto-provisioning
- **`provisionManagedNode()`** in `@noir-ai/core` (`packages/core/src/node-provision.ts`) — downloads, verifies (SHA256 checksum, fail-closed), and extracts a pinned **Node 22.23.2 LTS** runtime under `~/var/.noir/runtime/v<version>/`; atomic writes (staging-dir -> rename); auto-cleanup of old runtime versions (keep current only).
- **`MANAGED_NODE_VERSION`** exported from `@noir-ai/core`; shared with `install.sh`/`install.ps1` via **`scripts/node-version.env`** (single source of truth for the pinned Node version).
- **`downloadAndVerify()` / `extractNode()` / `detectNodeTarget()` / `nodeArchiveUrl()` / `NodeTarget` / `ProvisionedNode`** — the full provisioning pipeline as callable exports.
- **`runtimeDir()`** added to `packages/core/src/layout.ts` — resolves `~/.noir/runtime/`.
- **`noir install` / `noir migrate`** now calls `provisionManagedNode()` — the CLI can bootstrap the managed runtime without a shell script; no more "not provisioned" fail.
- **CI `node-provision-smoke` job** (`.github/workflows/ci.yml`) validates a real Node download on each push.

### Fixed — release registry
- **Registry rebuilt** with accurate channel labels — `1.4.0` and `1.5.0` entries now correctly show `channel: stable` (were mislabeled as `beta`). Every entry carries a non-null `changelogRef`.
- **`scripts/release-registry.mjs` `buildEntry`** now derives `channel` / `npmDistTag` from release type (stable → `stable`/`latest`, prerelease → `beta`/`beta`).

### Added — native installer (managed-Node)
- **`scripts/install.sh`** (POSIX) and **`scripts/install.ps1`** (Windows PowerShell): provision a pinned **Node 22.x LTS runtime** under `~/var/.noir/runtime/v<version>/`, install `@noir-ai/cli` into an isolated prefix under `~/.noir/cli/`, write a `noir` shim at `~/.noir/bin/noir` (`.cmd` on Windows), and record the install in `~/.noir/install.json` (`method: native`). **No system Node prerequisite, no `sudo`/admin.** Idempotent (re-run = upgrade). Env knobs: `NOIR_CHANNEL`/`NOIR_VERSION`; proxy pass-through (`HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`); PATH hint; `noir --version` verify.
- **Windows PowerShell is the primary Windows path** — no Git Bash/MSYS2/WSL needed. Run from a normal PowerShell prompt.
- **Trust & verification** — every release publishes the installers as Release artifacts with a `SHA256SUMS` file and a Sigstore build-time attestation (`actions/attest-build-provenance@v3`). Verify with `shasum -a 256 install.sh` + `gh attestation verify install.sh --repo agaaaptr/noir`.

### Added — CLI self-update + migration
- **`noir install` / `noir migrate [spec]`** — move an existing install (npm/pnpm/yarn/bun/Homebrew/Scoop) to the native path. Settings preserved (`.noir/` project data + `~/.noir/` user data never touched); `--list` detects every install; `--uninstall-prev` removes the prior method (never auto-uninstalls — the suggested uninstall command is always printed when omitted). PATH-hash hint printed after the swap (`hash -r && which -a noir`).
- **`noir update [spec]`** — self-update via the active install method (native → re-provision; npm/pnpm/yarn/bun/Homebrew/Scoop → reinstall via that manager). `--check` prints the latest vs. installed and exits.
- **Async startup version check** — non-blocking, cached (`~/.noir/update.json`), 24h interval default (configurable under `update:` in `.noir/config.yml`). Never blocks the CLI, never makes a paid call, silent under `--quiet`/CI/non-TTY.
- **Version-assert (no silent downgrade)** — `noir install`/`update` refuses a silent downgrade via per-segment numeric semver comparison; explicit `--spec`/pin prints a warning. When the registry is unreachable, `noir update` prints "Could not reach the registry." and exits (never silently "up to date").
- **Env kill-switches** — `NOIR_DISABLE_UPDATE_CHECK` suppresses the background startup check only; `NOIR_DISABLE_UPDATES` is a hard kill-switch for the entire self-update surface (`noir update` refuses with exit 2).
- **One-time migration banner** — a non-blocking banner suggests `noir migrate` on non-native installs; `noir install --dismiss` persists the dismissal per version in `install.json`'s `dismissedVersions`.

### Added — doctor install row
- **`noir doctor` install row** — advisory `ok`/`warn` only (never `fail`), never a live network call. Reports the detected install method (`native`/`npm`/`pnpm`/…), the installed version, the latest-known version from the update cache, and a non-blocking `native recommended` nudge on non-native paths.

### Added — config
- **`update:` block** on `NoirConfigSchema` (additive; absent block ⇒ enabled/24h/`latest`/`notice` defaults): `checkEnabled`, `checkIntervalHours`, `channel`, `minVersion` (a floor — update never installs below it), `display`.

### Added — package-manager taps
- **Homebrew formula** ([`packaging/homebrew/noir.rb`](packaging/homebrew/noir.rb)) — real `url`/`sha256`/`version` from the published 1.6.0 npm tarball (was a placeholder). Node-for-Formula-Authors pattern; depends on `node@22`; stable-only (taps are single-channel). Tap README at `packaging/homebrew/README.md`.
- **Scoop manifest** ([`packaging/scoop/noir.json`](packaging/scoop/noir.json)) — Windows; depends on `nodejs-lts`; shims `dist/bin.js` as `noir`; stable-only single-channel.

### Added — release workflow
- **Installer artifacts + checksums + attestation** in `.github/workflows/release.yml`: copies `install.sh`/`install.ps1` into `dist-installers/`, generates `SHA256SUMS`, runs `actions/attest-build-provenance@v3` over both + the checksums file, uploads them as Release assets, and pastes `gh attestation verify` instructions into the Release body. Windows CI matrix + an offline structural-lint test for both workflows.

### Decisions
- **ADR-0005** — native installer is **managed-Node, not a single binary** (research-verified). Windows = PowerShell + Scoop; winget/Chocolatey deferred (covered by `install.ps1`/Scoop/npm today). Commits local on `develop`; publish separate.

### Deferred (documented in `docs/roadmap/backlog.md`)
- winget / Chocolatey (decision; ADR-0005).
- Per-channel update cache (`Record<channel, version>` shape) — deliberately not adopted to preserve the committed `UpdateCache` interface; cross-channel isolation already enforced by `latestVersionFromCache`.
- `migrationNotes` / `breakingChanges` / `securityAdvisory` — structured release metadata beyond `changelogRef` not yet captured.

---

## 1.5.0 (2026-07-28)

**First stable release — published on npm (dist-tag `latest`).** `npm i @noir-ai/cli` now resolves to `1.5.0`. This is the first publication of the `latest` channel from `main` — prior releases all shipped under the `beta` dist-tag from `develop`.

Released alongside `1.4.0-beta.2` (beta channel). Ships the complete documentation overhaul, auto-prerelease versioning, smart release tag creation, version registry, release-registry manager, and the CI channel auto-detection layer.

The `beta` dist-tag keeps pointing at `1.4.0-beta.2`; run `npm i @noir-ai/cli@beta` to opt in.

### What's new

- **Auto-prerelease versioning** — Source stays at clean SemVer (`1.5.0`); CI derives `X.Y.Z-beta.N` based on npm registry query. Never manually pick a beta number again.
- **Smart release tooling** — `pnpm release:tag` auto-computes the correct tag; `pnpm release:history` shows structured release history; `.noir/releases/` registry tracks every published version.
- **Documentation overhaul** — Diátaxis-structured docs (tutorial/how-to/reference/explanation), auto-generated CLI/config/skills/packages references, version auto-sync, documentation registry, CI validation.

## 1.4.0 (2026-07-27)

**Beta-to-stable promotion — published on npm (dist-tag `latest`).** Same content as `1.4.0-beta.1`, promoted on `main`. The dead `v1.4.0` tag was deleted before re-tagging at the stable commit.

The `beta` dist-tag kept pointing at `1.4.0-beta.1` for a short period until `1.4.0-beta.2` shipped.

For consumers on the default install, `latest` had stayed at the first-ever publish (`1.0.0-beta.1`, 2026-07-25) throughout the beta line — so stable `1.4.0` lands the entire body of work that matured across `1.2.0-beta.1` → `1.3.0-beta.6` → `1.4.0-beta.1`. Per-release notes are below; the major arcs:

- **v1.x capabilities (K/R/I/P/S/X)** — the keystone `managedBlock` refactor plus five capabilities on it: curated `.noir/rules/RULES.md`, `IgnoreManager`, PRD artifacts, the `@noir-ai/create` scaffold engine (`noir create` / `init --upgrade` / migrations), and a first-class integration layer (ClickUp reference integration, `gated-write-proxy`). First published in `1.2.0-beta.1`.
- **Multi-host (S10)** — `resolveAdapter(host)` registry (claude / agents-md / gemini / cursor / opencode); `--host` on `init`/`create`/`sync`; a universal `AGENTS.md`; cursor `.mdc` skills; `opencode.json`. First published in `1.2.0-beta.1`.
- **Scaffold idempotency + universal conflict contract (SP-A…H)** — `noir sync` on an unchanged tree writes nothing; root-safety (`assertSafeRoot`) prevents nested `.noir/`; one `buildConflictOpts`/`onConflict` seam across every file-producing path with diff preview, apply-to-all, and zdiff3 merge; three-way managed-region merge (`--merge`); semantic duplicate detection (`noir doctor --dedup`). Shipped `1.3.0-beta.1`…`6`.
- **Runtime polish (`1.4.0-beta.1`)** — install deprecation fixes (`engines.node >=22`, `better-sqlite3 ^13` dropping `prebuild-install`); the unified output design-system (`theme.ts`, no more red headers, responsive tables, `NO_COLOR`/`CLICOLOR_FORCE`/`NOIR_ACCESSIBLE`); bare-`noir`-primary command policy (`--tui`/`--no-tui`/`--no-tips`); on-demand host handoff (`noir handoff`/`wrap`); the Ink `noir tui` MVP dashboard.

The intermediate `1.3.0-beta.7` / `1.3.0-beta.8` / `1.4.0` tags failed CI on a `useColor()` leak under `CI=true` and were never published; their work landed in `1.4.0-beta.1` and therefore in this stable release. (The dead `v1.4.0` tag was deleted before re-tagging at the stable commit.)

**Requirements:** Node `>=22` (Node 22–25; CI on Node 22). **1315/1315 tests** green under `CI=true`. SLSA provenance attached to all 11 `@noir-ai/*` packages.

---

## 1.4.0-beta.1 (2026-07-27)

**Published on npm (dist-tag `beta`)** — the 2026-07-26/27 overnight "runtime polish" release: install fixes, a unified output design-system, a fully idempotent scaffold, one universal conflict contract across every file-producing path, write-path semantic duplicate detection, a TUI-primary command policy, on-demand host handoff, and an Ink `noir tui` dashboard, plus repo-wide cleanup. This is the first PUBLISHED version of the session — the intermediate `1.3.0-beta.7` / `1.3.0-beta.8` / `1.4.0` tags failed CI on a `useColor()` leak under `CI=true` (picocolors `isColorSupported` includes `|| env.CI`, so table headers got ANSI-wrapped and the responsive-table "fits 60/80/120 cols" test measured ANSI bytes as overflow), were never published, and are superseded by this entry. The `1.4.0-beta.1` version was selected explicitly; its `develop` tag published under the `beta` dist-tag. **Minor** bump — the `engines.node` `>=22` floor lands as a minor semver signal (Node 20 was already EOL).

The `1.4.0-beta.1` version was chosen explicitly for this release. The branch determines the npm dist-tag (`develop` → `beta`, `main` → `latest`); it does not add or remove a prerelease suffix.

### Install — deprecation warnings fixed at the source
- **`prebuild-install` removed entirely.** `better-sqlite3` `^12 → ^13` (the 2026-07-21 N-API rewrite) in `@noir-ai/store`; the deprecated `prebuild-install` is no longer a transitive dependency for Noir OR any consumer (`pnpm why -r prebuild-install` empty; 0 lockfile matches).
- **`engines.node` `>=20 → >=22`** across all 11 packages (Node 20 reached EOL 2026-04-30; `>=22` enables `better-sqlite3@13` and covers Node 22–25; CI uses Node 22). `>=24` was considered and rejected — it would drop still-supported Node 22 LTS for no benefit.
- **`boolean@3.2.0` muted** dev-side via `allowedDeprecatedVersions` in `pnpm-workspace.yaml` (harmless transitive: `@huggingface/transformers` → `onnxruntime-node` → `global-agent` → `boolean`; no released upstream fix yet, tracked `transformers.js#1730`/`#1718`). New **"Deprecation warnings during install"** troubleshooting section.
- Note: `better-sqlite3@13` is brand-new — on the very newest Node a matching prebuilt may not be published yet, so it may compile from source (needs a C/C++ toolchain). The `Unknown user config "python"` warning is from the user's own `~/.npmrc`, not Noir.
- All Node-floor references updated to `>=22` (README, getting-started, installation, `scripts/install.sh`, `scripts/new-package.mjs` template, `docs/packaging.md`, `docs/releasing.md`).

### Output design-system (no more red headers)
- New `packages/cli/src/theme.ts` — single owner of the semantic palette (`c.{ok,warn,error,info,accent,dim,bold}`), `badge(state,label)` (always symbol + text label + color → NO_COLOR- and colorblind-safe), `useColor()` / `accessibleMode()` / `terminalWidth()`.
- `output.ts table()` rewritten: the default **red headers are gone** — headers pre-colored via picocolors and cli-table3's `@colors/colors` path bypassed (empty `style.head`/`style.border`) so under `NO_COLOR` everything (head + border + body) strips consistently with no leak. Tables are **responsive** (`colWidths` from `terminalWidth()`, `wordWrap` + `truncate`), TTY-gated.
- New `definitionList()` / `kv()` helpers; `status`/`task`/`context`/`memory` render via `definitionList`; `doctor` Status column uses `badge()` (`✓ OK` / `⚠ WARN` / `✗ FAIL`) with **red reserved strictly for errors**.
- Honors `NO_COLOR` (full strip), `CLICOLOR_FORCE=1` (force color when redirected), `NOIR_ACCESSIBLE` (symbol+text badges + solid banner). `--json` envelopes byte-identical; memory-recall non-table policy preserved.

### Idempotent scaffold
- `noir sync` on an unchanged tree now writes **nothing** (managed-region content-hash dedup via `predictManagedBlock(s)`; no mtime/git churn) — the perceived "noir init duplicates" was git-status churn, not real duplication.
- `.noir/ancestors.json` seeded on **every** init/create/sync. `mergeManagedRegions` defaults to **TRUE** (bare `noir sync` preserves in-region user edits across template upgrades; `--no-merge-regions` escape). *(Latent fix: `mergeManagedRegion` dropped a trailing newline so dedup could never fire and every sync drifted the file by one byte.)*
- Bare `noir init` on an initialized project **no-ops** without `--upgrade`; pre-1.3.0 projects (project.id present, no stamp) also no-op. The engine is **hermetic** for API/embedded callers (explicit `ScaffoldOptions.interactive` flag, decoupled from `process.env`). Fixed the stale comment that claimed multi-region merge was unshipped (it shipped in SP-H).

### Universal conflict contract
- Every file-producing path now routes through one `buildConflictOpts` + `onConflict` seam — including the three that previously blind-overwrote: `skills/compiler emitSkillsToDir` (the `rm -rf` orphan cleanup is now `assertNotUserOwned`-guarded — a hand-authored `noir-*` skill is preserved + reported, never silently deleted), `workflow/artifacts` (8 writers), `store/markdown exportMarkdown`.
- `@clack` conflict resolver now shows a **colored unified diff** (stderr; `+`/`-` via the theme; `NO_COLOR`-gated) before the prompt. **Apply-to-all** scoped to artifact class (regenerate shares; managed blocks stay per-file; a `noir init --upgrade` over N pointers is now 1 prompt). 6th option **"merge (with conflict markers)"** (zdiff3). `--json` emits a structured `ScaffoldResult.conflicts[]` (`{path, mode, similarity, existingSha, proposedSha, resolution}`); no prompt under `--no-input`.

### Write-path semantic dedup
- Before writing a host-context file, `noir init`/`create`/`sync` check it against existing host files (CLAUDE.md / AGENTS.md / GEMINI.md / RULES.md) via the S6 embedder and surface a near-duplicate (e.g. CLAUDE.md ≈ AGENTS.md) as a **non-blocking recommendation** (Replace/Mirror/Skip/Create) via `findNearestDuplicate` — the dedup detector and the conflict resolver are now one connected system.
- Two-tier (cosine ≥0.95 action, 0.85–0.95 info-only); content-hash gate at `.noir/dedup-cache.json` (no re-embed of unchanged files). **Graceful degradation:** if the embedder/model is unavailable or slow, it warn-skips — `noir init`/`sync` never block on a model download or fail because of a missing embedder. `init`/`sync`/`create` now return the `ScaffoldResult` (with `conflicts[]`).

### TUI runtime policy
- Bare `noir` is the documented primary UX. New global flags `--tui`/`--no-tui` (advisory routing; `--no-tui` sends bare `noir` to the status path even in a TTY) and `--no-tips` (suppresses redirect/deprecation hints in CI). **No command is hard-gated** — every subcommand stays 100% scriptable. Every read-side command emits the `{ok, data}` `--json` envelope. New `docs/command-policy.md` (interactive-vs-scriptable matrix) + `docs/deprecation.md` (warn → redirect → never-silently-remove; zero entries today).

### Host handoff (`noir handoff` / `noir wrap`)
- An on-demand, pasteable markdown handoff artifact (Task / Phase / next gate / Goal / extracted-context seed / "open `<host>`" directive / MCP references) to STDOUT; `--write` persists to gitignored `.noir/handoff/<id>.md`; `--json` emits the structured object. `hostLaunchDirective(host)` is the single source for the text-only host-launch directive (host-aware via `SUPPORTED_HOSTS`; called from the home banner AND the handoff); optional `HostAdapter.emitHandoff?` (back-compat). `noir-wrap` skill graduated stub→full. `noir task advance --to verify` surfaces a stderr tip (silenced by `--no-tips`). Daemon-down + missing-embedder degrade gracefully. Never writes into CLAUDE.md/AGENTS.md; never spawns the host.

### Ink `noir tui` dashboard (MVP)
- A lazy-loaded Ink (React 19) interactive dashboard: StatusBar (host/mode/phase/daemon), scrollable OutputPane, CommandInput (`/`-prefix dispatches native commands through the existing `home(opts,deps).dispatch` seam — not reimplemented), branded Header, Footer shortcuts. Hand-rolled widgets. The lazy load preserves the `isMainModule` symlink guard (the silent-no-op regression class) via a runtime-expression dynamic import + a two-config tsup build, so `dist/bin.js` stays a single 1890-line entry with the guard inline and **0 React refs** — the main CLI startup path stays React-free. Interactive-only (`--json`/non-TTY → exit 2). 12 ink-testing-library tests. Richer widgets documented as deferred.

### Repo-wide cleanup
- Stripped ~627 internal session/tier/task labels from source comments/JSDoc, test names, user-facing strings, and public docs; renamed 3 tier-prefixed test files; fixed a `handoff` test CWD-path bug; fixed tier-label leaks in skill content. (Internal labels remain only in `docs/internal/plans/*` + `docs/discovery/*`.)

### CI color fix
- Under `CI=true`, `picocolors.isColorSupported` flipped color ON (`|| env.CI`), ANSI-wrapping table headers so the responsive-table "fits 60/80/120 cols" width test measured the ANSI bytes as overflow and failed (also violating the auto-disable-under-CI contract). `useColor()` now returns false under `CI=true`; `CLICOLOR_FORCE=1` still forces color for CI viewers that want it. This was the release blocker that unpinned 1.4.0-beta.1.

**1315/1315 tests green** under `CI=true` (was 1181 at session start → +134 across the session).

## 1.3.0-beta.6 (2026-07-26)

**Published on npm (dist-tag `beta`)** — banner gradient refined to **Midnight Cobalt** (dark cobalt `#2c5282` → bright blue `#3b82f6` → sky `#7dd3fc`). Brighter than the beta.3 midnight preview, all-blue (no purple/cyan), smooth via gradient-string. User-chosen from a palette of 5 noir-inspired options.

Notable changes to the Noir toolkit, newest first. Slices follow the roadmap (`docs/roadmap/`); per-slice design lives in `docs/internal/specs/`.

## 1.3.0-beta.5 (2026-07-26)

**Published on npm (dist-tag `beta`)** — patch on 1.3.0-beta.4. Two banner fixes the user caught when running `noir`:

- **The banner now reads "NOIR" (was "NOHA").** The hand-rolled ANSI Shadow "R" was malformed; regenerated from the standard figlet glyphs + verified letter-by-letter. Test asserts the correct "R" (`██████╔╝`) to guard the regression.
- **Smooth gradient replaces the garish per-row rainbow.** Added `gradient-string` (purple → blue → cyan, vertical) — the modern AI-CLI banner look (cf. [GitHub Copilot CLI banner](https://github.blog/engineering/from-pixels-to-characters-the-engineering-behind-github-copilot-clis-animated-ascii-banner/)). `color:false` still emits zero ANSI.

---

## 1.3.0-beta.4 (2026-07-26)

**Published on npm (dist-tag `beta`)** — patch on 1.3.0-beta.3. One fix, found by a comprehensive (filesystem, not git-only) re-scan of svc-academic-activity-go:

- **`noir doctor`'s nested-`.noir` check now detects nested ignore files too.** The fingerprint of a `noir init` run inside `.noir/` includes the ignore files Noir emits at the nested root (`.noir/.gitignore`/`.dockerignore`/`.npmignore`/`.prettierignore`), but the check only looked at `.noir/.noir`, `.noir/CLAUDE.md`, `.noir/.mcp.json`, `.noir/.claude` — so leftover nested ignore files (exact duplicates of the root ones) went undetected and reported "OK". Added the 4 ignore files to the candidate list.

---

## 1.3.0-beta.3 (2026-07-26)

**Published on npm (dist-tag `beta`)** — patch on 1.3.0-beta.2. One fix, found validating 1.3.0-beta.2 in svc-academic-activity-go:

- **Stack-aware ignore emission.** Noir no longer emits `.npmignore`/`.prettierignore` for non-JS projects (they were exact duplicates of each other + irrelevant for, e.g., a Go service), nor `.dockerignore` when there's no Dockerfile. `.gitignore` always; an unknown/undetectable stack ⇒ all four (backward compat).

---

## 1.3.0-beta.2 (2026-07-26)

**Published on npm (dist-tag `beta`)** — patch on 1.3.0-beta.1. One fix, found by validating 1.3.0-beta.1 in a real project (svc-academic-activity-go):

- **`noir init`/`create` on an already-initialized project now truly no-ops.** The already-init guard lived in the engine (`scaffold()`), but the cli commands unconditionally re-emitted the skill pack + printed "initialized" after it — so a 2nd `noir init` rewrote 34 skill files + misreported. New `ScaffoldResult.noop` flag gates skills emission + the message.

---

## 1.3.0-beta.1 (2026-07-26)

**Published on npm (dist-tag `beta`)** — cut from `develop`; `release.yml` derived `channel=beta` from the tag living on `develop`. Eight sub-projects (SP-A…H) + an opus whole-branch review fix wave from the 2026-07-26 scaffold/TUI discovery session. All TDD; full repo green (1154 tests). Discovery: `docs/discovery/2026-07-26-scaffold-tui-discovery.md`; specs in `docs/internal/specs/2026-07-26-*-design.md`.

### SP-A — Scaffold root-safety + already-init no-op + doctor nested-`.noir`
- **Root-caused & fixed the "noir init duplicates" bug:** running `init`/`create`/`sync` with cwd inside `.noir/` minted a fresh project.id (whenever `<root>/.noir/project.id` was absent) and built a **nested `.noir/.noir/`** project. New `assertSafeRoot` (`@noir-ai/create`) hard-refuses to scaffold when `root` is or is inside a `.noir/` directory (not bypassable).
- `noir init`/`create` on an already-initialized root is now a **no-op** (was a silent re-emit); `--upgrade`/`--force` bypass it. `--force` added to `init`/`create`.
- `noir doctor`: new read-only `nested .noir` check detects the nested-re-init fingerprint (`.noir/.noir/`, `.noir/CLAUDE.md`, `.noir/.mcp.json`, `.noir/.claude`).

### SP-B — Branded banner + host-aware home
- Bare `noir` opens with a pre-rendered "noir" ASCII block wordmark + faux gradient (picocolors, **no new dep**) + tagline + host-direction ("open your host to develop", host-agnostic via the S10 registry) + the CLI command list, then the existing `@clack` action menu. Guardrails: skips under `--quiet`/`--json`/`NOIR_NO_BANNER`/non-TTY/CI; responsive width (≥50 cols → block wordmark, `<50` → compact `◆ noir`); no animation (accessibility).

### SP-C — Regenerate conflict resolution
- `regenerate` files (`.mcp.json`, `AGENTS.md`) are no longer silently overwritten on `sync` / `init --force` / `init --upgrade`. New engine hook `ScaffoldOptions.onConflict` + `conflictPolicy` (UI-free; the cli injects a `@clack` menu in TTY: Replace/Rename/Duplicate/Keep/Cancel); non-TTY/CI preserves; `--force` overwrites; `noir sync --force` added. Resolutions: replace / preserve / rename (`<path>.local`) / duplicate (`<path>.noir`) / cancel.
- Content-hash dedup + three-way managed-block merge shipped as SP-E/SP-F below. Only multi-region (CLAUDE.md) three-way merge remains a follow-up.

### SP-D — Semantic duplicate detection (`noir doctor --dedup`)
- `@noir-ai/context` `findSemanticDuplicates(files, embed, threshold=0.9)` — embeds each file via an injected `EmbedFn`, L2-normalizes, finds near-duplicate pairs by cosine similarity. The ONLY mechanism that catches cross-file SEMANTIC overlap (e.g. a hand-mirrored CLAUDE.md ≈ AGENTS.md); exact content-hash cannot.
- `noir doctor --dedup` (opt-in; default doctor stays fast) — collects host-context files (CLAUDE.md/AGENTS.md/GEMINI.md) + `.noir/rules/RULES.md`, lazy-loads the S6 local embedder, reports near-duplicate pairs (cosine ≥ 0.90) as a warn row. Degrades to a warn-skip when the embedder is unavailable. (cli now depends on `@noir-ai/context`.)

### Review fix wave (opus whole-branch review of SP-A/B/C — 0 criticals)
- `rename`/`duplicate` conflict resolutions now use a `uniqueAside` helper — never silently clobber a prior `.local`/`.noir` backup (data-loss) and win32-safe.
- `cancel` aborts the whole scaffold (was: skip-one-file-and-continue — a contract violation).
- Tests pin that `--force` never weakens root-safety; rename idempotency; trailing-slash; strengthened overwrite/conflict assertions. (The `--json`/`--no-input` ⇒ conflict-prompt gap was closed in SP-G.)

### SP-E — Three-way managed-region merge (`noir sync --merge`)
- Opt-in three-way merge (line-level diff3) for single-region managed files (NOIR.md, ignores): a hand-edit INSIDE a `<!-- noir:* -->` region survives a template update instead of being strip-replaced. `mergeThreeWay` + a `.noir/ancestors.json` store; disjoint changes merge cleanly, overlapping changes → inline conflict markers. (Multi-region CLAUDE.md shipped in SP-H.)

### SP-F — content-hash dedup (`identical` report)
- `regenerate` files byte-identical to disk are no longer rewritten — reported in a new `ScaffoldResult.identical` field (Yeoman-style). Managed/seed paths unchanged.

### SP-G — `--json`/`--no-input` never prompts for a conflict
- Closes the review-flagged contract gap: `buildConflictOpts` now honors `NOIR_NON_INTERACTIVE` (set by bin's preAction hook under `--json`/`--no-input`) ⇒ a regenerate conflict preserves instead of prompting. Cascade-free (no init/create/sync arg changes; bin.test.ts arg-pins unchanged).

### SP-H — Three-way merge for multi-region files (CLAUDE.md)
- Extends SP-E to the multi-region `managedBlocks` path (CLAUDE.md = CONTEXT + RULES): each region merges against its own ancestor in the single atomic multi-region write. No remaining follow-ups — all managed regions (single + multi) support `--merge`.

---

## 1.2.0-beta.2 (2026-07-26)

**Published on npm (dist-tag `beta`); verified working via global install** — `npx @noir-ai/cli@1.2.0-beta.2 --version` → `1.2.0-beta.2` (exit 0); `noir init` scaffolds. The critical global-install fix:

**Critical fix: a global `noir` install was a silent no-op** (every published beta, including 1.2.0-beta.1). Two bugs:

- **Symlinked-bin silent exit (critical):** the `isMainModule` guard compared `pathToFileURL(process.argv[1]).href` to `import.meta.url`. A global npm install invokes the bin through a symlink (`…/bin/noir` → `…/lib/node_modules/@noir-ai/cli/dist/bin.js`), so `argv[1]` is the symlink path while `import.meta.url` is the resolved real path — they never matched, `main()` never ran, and `noir` exited 0 with **no output**. **Fix:** `realpathSync(argv[1])` before comparing. (Direct `node bin.js` worked because `argv[1]` was already the real path — which is why the in-repo dogfood never caught it; the regression test now spawns the bin via a symlink.)
- **`--version` exit code:** commander v12 throws error code `commander.version` (not `commander.versionDisplayed`); the exit-code mapper missed it, so `noir --version` exited 2 (usage) instead of 0. **Fix:** map `commander.version` → exit 0.

### Fixed
- `noir --version` / `--help` / `init` / `create` / bare `noir` now work when installed **globally** (symlink invocation). A regression test (`global-install symlink invocation`) guards both fixes.

---

## 1.2.0-beta.1 (2026-07-26)

**Multi-host (S10) ships on the beta channel.** Noir is now cross-CLI: Claude Code stays the default, and **Gemini, Cursor, OpenCode, and AGENTS.md** are one `--host` flag away. This is the first published release of the previously untagged `1.1.0-beta.1` capability work. Cut from `develop`; `release.yml` derived `channel=beta` from the tag living on `develop`. **11 packages** (unchanged); **1089/1089 tests** (was 966 during the unpublished 1.1 work); build / typecheck / lint (0 warnings) green. Design record: `docs/internal/specs/2026-07-25-s10-multihost-design.md`; the locked decisions in [ADR-0004](docs/decisions/0004-multi-host-adapters.md).

### Added — S10 multi-host adapters
- **Adapter registry.** `resolveAdapter(host: HostId): HostAdapter` in `@noir-ai/adapters` — a `Record<HostId, HostAdapter>` map with an exhaustiveness guard. `HostId = 'claude' | 'agents-md' | 'gemini' | 'cursor' | 'opencode'` (one owner; core/skills redeclare the literals). `SUPPORTED_HOSTS` — a frozen iteration list the CLI `--host` flag's `.choices(...)` and `noir doctor` consume. The CLI's 8 direct `claudeAdapter` imports collapsed to one `resolveAdapter(host)` call; adding a host needs no CLI edits beyond the flag enum.
- **`host:` config widens** from `z.literal('claude')` to `z.enum(['claude','agents-md','gemini','cursor','opencode']).default('claude')`. `claude` is the **default and the regression anchor** — a bare `noir init` is byte-equivalent to pre-multi-host (existing init/skills/doctor tests stay green). `CompileTarget` widens to the same enum so the skills compiler transforms per host.
- **`--host <id>` flag** on `noir init` / `noir create` / `noir sync` (default `claude`; commander rejects unknown values as `usage=2`). The choice persists into `.noir/config.yml`; `noir sync` reads it back (pass `--host` to override — advanced, not written back to config). `noir doctor` reports the **active host** and verifies host-specific artifacts (a `host:{active, expected, missing}` check).
- **4 new adapters:**
  - **`agents-md`** — the 32-platform universal standard. Root `AGENTS.md` (context + rules unified) + a broadly-compatible `.mcp.json`. No skills dir.
  - **`gemini`** — `GEMINI.md` (Gemini's native `@import` form, rules folded in) + root `AGENTS.md` + `.gemini/mcp.json`. No skills dir.
  - **`cursor`** — `AGENTS.md` + `.cursor/rules/*.mdc` (skills compile to **flat** `.mdc` with YAML frontmatter `description`/`alwaysApply:false`; the `@.noir/rules/RULES.md` import in AGENTS.md is cursor's rules surface — no separate host-rules pointer) + `.cursor/mcp.json`.
  - **`opencode`** — `AGENTS.md` + `opencode.json`. **Distinct MCP shape:** OpenCode's `mcp` block entries are `type`-tagged (`{type:'local', command:[...]}` stdio / `{type:'remote', url}` HTTP), not the `{mcpServers:{...}}` family; the emitted file stamps `$schema: https://opencode.ai/config.json`. Schema verified against `https://opencode.ai/docs/mcp-servers/`. No skills dir.
- **Universal `AGENTS.md` emitter (shared helper).** `emitAgentsMd(ctx)` produces byte-identical `AGENTS.md` content for every host: a heading + a 3-line inline fallback summary + `@.noir/NOIR.md` + `@.noir/rules/RULES.md` `@`-imports. The inline summary precedes the imports so readers that do not resolve `@`-imports still get a one-glance pointer; the imports remain canonical for hosts that do (Cursor, Codex, Junie, …).
- **No-duplication gating.** AGENTS.md is always emitted (every host reads it), but hosts with a native context file (`claude`→`CLAUDE.md`, `gemini`→`GEMINI.md`) keep it primary and **do not duplicate** content into AGENTS.md — the universal file carries only the canonical `@`-imports. One source (`.noir/`), never a drifting copy.

### Added — S11 remainder
- **[`docs/reference/packages.md`](docs/reference/packages.md)** — the per-package framework/library API surface ("usable as a framework"): the stable barrels of `@noir-ai/{core,store,workflow,adapters,skills,context,memory,model}` with versioning + stability stance. Includes the `@noir-ai/adapters` `HostAdapter`/`resolveAdapter`/`SUPPORTED_HOSTS` surface.
- **`noir doctor` `publish` check** — advisory package-metadata validation across all `packages/*` (`name` `@noir-ai/*`, semver `version`, non-empty `files`, and `bin` for the cli). `warn` level, never `fail`.

### Fixed
- **`noir doctor` no longer reports a stale host list.** The host check is now adapter-driven (`resolveAdapter(host)` + each adapter's `agentsMdPath`/`mcpConfigPath`/`skillsDir`), so the expected-artifacts list matches the configured host exactly.

### Deferred (documented in `docs/roadmap/` §v1.x backlog)
- `qwen` and `agy` adapters (the universal `AGENTS.md` covers them in the meantime).
- Multi-host emit (`hosts:[...]` → emit for several hosts at once). v1.x is single-host select.

---

## Unpublished 1.1.0-beta.1 work (2026-07-25)

**v1.x capabilities ship on the beta channel.** All 6 v1.x capability slices (**K/R/I/P/S/X**) are done on `develop`, plus a consolidated debt batch. Cut from `develop`; `release.yml` derived `channel=beta` from the tag living on `develop`. **11 packages** (added `@noir-ai/create`); **966/966 tests** (was 729 at 1.0.0-beta.1); build / typecheck / lint (0 warnings) green. Design record: `docs/internal/specs/2026-07-25-v1x-capabilities-design.md` + per-slice specs in `docs/internal/specs/`.

The 6 v1.x capability slices extend one keystone refactor (`managedBlock` + shared `blockWriter` + `HostAdapter` emitters):
- **K** Keystone — `managedBlock(name, commentStyle)` factory + shared `blockWriter` (`writeManagedRegion`/`readManagedBlock`/`stripManagedBlock`/`commentStyleFor`) + `HostAdapter.emitRules` seam (pure refactor).
- **R** Rules — `.noir/rules/RULES.md` Noir-curated seed wired into `CLAUDE.md` via `RULES_BLOCK`; `noir-rules` skill.
- **I** Ignore — `IgnoreManager` + `syncIgnores` into init/sync (managed-block idempotent across `.gitignore`/`.dockerignore`/`.npmignore`/`.prettierignore`).
- **P** PRD — `prd` artifact kind + `writePrd`/`readPrd` + `noir-prd` skill (no FSM change; explicit opt-in).
- **S** Scaffold — **new `@noir-ai/create`** package: three-mode writer (`regenerate`/`managedBlock`/`skipIfExists`) generalizing keystone-K `blockWriter`; declarative manifest; hand-rolled `{{var}}` templates; `.noir/scaffold-version`; migrations registry (inline-conflict, CI-safe); read-only stack-detect. CLI: `noir init`/`sync` refactored to consume the engine; **new `noir create [dir]`** (AI-layer only); `noir init --upgrade` (migrations); `noir doctor` scaffold-version drift. *Behavior changes (see §Behavior changes below).*
- **X** Integration — first-class integration layer (skill-only default + gated-write-proxy tier + full-runtime tier). First integration = **ClickUp**: `noir-clickup` skill (5-flow playbook + real `references/`) + `integration.json` (`runtime:'gated-write-proxy'`). `discoverIntegrations()` + `integration.json` Zod schema (the deferred **K3**); `discoverAll()` emits builtins+integrations (skill pack now **34** = 33 builtins + 1). Daemon `integrations_auth` MCP tool (resolves `CLICKUP_API_TOKEN` server-side at call time — kills the non-interactive-shell gotcha) + `noir_clickup_write` gated-write-proxy (**HARD confirm gate** dry-run→confirm→POST; allowlisted endpoints only; id-charset validation; 429 `X-RateLimit-Reset` backoff; audit JSONL to `.noir/audit/`). Core `integrations` config block (`runtime` downgrade honored); adapter `emitMcpConfig(ctx, opts, integration?)` overload.

### Added — debt batch (v1.x backlog resolved)
- **R4** core `rules:{enabled,lengthBudgetKb:6}` config block. **R5** `noir doctor` RULES.md budget check (warn >6 KB / >150 lines).
- **P3** `@noir-ai/model` `draftPrd(intake, clarify, memory)` (offline → 9-section template; `null` on no-provider/failure — graceful degradation). **P4** `prd:{mandatoryFor:[feature,epic]}` config + `advance()` SOFT ESCAPABLE PRD gate (observable in audit; never hard-blocks; `--force <reason>` escapable; quick-mode skips).
- **W1** workflow dual source of truth collapsed — `audit:<id>` KV authoritative, `task.history` now a derived view (single timestamp; drift gone). **W2** checkpoint wired to `writeAuditExport` (was vestigial; MCP tool contract preserved). **W3** S4 nits (`setBlocked` non-empty, jump no-op guard, `GateResultInput`/`GateResult` type split) + FSM coverage.
- **C1** kNN-only-hit snippet hydration + honest `mode:'knn'` (new `Indexer.readChunkContent`).
- **T2** stale-skill-dir cleanup on `noir sync` (prunes `.claude/skills/noir-*` not in the current pack).
- **T1** `tsconfig.test.json` **pilot** on `@noir-ai/cli` (typecheck now covers `test/`; 8 surfaced errors fixed; the other 9 packages remain `src`-only — documented follow-up).
- **Lint:** 10 pre-existing warnings → 0.

### Security — Slice X
Opus adversarial review (no CRITICAL; all IMPORTANT fixed + tested): confirm gate is HARD (no write without `confirm:true`; zero fetch on dry-run — asserted); token resolved at call time only, never logged/leaked (canary-tested on success + error paths); allowlist + id-charset enforced on every path-segment id (including config-derived); 429 backoff single-retry; audit JSONL one-line-per-executed-write. Fixed post-review: batch create-task `assignee`→`assignees` (plural — was silent data loss with `success:true` audit) + config `runtime:'none'` downgrade honored at registration (was inert). **Live-verified**: token resolves, `GET /user` → HTTP 200. CI stays cassette-only (no real network).

### Fixed (found in pre-release verification)
- **`noir doctor` no longer reports a CRITICAL store failure on a fresh project.** The store DB is created lazily on first daemon run, so a brand-new project (bare `noir init`/`create`, daemon never started) showed "1 critical check failed" + exit 1 on its first `noir doctor`. Now the store check **warns** ("not created yet — created when the daemon first runs") when the DB is absent on an otherwise-initialized project; only an existing-but-unopenable DB is a `fail`. Fresh-project `noir doctor` now exits 0.

### Behavior changes (Slice S — spec-aligned latent-bug fixes)
- `.noir/project.id` + `.noir/config.yml` → `skipIfExists` (predecessor `noir init` overwrote on every run — `project.id` overwrite orphaned the store DB named after it). Re-init now preserves both.
- `.noir/NOIR.md` → managed `BRIEF_BLOCK` markers (predecessor wrote the whole file with no markers). First-run output gains markers; user notes outside markers survive re-runs. A legacy pre-Slice-S unmarked `NOIR.md` is self-healed on the next `noir init`.
- `.noir/scaffold-version` (`noir-scaffold=1.0.0`) stamped on `noir init`/`create`.
- `noir sync` widened: re-emits `.mcp.json` (regenerate) + the NOIR.md brief (managed) + CLAUDE.md blocks + ignore files; no longer seeds `RULES.md` (init owns seeds).

### Deferred to a later beta (documented in `docs/roadmap/` §v1.x backlog)
Embedding-model upgrade (`bge-small-en-v1.5` — needs a model-version stamp + re-index-on-change mechanism); S10 multi-host adapters; daemon detach/socket-activation/auth; full-screen TUI; in-process read-only store fallback; tree-sitter chunking; trigram tokenizer; full `.gitignore` parsing; graph/temporal KG; OS keychain; prompt caching; streaming (D5-forbidden); the `tsconfig.test.json` rollout to the remaining 9 packages; and the smaller S1/S5 micro-items.

---

## 1.0.0-beta.1 (2026-07-25)

**First npm publish.** All 10 `@noir-ai/*` packages (`core, store, workflow, skills, daemon, adapters, cli, context, model, memory`) published at the unified version `1.0.0-beta.1`, dist-tag **`beta`**, each tarball carrying SLSA **provenance**. Consumable via `npx @noir-ai/cli@beta init`. Cut from `develop`; `release.yml` derived `channel=beta` from the tag living on `develop`.

### Fixed — CI release flow
Five integration fixes that took the publish job from red to green (documented in `docs/releasing.md` §8 Troubleshooting so they don't recur):
- **pnpm version conflict** — `pnpm/action-setup`'s default didn't match the repo's `packageManager` pin; install the pinned pnpm explicitly (version from `packageManager`), not the action's default.
- **build-before-typecheck ordering** — build now precedes typecheck so generated `dist/` + `.d.ts` outputs exist when typecheck reads them.
- **`pnpm pack --pack-destination`** — pack writes `.tgz` files into one known directory the publish step can locate (was scattering them).
- **`npm publish "./<tgz>"` path** — publish targets the packed tarball path, not a directory or a bare `npm publish` (which would miss the workspace-range rewrite `pnpm pack` does).
- **vitest major-bump test re-verification** — the `^3` bump (see Security) is a major; full suite + assertions re-checked, test invocation not assumed unchanged.

### Security
- **`pnpm audit` 8 → 0**, cleared via `pnpm.overrides` (`sharp`, `hono`, `esbuild`, `vite`) and bumping `vitest` to `^3`. Transitive dedupe only; no source changes.

### Changed
- **`noir --version` / `noir --help` → stdout** (were stderr) — data on stdout, diagnostics on stderr, matching the S9 convention.
- **CI actions → v7/v6, Node 24** — `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6` (clears the Node-20 deprecation annotation).

Beta targets early testers; promote to stable `1.0.0` once validated in a real project (merge `develop`→`main`, tag `v1.0.0` on `main` → CI publishes `--tag latest`).

---

## v1.0 — release-ready (2026-07-25)

**v1.0 ACCEPTANCE-COMPLETE.** **10 packages** `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory}`; **729/729 tests green** (was 142 at the skeleton); build / typecheck / lint green. All committed locally on `develop` (**not pushed**).

**What shipped (S6–S9 + the skeleton S0–S5):**
- **S6 Context** — embedded hybrid retrieval: local in-process MiniLM embeddings + BM25 ∪ kNN fused by Reciprocal Rank Fusion.
- **S8 Model** — thin single-shot model library (`anthropic` / `openai` / `openai-compatible`); first-class `null` degradation; agent loops impossible by construction (no `tools`/`stream` on the request).
- **S7 Memory** — cross-session memory layered on the store (no schema migration); explicit-save default + opt-in Claude Code hooks template; append-only consolidation gated on the `memory.consolidation.enabled` master switch (never a silent paid call).
- **S9 CLI/TUI** — commander command tree + `@clack/prompts` home; stable exit codes; `status` probe-only (works daemon-down); every capability reachable from one shell entry point.
- Plus **S0–S5**: walking skeleton (stdio + daemon Streamable HTTP), S1 stores (SQLite + FTS5 + sqlite-vec), S4 SDD workflow engine, S5 builtin skills + compiler (**31 skills** = 19 full + 12 stub).

**End-to-end dogfood — PASSED 14/14:** real local embeddings → `context_search` hits; memory save→recall; workflow start→advance; durability across daemon restart; bounded-model degrades to `null` with no key.

**Finalization cleanups applied:** zod consolidated to **v4**; root **README rewritten** for the v1.0 toolkit; dead code + unused deps removed; biome / mcp-config / content-hash / jsdoc / re-export nits fixed.

All MVP v1.0 acceptance criteria met. **Next: cut the v1.0 release (publish / tag).** Deferred items are consolidated in the **v1.x backlog** in `docs/roadmap/` (S10 more hosts, S11 distribution/SDK, plus per-area debt lists — daemon, CLI/TUI, context, memory, model, toolchain).

---

## S9 — CLI/TUI home screen (2026-07-25)

**Release-ready. v1.0 FEATURE-COMPLETE (S6–S9 done).** 729/729 tests green (was 501); build / typecheck / lint green. All on branch `develop`, local (not pushed). NO new package — the existing `@noir-ai/cli` was overhauled (total stays 10 packages).

### Added
- **Commander Command tree** replacing the hand-rolled `parseArgs` dispatcher (behavior-preserving: `init` / `sync` / `mcp serve` / `daemon start|stop` / `doctor` unchanged; the Gate-1 stdio subprocess test still passes). `exitOverride` + `configureOutput` so the process never `exit()`s mid-test and help/errors go to stderr.
- **Global flags** `--json` / `--no-input` / `--quiet` / `--verbose` / `--cwd` parsed in any position.
- **Stable exit codes:** 0 ok · 1 error · 2 usage · 3 not-found · 4 daemon-down · 5 cancelled. **Data → stdout, diagnostics → stderr.** `isInteractive()` gates every prompt (no hangs in CI / pipes / scripts).
- **Interactive home:** bare `noir` → `@clack/prompts` menu when TTY; `status` (human) when non-interactive; `status --json` under `--json`.
- **Commands:** `status` (probe-only — works daemon-down), `context {search,index,status}`, `memory {recall,save,sessions,forget,consolidate}`, `skills {list,sync}`, `task {new,status,advance,next}`, `daemon {start,stop,status,restart}`, `doctor` (config / store / embedder / native-deps / provider-status via `resolveModelConfig` — NO live model call).
- **Store-touching commands are MCP clients to the daemon** (`ensureDaemonRunning` + `@modelcontextprotocol/client` over HTTP).
- **New daemon MCP tools** `workflow_start` + `workflow_advance` (gated `ctx.engine`) backing `task new` / `advance`.
- **New runtime deps:** commander, @clack/prompts, picocolors, cli-table3, ora, @modelcontextprotocol/client.

### Changed
- `status` is now **probe-only**: it reports daemon state honestly and NEVER auto-starts a daemon (works daemon-down: exit 0, `daemon:{running:false}`). Active commands (`context *`, `memory *`, `task *`) still start/require the daemon for v1.
- Bare `noir` in a non-interactive context now dispatches to `status` (was `printHelp`).
- `daemon --detach` is foreground-honest: it returns exit code 2 ("not implemented, tracked v1.x") rather than pretending to background.

### Fixed
- Opus final review (2 CRITICAL + 2 IMPORTANT — ALL FIXED + tested):
  - **C1 (silent daemon auto-start):** `status` no longer starts a daemon as a side effect of probing — it is read-only and reports daemon-down honestly.
  - **C2 (`--json` daemon-down envelope):** emits a single clean JSON envelope (was doubly-encoded — the error wrapper was itself JSON-stringified).
  - **I1 (`task new`/`advance` were permanent stubs):** now wired end-to-end via the new `workflow_start` / `workflow_advance` daemon MCP tools (gated `ctx.engine`).
  - **I2 (bare `noir` non-interactive):** runs `status` instead of `printHelp`, so scripts / pipes get a real machine-readable snapshot.

### Known v0 debt (deferred)
- Full-screen Ink/blessed TUI — v2 (S9 ships a `@clack/prompts` menu, not a full-screen TUI).
- Backgrounded daemon detach / socket-activation — v1.x (`daemon --detach` honestly returns exit 2 for v1).
- In-process read-only store fallback for `context *` / `memory *` / `task *` — daemon-required for v1; `status` is the only probe-only command.
- `task` id/slug distinction collapsed to slug for v1 (single namespace).

## S7 — Memory management (2026-07-25)

**Release-ready.** 501/501 tests green (was 340); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/memory`** (10th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory}`). Cross-session memory layered **ON TOP of the store — no schema migration.**
- **Observations** via `indexDoc({source:'memory'})` (FTS5) + `upsertVec({source:'memory'})` (sqlite-vec, 384-dim) + KV `memory:obs:<id>` (authoritative full row) + `memory:sessions` / `memory:index` rollups. Dev-flavored open-enum taxonomy: `pattern | preference | architecture | bug | workflow | fact | decision | lesson` (`lesson` reserved for consolidation output; unknown values accepted + stored).
- **`save` / `recall` / `search` / `sessions` / `forget` / `consolidate`.** Recall **reuses S6's hybrid retrieval**: store `searchFt` + `knn` scoped to `source:'memory'` → `fuseRrf` (Reciprocal Rank Fusion, k=60 — imported from `@noir-ai/context`) → cheap regex entity-boost (identifiers / paths, no LLM) → hydrate FULL content from KV (never truncated, blueprint §9). BM25-only degraded fallback when no embedder.
- **Daemon:** resolves the embedder ONCE and passes the same `EmbedFn` to both `ContextEngine` and `MemoryEngine`; new `packages/daemon/src/memory-seam.ts`. 5 MCP tools (`memory_save` / `memory_recall` / `memory_search` / `memory_sessions` / `memory_forget`) + conditional `memory_consolidate`, all gated on `ctx.memory` (mirrors `ctx.store` / `ctx.engine`).
- **Consolidation:** append-only, explicitly-invoked job consuming S8 `complete()`. Emits derived `type:'lesson'` with `provenance:[ids]`; originals never mutated or deleted (reversible + auditable).
- **Config:** new `memory:` block in `NoirConfigSchema` (`consolidation:{enabled, provider?, model?, types?}`); `resolveMemoryConfig` bridge (pure projection; no core→memory import cycle) wired through the daemon.
- **Capture:** explicit-save is the default; a host-neutral `CaptureEvent` type + an **OPT-IN** Claude Code hooks template (a doc/settings snippet the user installs; NEVER auto-wired, never silent).
- **2 new builtin skills** `noir-recall` + `noir-remember` (skills pack now 31 = 19 full + 12 stub).

### Changed
- Consolidation capability is gated on the user's `memory.consolidation.enabled` master switch (NOT on `model.defaultProvider`); `enabled:false` ⇒ `memory_consolidate` tool unregistered + `consolidate` refuses `{ok:false, reason:'no-provider'}` with no model call — regardless of other model config.
- The daemon constructs a single shared embedder for context + memory (was: context-only).

### Security
- Opus final review (1 CRITICAL — FIXED + tested; all other blueprint D6 hard rules clean). **CRITICAL:** consolidation was initially gated on `model.defaultProvider`, which left a path to a silent paid LLM call (blueprint §9 anti-pattern). Now gated on the explicit `memory.consolidation.enabled` master switch — `enabled:false` refuses with no model call before any provider resolution. Verified by a no-provider test asserting zero model invocation. Remaining D6 rules clean: in-process only, `ProjectId`-scoped (never a fs path), KV authoritative, never-truncated recall, single-flight, append-only consolidation, no sidecar / external server.

### Known v0 debt (deferred)
- Graph expansion / temporal knowledge graph (Zep / Graphiti-style entities + edges) — v1.x; needs an extraction LLM + graph storage.
- LLM auto-tagging (`concepts` / `type` on save) — v1.x; would be another silent LLM touch.
- Auto-capture-by-default — **opt-in hooks template only**; never auto-wired.
- Auto-install of the Claude Code hooks template (today the user copies the snippet manually).
- Multi-user / org scoping (per-user memory namespaces) — v1.x; v1 is solo power-user.
- Remote sync / cloud memory — never default (violates D6 local+free); a remote *embedding* provider is already opt-in via S6.

## S8 — Bounded model layer (2026-07-25)

**Release-ready.** 340/340 tests green (was 247); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/model`** (9th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model}`). A thin single-shot model **library** — zero MCP tools; consumed in-process by S4 / S7 / S9.
- **`complete(req, cfg)` → `string | object | null`:** one function, 3 adapters (`anthropic` via `@anthropic-ai/sdk` Messages; `openai` via the openai SDK; `openai-compatible` via global `fetch` POST `${baseURL}/chat/completions`, covering Ollama / LM Studio / vLLM with zero extra dep). All adapters use dynamic `import()` + structural typing — import-isolated: a bundle that never selects an adapter ships zero SDK bytes.
- **Structured output:** prompt-based JSON + validate (Zod `.parse` or a caller-supplied function) + at most ONE repair retry (the only retry in the layer).
- **First-class `null` degradation:** no provider ⇒ `null`; missing key ⇒ `null` / `{ok:false}` BEFORE the SDK client is constructed. Full test suite runs offline/free.
- **`model:` config block** on `NoirConfigSchema` (`defaultProvider`, `tiers` draft/title/summarize/consolidate, `providers{name:{model, baseURL?, apiKeyEnv?}}`); `resolveModelConfig` bridge in `@noir-ai/model` (pure projection; no core→model import cycle; stores the env-var NAME, reads the value at call time).

### Changed
- Agent loops are impossible by construction: the `complete` request type has NO `tools` / `stream` parameter (compile-time-enforced).
- Provider resolution is EXPLICIT-only: resolved solely from `req.provider || cfg.defaultProvider`; NEVER inferred from env-var presence; no explicit configured provider ⇒ `null`. The Anthropic/OpenAI SDKs' own env-var fallback can therefore NEVER trigger a paid call.
- SDK `maxRetries: 0` everywhere; transport failures are not retried (the JSON-repair retry is the only retry).

### Security
- Opus final review (0 critical; all blueprint D5 hard rules clean; 2 IMPORTANT — all fixed + tested): (1) `openai-compatible` error `reason` no longer embeds the raw response body (was a prompt/key leak risk on echoing endpoints — NFR-4); (2) the OpenAI adapter now forwards `req.signal` + `maxRetries:0` (bounded wall-clock — NFR-3).

### Known v0 debt (deferred)
- Streaming; tool-calling / agent loops (forbidden by D5 design).
- OS keychain (secrets via env for now).
- Prompt caching (Anthropic `cache_control`).
- Provider-native JSON strict mode (OpenAI `response_format: strict` / Anthropic forced-tool).
- `onUsage` usage sink (fires on success; `noir doctor` wiring deferred).
- Consumer wiring — S4 artifact drafting, S7 consolidation, S9 home help wire `complete()` when consumed; S8 provides the library + config only.
- Real-SDK export-shape drift is unverifiable under offline (fixture-based) CI.

## S6 — Context management (2026-07-25)

**Release-ready.** 247/247 tests green (was 142); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/context`** (8th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context}`). Embedded hybrid retrieval engine that fills S1's declared-but-unused `EmbedFn` seam.
- **Embeddings:** local in-process embedder via `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` (384-dim → zero `vec0` migration), loaded lazily through a dynamic import, L2-normalized; model cache at `~/.noir/models/`. Remote (OpenAI / Voyage / Cohere via Matryoshka-384) and Ollama embedders are opt-in and provider-explicit — never the default, never silent.
- **Indexer:** SHA-256 content-hash incremental tracking (on-demand by default; `--watch` opt-in). Markdown-heading chunker for docs; line/token-bounded (~512 tok / 64 overlap) chunker for code. Index-time identifier explosion for BM25 under the `porter` unicode61 tokenizer.
- **Hybrid retriever:** BM25 ∪ kNN fused by Reciprocal Rank Fusion (k=60, rank-based, no score normalization) → token-budget fill → FTS5 windowed snippets (never truncated). BM25-only degraded mode when an embedder is unavailable.
- **MCP tools:** `context_search`, `context_index`, `context_status`, gated on a new `ctx.context` ServerContext service (mirrors `ctx.store` / `ctx.engine`). New `context:` config block on `NoirConfigSchema`; new `packages/daemon/src/context-seam.ts`.
- **Builtin skill `noir-context`** (skills pack now 29 = 17 full + 12 stub).

### Changed
- `Store` interface + impl: added `deleteDoc` / `deleteVec`. New exported `vecAvailability()` native-binary probe centralizes the better-sqlite3 / sqlite-vec availability check (other packages' tests use it instead of importing those natives directly).

### Security
- Opus final review (0 critical, 3 IMPORTANT — all fixed + tested): (1) sensitive-file denylist (`.env`, `*.pem`, keys never indexed); (2) path confinement (rejects `..` / out-of-root traversal); (3) single-flight serialization of concurrent index calls (no orphaned vectors).

### Known v0 debt (deferred)
- Full `.gitignore` parsing (a denylist ships today).
- Tree-sitter symbol-aware code chunking (line/token chunking ships today).
- kNN-only-hit snippet hydration (currently an empty snippet, reported as `mode:'hybrid'`).
- `--watch` full daemon wiring.
- Remote embedding provider SDK completion (current stubs).
- First-run model download (~22 MB, one-time, cached) surfaces an unsupervised network fetch.
