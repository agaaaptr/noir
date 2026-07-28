# Noir — Discovery: Idempotent Scaffold, Conflict Resolution & AI-Native TUI

**Date:** 2026-07-26 · **Status:** DISCOVERY / PRE-SPEC — **no implementation in this session.** Awaiting the batched clarifications in §7.
**Scope:** read-only investigation + research only. No code changed, no commit made.
**Method:** 8-agent read-only workflow (`noir-scaffold-tui-discovery`, run `wf_04b1c15f-3b9`): code root-cause audit → adversarial verify → reference-project inspection (read-only, no checkout) → 5 parallel web-research threads (idempotent-scaffold/migration, conflict-resolution UX, TUI libraries, AI-CLI TUI patterns, terminal banners). Per-agent results + full annotated source lists are in the workflow journal: `…/subagents/workflows/wf_04b1c15f-3b9/journal.jsonl`.

---

## TL;DR — five findings that correct the brief's premises

1. **The `noir init` duplicate bug IS REAL and is now root-caused** (this **corrects** the initial code-only audit, which wrongly said "not reproducible"). Re-running `noir init`/`create` while the working directory **is `.noir/`** (or inside it) scaffolds a **nested second project**: `.noir/.noir/` with a *fresh* `project.id`, plus `.noir/CLAUDE.md`, `.noir/.claude/skills/`, `.noir/.mcp.json`. Cause: `resolveProjectId()` (`packages/create/src/scaffold.ts:265–276`) mints a brand-new id whenever `<root>/.noir/project.id` is absent, and **nothing guards against `root` being (or being inside) a `.noir/` directory**. **Reproduced on-disk** in the reference project (two `.noir/` dirs, two project.ids `b8b58b86…` and `82ebfbad…`). The earlier "not reproducible" verdict was a *method error*: it only considered re-init at the same valid root (which IS idempotent), it inspected git rather than the filesystem (`.noir/` is untracked), and it missed nested re-init.
2. **The *real* problems are different and smaller** — see §1.3: (a) `regenerate` mode **silently destroys user edits** to `.mcp.json` / `AGENTS.md` (destructive overwrite, not a duplicate); (b) **no "already-initialized" guard** on `noir init`; (c) **no content-hash** dedup and **no three-way merge** for managed regions (hand-edits inside a `<!-- noir:* begin -->` block are overwritten); (d) **no interactive conflict menu**.
3. **`noir spec / prd / roadmap / rules / generate` are not CLI commands** — they are *skill names* (markdown playbooks the **host agent** runs). Noir's only file-generating CLI surface today is `init` / `create` / `sync` (all via the scaffold engine) + `context index` (into the store) + skill-emit (`.claude/skills/`). Topic #2's premise needs reframing (§2.1).
4. **The full desired TUI layout is achievable WITHOUT relaxing any locked rule** via **Archetype B — an orchestrator TUI** that spawns the host CLI (e.g. `claude -p --output-format stream-json`) as a subprocess and renders its structured event stream (the Goose 2.0 / Claude Agent SDK pattern). Archetype A (Noir runs its own model + tool loop) **violates D5 + BYO-agent** and is identity drift. §3.
5. **Your reference project exposes gaps Noir's current detection cannot catch** — pre-existing cross-file duplication, intra-file duplication, and competing stores (§4). The exact "duplicated block within one file" pattern you report for `noir init` is visible there (CLAUDE.md lines 24 & 26).

---

## 1. Topic 1 — Idempotent Project Scaffold

### 1.1 Current behavior (audited, file:line)

All three commands route through one engine: `scaffold()` in `packages/create/src/scaffold.ts`, driven by the declarative manifest in `packages/create/src/manifest.ts`. Exactly three write modes (`scaffold.ts:89–96`):

| Artifact class | Mode | Files | 1st run → 2nd run |
|---|---|---|---|
| **Seeds** | `skipIfExists` | `.noir/project.id`, `.noir/config.yml`, `.noir/rules/RULES.md` (`manifest.ts:149–173`) | created → **preserved** (`writers.ts:187–193` `existsSync` guard) |
| **Managed single-region** | `managedBlock` | `.noir/NOIR.md` BRIEF_BLOCK, `.*ignore` IGNORE_BLOCK (`manifest.ts:162–203`) | region written → **strip-and-replace the named region** via `writeManagedRegion` (`block-writer.ts:47–57`); byte-idempotent post-I1 |
| **Regenerated** | `regenerate` | `.mcp.json` (claude, `manifest.ts:350–359`), `AGENTS.md` (agents-md/cursor/opencode, `281–287`) | atomic tmp+rename **overwrite** (`writers.ts:56–94`) → **overwritten with identical bytes; user edits LOST** |
| **Skills** | emit | `<name>/SKILL.md` per builtin/integration (`compiler.ts:207–216`) | overwrite same paths; stale `noir-*` pruned (`compiler.ts:234–286`) |

**Command differences:**
- `noir init` (no `--upgrade`): `emitRuntimeOnly=false` (`scaffold.ts:148`) → emits **all** entries incl. seeds (seeds protected by `existsSync`). Stamps `.noir/scaffold-version` **last** (`scaffold.ts:228–230`). **No "already initialized" guard** (no early return).
- `noir init --upgrade`: runs migrations only if `fromVersion != null` (`scaffold.ts:138`); `emitRuntimeOnly=true` → runtime subset only, leaves seeds untouched; re-stamps version.
- `noir create`: like init; `mkdir root` first (`scaffold.ts:106–108`); preserves a pre-existing valid `project.id` (`scaffold.ts:270`). No guard against an already-initialized dir.
- `noir sync`: throws if no valid `project.id` (`scaffold.ts:273–275`); `emitRuntimeOnly=true`; **does not** stamp scaffold-version (gated to init/create).

### 1.2 Root-cause verdict — **CONFIRMED REAL (post user-evidence, supersedes the initial audit)**

**`duplicateBugReal = yes` — via nested re-init.** After the user pointed at the real project's filesystem (which the initial git-only audit never inspected), the duplicate is concrete and reproducible on **1.2.0-beta.2**:

- **Two nested `.noir/` dirs** in `<project>`: the correct `<project>/.noir/` (project.id `b8b58b86…`) and a nested `<project>/.noir/.noir/` (project.id `82ebfbad…`, **different** id, + a `store/`).
- The nested run also emitted host artifacts into `.noir/` as if it were a root: `<project>/.noir/CLAUDE.md`, `<project>/.noir/.claude/skills/noir-*`, (`.noir/.mcp.json`).

**Mechanism (code-confirmed):** `resolveProjectId()` in `packages/create/src/scaffold.ts:265–276` returns a **fresh** `createProjectId()` whenever `opts.projectId` is unset and `<root>/.noir/project.id` is absent — and there is **no guard** that `root` not be (or not be inside) a `.noir/` directory. `noir init` sets `root = --cwd ?? process.cwd()`; `noir create` sets `root = resolve(dir ?? process.cwd())` (`create.ts:56`). So any invocation whose cwd/target is `.noir/` builds a brand-new project *inside* the existing one. Repeated runs compound the nesting.

**How the initial audit got it wrong (lessons):** (1) it reasoned only about re-init at the *same valid root* — which genuinely IS byte-idempotent (skipIfExists seeds, strip-and-replace managed regions); (2) the reference-project agent used `git ls-tree`, which cannot see `.noir/` because it is **untracked and not gitignored**; (3) neither considered the root-mistargeting failure mode. The intra-file duplication noted at §4-Cluster-2 is a *separate* real issue but is NOT the reported "duplicate directories" bug.

→ **Fix is well-scoped** (§1.4 #1): a root-safety guard that refuses to scaffold when `root` is or is inside a `.noir/` directory, plus an "already-initialized" guard for `noir init`. The three-mode writer itself does not need to change.

### 1.3 What's already covered vs. gaps

**Covered:** re-run detection (seeds), scaffold versioning (`.noir/scaffold-version`), migration-on-upgrade (versioned, semver-windowed, ordered, non-throwing with inline git-style conflict markers — mirrors Angular `ng update`), corrupt-stamp self-heal (C1), legacy-NOIR.md heal (I2), atomic per-file writes (tmp+fsync+rename), `dryRun` for `noir doctor`. This is **ahead of** `create-next-app`, `degit`, `plop`, `cookiecutter`, and `yeoman` out of the box.

**Gaps (the real work):**
- **G-1 Destructive `regenerate` overwrite** — user edits to `.mcp.json` / `AGENTS.md` are silently lost on re-init/sync. (These are pointer/config files, so "regenerate" is defensible — but it should be *announced*, not silent.)
- **G-2 No "already-initialized" guard** — `noir init` in an initialized dir should short-circuit or prompt, not silently re-emit.
- **G-3 No content checksum on managed regions + no three-way-merge baseline** — the single biggest gap vs the state-of-the-art (**Copier**). `managedBlock` is **strip-and-replace**, not merge: a hand-edit *inside* a `<!-- noir:* begin -->` block is overwritten. Copier's prerequisite is storing the answers + last-applied commit (`.copier-answers.yml`); Noir stores only a version string in `.noir/scaffold-version`.
- **G-4 No content-hash dedup** — the cheap, zero-false-positive tier (Yeoman's "identical" check) is missing.
- **G-5 No rollback** on partial/failed/interrupted scaffold (atomic per-file exists, but no whole-scaffold transaction + restore).

### 1.4 Recommendation — idempotent scaffold hardening

Keep the three-mode model; harden it.

**★ Fix #0 — root-safety guard (the actual duplicate-bug fix).** Before scaffolding, refuse if `root` is — or is inside — a `.noir/` directory (walk the ancestors; if `root` or any ancestor is named `.noir`, abort with: *"refusing to scaffold inside `.noir/`; run from the project root"*). Add a `noir doctor` check that detects an existing nested `.noir/.noir/` and offers cleanup. This single guard eliminates the reported duplication; the three-mode writer itself is unchanged.

Then the idempotency hardening:

1. **Already-initialized guard.** `noir init` detects `.noir/scaffold-version` (or `project.id`) → if present and version is current, no-op with a clear message; if older, offer `--upgrade` path (migrations). Gate behind `--force` for explicit re-scaffold.
2. **Non-destructive-by-default `regenerate`.** Before overwriting a `regenerate` file whose content differs from the template, content-hash compare: identical → skip silently; differing → in TTY show a diff and offer the conflict menu (§2.4); in non-TTY/CI preserve the existing file and emit a warning (unless `--force`).
3. **Content-hash dedup everywhere** (deterministic, CI-safe) — the "identical" tier.
4. **Three-way merge for managed regions (opt-in, larger).** Store a **"last-emitted ancestor" snapshot** per managed file in `.noir/` (or recover from git) so a true base/ours/theirs merge is possible instead of strip-and-replace. This is the Copier-level capability and unblocks the `Merge` conflict-menu option.
5. **Atomic whole-scaffold + rollback.** Stage writes to a temp manifest; on any failure, restore the pre-scaffold snapshot of touched files.
6. **`--dry-run` / diff preview** as a first-class flag (the `noir doctor` dryRun path already exists to extend).

---

## 2. Topic 2 — Duplicate Detection & Conflict Resolution

### 2.1 Corrected scope (the file-generating surface)

| Surface | What it writes | Today's protection |
|---|---|---|
| `init` / `create` / `sync` (scaffold engine) | `.noir/*`, host context files (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md`), `.*ignore`, `.mcp.json`, skills | three-mode writer (§1) |
| `context index` | into the store (`.noir/store/*.db`), not project files | content-hash incremental indexer (S6) |
| skill-emit (`skills sync`) | `.claude/skills/noir-*/SKILL.md` | overwrite same path + prune stale |
| **`spec` / `prd` / `roadmap` / `rules` / `generate` / `task` / `memory`** | — | **these are skills the host agent runs, not Noir CLI commands.** Noir CLI does not generate those artifacts. |

So "consistent duplicate-detection across all file-generating commands" really means: **the scaffold engine + skill-emit**, plus an open question of whether some of those skills should *become* CLI commands (§7 Q3).

### 2.2 Detection-strategy comparison

| Strategy | What it catches | Cost | Fit for Noir |
|---|---|---|---|
| Marker/managed-block (have it) | region-level, files Noir owns | low | ✅ core |
| `skipIfExists` (have it) | write-once seeds | low | ✅ core |
| **Content-hash** (missing) | **exact** duplicates, "identical" files | low, deterministic, CI-safe | ✅ **add everywhere** |
| Manifest + scaffold-version (have it) | Noir-emitted lineage | low | ✅ core |
| **Three-way merge baseline/ancestor** (missing) | divergent edits to managed files | medium (new state in `.noir/`) | ✅ **add (opt-in)** |
| **Semantic similarity** (missing, feasible) | same doc, different filename; intra-file near-dup sections | medium — **but Noir already has the full in-process stack** (all-MiniLM-L6-v2 384-dim + sqlite-vec kNN + RRF from S6) | ✅ **add as explicit, high-threshold suggestion** |
| Directory signature / fingerprint | structural dup | low | partial (stack-detect exists) |

### 2.3 Conflict-resolution UX approaches

Overwrite · skip · interactive prompt · duplicate-copy (`.1`/`.2`) · merge · rename · smart/managed-block update · diff preview · three-way merge. Trade-offs surveyed across plop, hygen, jscodeshift/codemods, Yeoman conflict-resolution, git 3-way, `@clack/prompts` / `inquirer` / `@inquirer/prompts`, Continue.dev config merge, Cursor rules update, Claude Code managed edits, Tailwind/Next codemods.

### 2.4 Recommendation — conflict-resolution UX

- **Keep non-interactive three-mode defaults** for managed/pointer files (deterministic, CI-safe, scriptable).
- **Add a `@clack/prompts` `select` conflict menu** — gated to **TTY** and to **user-authored-class files only** (never block CI):
  ```
  <file> already exists and differs from the Noir template.
  1. Replace       (discard local; write template)
  2. Update        (managed-region merge — preserve your edits outside markers)
  3. Merge         (three-way: base/ours/theirs — needs ancestor snapshot, G-3)
  4. Rename        (keep local; write template to <name>.noir)
  5. Create duplicate (<name>.1, <name>.2)
  6. Cancel
  ```
- **Non-TTY/CI default:** preserve existing + content-hash dedup + warning; `--force` to overwrite; `--no-input` already exists (S9 stable contract).
- **Semantic duplicate detection (opt-in, never auto-resolved):** reuse S6's local embedder + sqlite-vec; surface as a **suggestion at cosine ≥ 0.90** inside the menu ("this looks 94% similar to `docs/specs/X.md` — link instead of duplicate?"). High threshold = few false positives; always user-confirmed.

### 2.5 The deeper finding (from §4)

Even a perfect *per-path* conflict menu cannot detect the duplication in your reference project, because that duplication is **cross-file** (CLAUDE.md ≈ AGENTS.md) and **pre-existing** (not Noir-emitted). Catching it needs the **semantic dedup + a `noir doctor` consolidation pass** (§7 Q9).

---

## 3. Topic 3 — AI-Native Terminal User Interface

### 3.1 The crux: two archetypes (this is the biggest decision)

Research split cleanly along an architecture line that maps directly onto Noir's locked rules:

- **(A) Noir-as-runtime TUI** — Noir streams its *own* model and runs its *own* tool loop (like Claude Code / Codex / Gemini CLI / Aider / Cursor). **Fits Noir: POOR.** Directly **violates D5** (model layer never runs a tool/exec loop) and the **BYO-agent** philosophy. This is a *strategy change*, not a feature — identity drift.
- **(B) Orchestrator TUI** — Noir **drives the host CLI as a subprocess and renders its structured event stream**; Noir stays the brain, host stays the muscle. **Fits Noir: STRONG.** Decisive precedent: **Goose 2.0** (its new TS TUI is an ACP *client* over a separate `goose-server`). Canonical contract: **Claude Code headless** — `claude -p --output-format stream-json --verbose --include-partial-messages` emits `system/init`, assistant text deltas, `tool_use`, `tool_result`, `api_retry`, and a terminal result with `cost/usage/session_id` — purpose-built for an external program to spawn it and re-render. (This is exactly what the **Claude Agent SDK** does internally, and exactly what Noir's roadmap v2 line already says: *"Programmatic headless driving of host CLIs from the TUI."*)

**Layout-region deliverability matrix** (your proposed layout vs the two archetypes):

| Region | A (relax D5) | B (no arch change) |
|---|---|---|
| Banner | ✅ | ✅ |
| Workspace status | ✅ | ✅ (+ shows detected host) |
| **Streaming response** | only by relaxing D5 | ✅ **host text deltas** |
| **Tool-execution viz** | only by building a D5-violating tool loop | ✅ **host tool_use/tool_result** |
| Active goal / current spec | ✅ | ✅ (**Noir's unique value-add**, archetype-agnostic) |
| Prompt | ✅ | ✅ (forwards to host stdin) |
| **Status bar (model/tokens/cost)** | only by Noir tracking its own tokens | ✅ host result+system/init |

**Score: B delivers 7/7 regions without an architecture change; A delivers 3/7 only after relaxing D5 — and is identical to B on the one region that matters most (active-goal/spec).** → **Recommendation: Archetype B.**

### 3.2 Library recommendation — **Ink 7.x** (+ `pastel`), keep `@clack/prompts`

- **Ink is actively maintained:** v7.1.1 published 2026-07-16 (8 releases Apr–Jul 2026), peer-dep **React ≥ 19.2.0**, stewarded by Vadim Demedes + Sindre Sorhus. It is the **de-facto render layer behind Claude Code, Gemini CLI, Qwen Code, and Codex** (shared React + TS + Ink stack).
- **Two real risks to plan for:** (1) Ink's default re-render **flickers on long-lived streaming output** — Claude Code rewrote its renderer (alt-screen/fullscreen diff-render, ~85% flicker cut); Gemini CLI has the same open issue. (2) **Testing is the weak link:** `ink-testing-library` is stuck at 4.0.0 (May 2024), lagging Ink 7; budget for custom snapshot tests.
- **Rejected:** `blessed`/`neo-blessed` (dead since 2015/2018), `enquirer` (dormant since 2023). `terminal-kit` is the only credible non-React alternative (maintained 3.1.4) but lower-level.
- **Archetype B helps here:** because `@noir-ai/model` never runs a tool loop, Noir's TUI mostly **streams host stdout through a `<Static>` region** rather than re-rendering its own growing transcript every token — sidestepping the deepest part of the flicker problem.
- **Keep `@clack/prompts`** for the non-TTY menu path (S9 already uses it).

### 3.3 Layout recommendation (UX + architectural rationale)

Adopt your proposed layout, scoped to Archetype B:

1. **Banner** — static, top. (§3.4)
2. **Workspace status** — one line: detected host · project · branch · daemon · store doc/vec counts · context mode · model provider (or `null`/pure-orchestration). Sourced from `.noir/` + `@noir-ai/store`; no model call.
3. **Conversation / AI response** — the host's streamed output (B): text deltas + rendered tool calls + progress. This region is a **rendered view of the host subprocess stream**, not Noir's own model.
4. **Active goal / current specification** — **Noir's differentiator** (archetype-agnostic): the current S4 task + phase + gate state + the active spec/plan path. This is what makes Noir feel like a disciplined engineer's cockpit, not just another chat TUI.
5. **Command prompt** — forwards to the host's stdin (B); slash-commands route to Noir's command tree first.
6. **Status bar** — model · tokens · cost · session · gate indicator, all from the host's stream-json result/init events (B).

### 3.4 Banner recommendation

Consensus (best documented in GitHub's own Copilot-CLI engineering write-ups): banners are **decorative — skippable, never block startup, never reach CI/pipes/redirects**. For Noir specifically — **do not over-engineer** (your instruction):

- **Hand-rolled pre-rendered ASCII wordmark** stored as a string constant (generated once offline with figlet/toilet). Zero runtime parse cost, deterministic, **no new heavy dependency**.
- **4-bit (16-color) ANSI role coloring** via the existing `picocolors` (`packages/cli/src/output.ts`) — the *most* compatible color mode; OS accessibility tools and user themes remap these slots, so the banner respects dark/high-contrast themes instead of fighting them. Avoid truecolor/gradient (not uniform; macOS Terminal.app is 256-only).
- **Detection (layered):** honor `NO_COLOR` (non-empty) + `CLICOLOR`/`CLICOLOR_FORCE` → `isatty(stdout/stdin)` → `COLORTERM`/`TERM`/`CI`. Width from `process.stdout.columns` (undefined non-TTY → fall back to 80). Provide **three width variants** (e.g., 120 / 80 / <60 → compact text mark).
- **Accessibility:** ASCII wordmarks are graphical; skip entirely under screen-reader mode / `--quiet` / `NOIR_NO_BANNER` / non-TTY / CI. No animation, no resize re-render.
- **Aesthetic:** the noir identity comes from **restraint** — a tight block-element face ("ANSI Shadow"/"Blocks") in dim gray/white. The restraint *is* the aesthetic.

---

## 4. Topic 4 — Reference Project Validation (read-only)

**Project:** `…/svc-academic-activity-go`, branch `experiment/ai-dev-workflow` (current). **`noirDetectionAdequate = false`.** Six duplicate clusters found:

1. **Dual host-instruction files, no `@import`:** `CLAUDE.md` (444 lines) + `AGENTS.md` (56 lines) hand-mirrored (~70% conceptual overlap). *Exactly the pattern Noir's `.noir/NOIR.md` @import architecture exists to eliminate — but Noir can only enforce it for files it scaffolds; it cannot repair pre-existing overlap.*
2. **Intra-file duplication (botched append):** one sentence on CLAUDE.md **lines 24 AND 26**; ~23% of the file is one folder-name warning repeated 9×. **This is the exact failure-mode the user reports for "noir init twice duplicates."**
3. **Doc-layout policy stated 3×:** CLAUDE.md, AGENTS.md, `vibes/README.md` (the intended canonical `DOC-POLICY.md` is missing).
4. **5 overlapping stores:** `vibes/` (scratch), `workflow/` (gitignored task state), `.notes/` (gitignored), `.claude/`, `.qwen/` (`.qwen/` proves a **second host agent** was used). `noir init` would add `.noir/` as a **sixth** without any consolidation prompt.
5. **spec → plan → handoff → agentmemory:** the same knowledge copied 4× with no drift/similarity check.
6. **Stale foreign-template lineage:** a "billing/SPP service" ghost (file copy-seeded from another project) lingers as a meta-warning in both mirrors.

**Exposed gaps ( Noir cannot detect any of clusters 1/2/3/4/6 today):** cross-file semantic dedup; intra-file duplication; pre-existing competitor/peer stores invisible to `init`/`sync`; gitignored host artifacts breaking team-wide version integrity; stale foreign-template lineage; doc-pipeline dedup; and the conflict menu is gated on detection that doesn't exist yet.

---

## 5. Architecture impact (vs current locked architecture)

| Change | Locked-rule impact | Verdict |
|---|---|---|
| Idempotency hardening (§1.4) | none — extends T5 in place | safe |
| Content-hash + conflict menu + semantic dedup (§2) | none; semantic dedup *reuses* S6 | safe |
| Three-way merge ancestor state | adds state to `.noir/` (new) | safe, additive |
| **Banner** | none; reuses `picocolors` + `isInteractive` | safe |
| **Full TUI — Archetype B** | **none** — host stays execution engine, D5 intact | **safe (recommended)** |
| **Full TUI — Archetype A** | **violates D5 + BYO-agent** | **rejected unless strategy changes** |
| `noir` CLI generating specs/plans (if Q3→yes) | new command family; consistent with S9 commander tree | safe, additive |

Net: **everything recommended here is backward-compatible and additive**, except the explicit *choice* of Archetype A, which we recommend *against*.

---

## 6. Prerequisites / changes before implementation

1. **Answer the §7 clarifications** (esp. Q1/Q2 — the actual duplicated artifact + version; Q5 — archetype A/B; Q3 — conflict surface; Q9 — legacy dedup scope).
2. **Confirm sequencing** (§7 Q10): (1) idempotency + conflict UX → (2) banner + richer status/home → (3) v2 orchestrator TUI.
3. **Per sub-project, run the normal Noir SDD flow** (brainstorm → spec → plan → implement+review). These are **3 separable sub-projects**, not one.
4. **For the TUI (Archetype B):** spike the host subprocess event-stream contract first (Claude Code `stream-json`), since it is the load-bearing integration; decide single-host (Claude) first vs host-agnostic (Q7).

---

## 7. Open clarifications (batched — please answer before any implementation)

**Topic 1 — the "duplicate" bug**
- **Q1.** What *exactly* did you observe? (a) two separate files created; (b) duplicated **content within one file** (a block/paragraph twice — this matches your reference project's CLAUDE.md lines 24 & 26); (c) the scaffold re-ran with output but files ended up identical; (d) other. A screenshot or the actual file would settle it.
- **Q2.** Which Noir version produced it (`noir --version`)? T5 + the I1 idempotency fix shipped in 1.1.0-beta.1 — are you on 1.2.0-beta.2 (current) or an older install?

**Topic 2 — conflict-resolution scope**
- **Q3.** Confirm the surface: should conflict-resolution cover (a) scaffold engine only, (b) scaffold + skill-emitted files, or (c) also *promote* `spec/prd/roadmap/rules/generate/task` from skills to real `noir` CLI commands that generate files?
- **Q4.** Conflict-menu default behavior: (a) always prompt in TTY; (b) non-destructive default (preserve) with `--force` to override; (c) opt-in flag. And the non-TTY/CI default (we recommend preserve + content-hash dedup + warning).

**Topic 3 — TUI (the big decision)**
- **Q5 (archetype).** (a) **Archetype B — orchestrator TUI** (drive host CLI subprocess, render its stream; D5 intact) [recommended]; (b) Archetype A — Noir becomes a standalone runtime [requires changing D5 + BYO-agent]; (c) hybrid (B now, optional A later)?
- **Q6 (timeframe).** Is the full TUI the **v2 effort now**, or phased (v1.x: banner + richer status/home; v2: full-screen streaming orchestrator TUI)?
- **Q7 (hosts).** For Archetype B, should v2 support (a) Claude Code only first (richest `stream-json` contract), or (b) host-agnostic from the start (per-host stream adapters — Gemini/OpenCode/Cursor have weaker headless streaming)?
- **Q8 (banner).** Confirm the restrained direction (pre-rendered ASCII, 4-bit ANSI, skip in CI/non-TTY, no gradient/animation), or do you want a richer branded banner despite the compat/startup trade-offs?

**Topic 4 — reference project / legacy dedup**
- **Q9.** Should Noir (a) only prevent *new* duplication going forward, or (b) also ship a `noir doctor` dedup/consolidation command that **detects and offers to fix existing duplication** in legacy projects (semantic dedup via S6)?

**Cross-cutting**
- **Q10 (sequencing).** Approve (1) idempotency+conflict → (2) banner+home → (3) v2 TUI, or different priority?
- **Q11 (spec shape).** One spec per sub-project, or a single combined spec?

---

## Appendix — evidence & sources

- **Code evidence (W1):** `packages/create/src/scaffold.ts:89–96,106–108,138,148,216,228–230,270,273–275`; `manifest.ts:149–173,176–203,281–287,350–359`; `writers.ts:56–94,101–108,187–193`; `packages/core/src/block-writer.ts:47–57`; `packages/skills/src/compiler.ts:207–216,234–286`.
- **Locked-rule citations:** `docs/specs/2026-07-23-noir-toolkit-design.md` (D1 BYO-agent, D5 no tool/exec loop); `docs/superpowers/specs/2026-07-24-s9-cli-tui-design.md` (full-screen TUI deferred to v2); `docs/roadmap.md` ("Programmatic headless driving of host CLIs from the TUI"); `docs/superpowers/specs/2026-07-24-s8-model-design.md:57–58` (streaming/tool-loops forbidden).
- **Key external references** (full annotated URL list in the workflow journal): **Ink** (npm/GitHub, v7.1.1 2026-07-16; React≥19.2); **Goose 2.0** ACP-client TUI; **Claude Code headless** `claude -p --output-format stream-json`; **Claude Agent SDK** subprocess pattern; **Copier** `.copier-answers.yml` (three-way merge baseline); **Angular** `ng update` (versioned migrations); **Yeoman** "identical" content-hash; GitHub **Copilot CLI** banner/color engineering write-ups; Bubble Tea / Ratatui / Textual (pattern references only).
- **Caveat:** the adversarial-verify agent's structured result (V1) did not classify cleanly during journal recovery; the "idempotent by design" conclusion is corroborated by W1 (code, file:line) + two independent web-research agents. Re-verify V1 at implementation time.
