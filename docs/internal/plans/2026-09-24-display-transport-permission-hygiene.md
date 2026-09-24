# Display integrity, workspace transport, permission contract, and output hygiene — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix four reported defect classes in 1.15.0 — terminal layout that breaks its own frame, an unreachable
workspace daemon, a `.noir/.env` permission contract that only applies at creation, and the total absence of
output-quality constraints — and bring every affected document back in line with the shipped code.

**Architecture:** One shared display-width module becomes the sole authority for measuring terminal text, and
every renderer's width budget is derived from its container rather than hard-coded. The host reaches a workspace
through the already-proven stdio bridge instead of a URL in `.mcp.json`, which removes the stale-URL and
secret-in-config classes at once. Permission healing follows the repo's existing re-assert pattern
(`ensureShimExecutable`). Output hygiene extends the existing residue list into a tiered rule source consumed by
three enforcers.

**Tech Stack:** TypeScript ESM, Node >= 22, pnpm workspaces, vitest, Ink 7 / React 19, `cli-table3`,
`@clack/prompts`, `picocolors`, better-sqlite3.

**Spec:** `docs/internal/specs/2026-09-24-display-transport-permission-hygiene-design.md`

## Global Constraints

- Every package stays on one unified version; all 11 packages move together.
- Node floor is `>=22`; ESM only; no CommonJS requires.
- The test suite runs offline and free — no network, no paid key, ever.
- `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate` must be green before any claim
  of completion.
- Conventional Commits, one scope per commit (`fix(cli): …`, `fix(daemon): …`).
- Comments and documentation must not contain internal planning shorthand (slice codes, roadmap codenames, bare
  spec/plan/ADR section citations) — the rule in `AGENTS.md` §"No internal jargon in comments or docs".
- The planning corpus is exempt from the hygiene sweep: `docs/decisions/**`, `docs/internal/**`,
  `docs/roadmap/**`, `CHANGELOG.md`, `.superpowers/**`.
- No new runtime dependency may be added without recording why in the task that adds it.

## Review Focus

Five input classes the spec implies but no single task's tests naturally cover. Each is pinned to the task that
owns the code.

1. **Injected width that disagrees with `process.stdout.columns`.** `ink-testing-library` hard-codes 100 columns,
   so tests that do not inject a width cannot exercise the 80-column case at all — which is how the footer and
   divider bugs shipped. The harness itself is the risk. (Task 6)
2. **Text that is already wider than the whole terminal.** A 200-column path in an 80-column terminal must
   ellipsise rather than emit an over-wide row, and must not loop forever when no column can shrink further.
   (Task 3)
3. **A workspace daemon that died between the record write and the host's dial.** The bridge must report a precise
   cause and must not hang, including when the record's pid has been recycled by an unrelated process. (Tasks B1, B5)
4. **A `.noir/.env` the user owns and has deliberately set to another mode.** The heal must be explicit and
   reported, never silent, and must be a no-op where the platform has no POSIX bits. (Task 15)
5. **A hygiene rule that fires on legitimate code.** A false positive that blocks CI is itself the failure mode
   the gate is meant to prevent; every FAIL-tier pattern must be anchored so it cannot match ordinary prose.
   (Tasks D1, D3)

---

## Workstream A — Display integrity

### Task 1 (Workstream A): Shared display-width module

**Files:**
- Create: `packages/cli/src/width.ts`
- Test: `packages/cli/test/width.test.ts`
- Modify: `packages/cli/package.json` (declare the width dependency)

**Interfaces:**
- Produces: `displayWidth(s: string): number`, `truncateToWidth(s: string, width: number, ellipsis = '…'): string`,
  `padToWidth(s: string, width: number): string`, `truncateMiddle(s: string, width: number, ellipsis = '…'): string`

- [ ] **Step 1:** Declare the width library in `packages/cli/package.json` dependencies, pinned to the same major Ink
      already resolves, then run `pnpm install` and commit the lockfile with the change. (The decision and its
      reasoning are in "Resolved decision" at the end of this plan.)
- [ ] **Step 2: Write the failing tests.** Cover: ANSI SGR is not counted (`'\u001b[33m⚠ WARN\u001b[39m'` → 6);
      a wide character counts 2; an emoji counts 2; `truncateToWidth` never splits a surrogate pair (property test
      over astral-plane code points); `truncateToWidth` counts the ellipsis inside the budget;
      `truncateMiddle` keeps the first and last segments; `displayWidth` of a string with a combining mark does not
      exceed its grapheme count; `truncateToWidth(s, 0)` returns `''`.
- [ ] **Step 3:** Run the test file and confirm it fails because the module does not exist.
- [ ] **Step 4:** Implement `width.ts` so every exported function routes through one measurement primitive.
      `truncateToWidth` must iterate by code point, not by index, and must reserve room for the ellipsis.
- [ ] **Step 5:** Run the test file; all cases pass. Run `pnpm typecheck`.
- [ ] **Step 6:** Commit `feat(cli): add a display-width module as the single text-measurement authority`.

### Task 2 (Workstream A): Route every measurement and truncation site through the module

**Files:**
- Modify: `packages/cli/src/output.ts` (the column-width calculator, the trim loop, the table options)
- Modify: `packages/cli/src/theme.ts` (the badge and the terminal-width helper)
- Modify: `packages/cli/src/commands/skills.ts`, `packages/cli/src/commands/task.ts`,
  `packages/cli/src/commands/env.ts` (the local truncation helpers)
- Modify: `packages/cli/src/banner.ts`
- Test: `packages/cli/test/width-integration.test.ts`

**Interfaces:**
- Consumes: `displayWidth`, `truncateToWidth`, `truncateMiddle` from Task 1.

- [ ] **Step 1: Write failing tests** proving the observable defects are gone: a table whose cell contains a colored
      badge allocates the badge's visible width, not its escape-inflated length; a cell containing a wide character
      is allocated 2; a `doctor` row renders with the same Status column width whether colour is on or off.
- [ ] **Step 2:** Run them and confirm they fail against the current `.length`-based measurement.
- [ ] **Step 3:** Replace every `.length`-based measurement and every index-based slice with the module's helpers.
      Delete the now-duplicated local helpers in `skills.ts`, `task.ts` and `env.ts`, importing the shared ones.
- [ ] **Step 4:** For path-valued cells (the store path, the `.noir/.env` path, any cell whose value is a filesystem
      path), use `truncateMiddle` rather than tail truncation, so the leading directory segments and the final
      filename both survive. Add a test asserting a long path keeps its first and last segments.
- [ ] **Step 5:** Add a table-level test asserting that identical content produces identical column widths with
      colour forced on and forced off.
- [ ] **Step 6:** Full file tests pass; `pnpm typecheck` clean.
- [ ] **Step 7:** Commit `fix(cli): measure terminal text by display width, not code-unit length`.

### Task 3 (Workstream A): Correct table geometry and graceful overflow

**Files:**
- Modify: `packages/cli/src/theme.ts` (the terminal-width helper — read the stream the table is written to)
- Modify: `packages/cli/src/output.ts` (the trim loop, the floor logic, the row-overflow path)
- Test: `packages/cli/test/table-overflow.test.ts`

- [ ] **Step 1: Write failing tests** for three cases at widths 80, 100 and 120: (a) a table with one very wide
      column never exceeds the terminal width; (b) when every column is at its floor and the content still does not
      fit, the widest cell is truncated with a visible ellipsis and the row still fits; (c) the trim loop
      terminates (assert on a call counter or a hard iteration bound so an infinite loop fails the test rather than
      hanging).
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Fix the width source to prefer the stream the table is written to, falling back to the other
      stream and then to 80. Change the floor to the smaller of the header length and a minimum content width so a
      long header cannot pin a column open. Add the final per-cell ellipsis pass when the loop has exhausted every
      column.
- [ ] **Step 4:** Tests pass at all three widths; add a regression test at 40 columns (degenerate but must not throw).
- [ ] **Step 5:** Commit `fix(cli): keep tables inside the terminal and ellipsise instead of overflowing`.

### Task 4 (Workstream A): Derive TUI width budgets from the container

**Files:**
- Modify: `packages/cli/src/tui/overlays/PostRunOverlay.tsx` (focused and non-focused rows)
- Modify: `packages/cli/src/tui/App.tsx` (the divider)
- Modify: `packages/cli/src/tui/Footer.tsx`, `packages/cli/src/tui/hints.ts` (the untruncated hint)
- Modify: `packages/cli/src/tui/Panel.tsx` if it must expose its inner budget
- Test: `packages/cli/test/tui/layout-budget.test.tsx`

**Interfaces:**
- Consumes: `truncateToWidth`, `padToWidth` from Task 1.
- Produces: `Panel` exposes its inner text budget so children stop guessing.

- [ ] **Step 1: Write failing render tests.** Render `PostRunOverlay` with the real options list at 80, 100, 120 and
      200 columns and assert: the focused row occupies exactly one line; its hint sits in a second column; no
      rendered line exceeds the inner budget; the frame's border is intact on every row. Render `App` and assert no
      line exceeds the terminal width and the divider is exactly one line. Render `Footer` at 80 columns and assert
      it is one line.
- [ ] **Step 2:** Run and confirm the overlay, divider and footer tests fail with the reported stray lines.
- [ ] **Step 3:** Replace the hard-coded cells with values derived from the panel's inner budget, following the
      pattern already used by the command palette. Give the footer an explicit truncation to the available width.
      Make the divider derive its length from the box it is drawn in.
- [ ] **Step 4:** All widths pass. Confirm the pre-existing palette tests still pass unchanged.
- [ ] **Step 5:** Commit `fix(cli): derive TUI width budgets from the container instead of constants`.

### Task 5 (Workstream A): Clamp the live run-status line

**Files:**
- Modify: `packages/cli/src/run-status.ts` (the render and the clear sequence)
- Test: `packages/cli/test/run-status.test.ts`

- [ ] **Step 1: Write a failing test** that renders a status line longer than the terminal width and asserts the
      emitted text fits, and that a subsequent shorter line leaves no residue (assert the exact escape sequence
      written, including the erase).
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Clamp the composed line through `truncateToWidth` and erase the full previous extent before
      writing (clear the line and any wrapped continuation).
- [ ] **Step 4:** Test passes; commit `fix(cli): clamp the live run-status line to the terminal`.

### Task 6 (Workstream A): A render harness that can vary the terminal width

**Files:**
- Create: `packages/cli/test/helpers/render-at-width.tsx`
- Modify: the TUI test files that currently rely on the fixed 100-column harness
- Test: `packages/cli/test/tui/harness.test.tsx`

**Interfaces:**
- Produces: `renderAtWidth(node: ReactElement, columns: number): { frame(): string; unmount(): void }`

- [ ] **Step 1:** Write a test proving the existing harness cannot express a non-100-column terminal (documents the
      gap), then a test for the new helper asserting `renderAtWidth(<Footer />, 80)` reports 80 columns.
- [ ] **Step 2:** Implement the helper by rendering through Ink's own `render` with an injected stdout shim that
      reports the requested `columns`, so width is a parameter rather than an ambient constant.
- [ ] **Step 3:** Migrate the TUI layout tests from Task 4 to the helper and delete their local width workarounds.
- [ ] **Step 4:** Commit `test(cli): add a TUI render harness that varies terminal width`.

### Task 7 (Workstream A): Honour the documented quiet-mode contract

**Files:**
- Modify: `packages/cli/src/output.ts`, `packages/cli/src/theme.ts`
- Test: `packages/cli/test/quiet-decoration.test.ts`

The module's own header and `docs/roadmap/capability-02-cli-runtime.md` both state that decoration auto-disables
under `--quiet`, but colour is in fact still emitted. One of the two is wrong; the documented contract is the one
to implement.

- [ ] **Step 1: Write a failing test** asserting that under `--quiet` the colour helper reports off and a table
      renders with no ANSI escapes.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Make the colour decision account for quiet mode, and confirm `--json` behaves consistently.
- [ ] **Step 4:** Commit `fix(cli): disable decoration under --quiet as documented`.

### Task 8 (Workstream A): Remove the dead and duplicated output helpers

**Files:**
- Modify: `packages/cli/src/output.ts`
- Test: `packages/cli/test/output-helpers.test.ts`

- [ ] **Step 1:** Confirm by search that the key/value helper has no call sites anywhere in the package (the audit
      found none but did not complete a repository-wide search — finish that search before deleting).
- [ ] **Step 2:** Delete it if it is genuinely unused, or wire it if a caller was intended; either way the codebase
      must not carry an exported helper nothing uses.
- [ ] **Step 3:** Fix the definition-list path so a value is formatted once rather than twice (the value is currently
      formatted by the caller and again by the table), and add a test with a non-string value proving the rendered
      output is the expected single formatting.
- [ ] **Step 4:** Commit `refactor(cli): drop an unused helper and stop double-formatting definition values`.

---

## Workstream B — Workspace transport and daemon safety

### Task 9 (Workstream B): The workspace stdio bridge

**Files:**
- Create: `packages/cli/src/workspace-bridge.ts`
- Modify: `packages/cli/src/serve.ts`, `packages/cli/src/bin.ts` (accept a workspace name on `mcp serve --stdio`)
- Test: `packages/cli/test/workspace-bridge.test.ts`

**Interfaces:**
- Produces: `resolveWorkspaceDaemon(name, root): Promise<{ url: string; token: string } | { error: string }>`
  and `bridgeStdioToWorkspace(name, root): Promise<void>`

- [ ] **Step 1: Write failing tests** for resolution: no record → a precise "no daemon recorded for workspace X"
      error; record present but `/health` silent → "record exists but the daemon is not answering (pid N)";
      `/health` answers with a different workspace name → a refusal naming both; healthy → url + token read from the
      0600 token file.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Implement resolution with a bounded `/health` probe and no unbounded retry. Then implement the
      bridge: connect a client transport to the daemon's `/mcp?p=<caller projectId>` with the bearer token, and
      forward both directions between it and stdio, propagating close in both directions.
- [ ] **Step 4:** Tests pass; add a test asserting the bridge never writes the token to stdout or stderr.
- [ ] **Step 5:** Commit `feat(cli): reach a workspace daemon through a stdio bridge`.

### Task 10 (Workstream B): Emit a workspace-aware MCP entry that preserves user wiring

**Files:**
- Modify: `packages/cli/src/workspace-mcp.ts` (the entry writer and the leave path)
- Test: `packages/cli/test/workspace-mcp.test.ts`

- [ ] **Step 1: Write failing tests:** after `join`, the `noir` entry is a stdio entry naming the workspace; a
      pre-existing `env` block on that entry survives the join; after `leave`, the entry returns to plain stdio and
      the workspace marker is gone; a hand-added `headers` key is preserved across both.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Write the entry as `{ command: <resolved noir>, args: ['mcp', 'serve', '--stdio', '--workspace', <name>] }`,
      merging into any existing entry instead of replacing the object.
- [ ] **Step 4:** Tests pass; commit `fix(cli): emit a workspace-aware MCP entry without discarding user wiring`.

### Task 11 (Workstream B): Stop downgrading a joined repository

**Files:**
- Modify: `packages/cli/src/sync.ts`, `packages/cli/src/init.ts`, `packages/create/src/manifest.ts`,
  `packages/create/src/migrations/`
- Test: `packages/cli/test/workspace-marker.test.ts`

- [ ] **Step 1: Write failing tests:** in a joined repo, `sync` leaves the workspace entry intact; `init --force`
      leaves it intact; a repo whose `.mcp.json` still holds an old `http …?p=…` entry is migrated to the bridge
      entry by `init --upgrade`, and the migration is idempotent.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Make the manifest consult the workspace marker when choosing the MCP entry, and add a scaffold
      migration for existing http entries.
- [ ] **Step 4:** Tests pass; commit `fix(create): keep a joined repo's MCP entry workspace-aware`.

### Task 12 (Workstream B): Correct HTTP routing in both daemon flavours

**Files:**
- Modify: `packages/daemon/src/http.ts`, `packages/daemon/src/workspace-http.ts`
- Test: `packages/daemon/test/http-routing.test.ts`

- [ ] **Step 1: Write failing tests** against a real project daemon: `POST /mcp` without a token → 401;
      `POST /mcp?p=<uuid>` → **400** with a body naming the flavour mismatch; `POST /nope` → 404; `PUT /mcp` → 405
      with an `Allow` header. Against a real workspace daemon: `POST /mcp?p=<member>` without a token → 401;
      with a token → 200; `POST /nope` → 404. Add `/health?x=1` → 200 to pin the tolerated-query behaviour.
- [ ] **Step 2:** Run and confirm the 400 case fails today with 404.
- [ ] **Step 3:** Compare on the parsed pathname rather than the raw URL, and branch on the presence of a query
      string to produce the 400. Add the 405 branch to both flavours.
- [ ] **Step 4:** Tests pass; commit `fix(daemon): answer 400 for a misdirected workspace URL and 405 for a wrong method`.

### Task 13 (Workstream B): Prove ownership before signalling

**Files:**
- Modify: `packages/cli/src/commands/workspace.ts` (stop, status, list)
- Test: `packages/cli/test/workspace-ownership.test.ts`

- [ ] **Step 1: Write failing tests** with a planted record whose pid belongs to a process that does not answer
      `/health` as this workspace: `stop` must refuse and exit non-zero with an explanation; `status` must report
      not-running; `list` must not claim a live daemon.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Add the `/health` ownership probe before signalling and before reporting liveness.
- [ ] **Step 4:** Tests pass; commit `fix(cli): verify daemon ownership before signalling or reporting`.

### Task 14 (Workstream B): End-to-end proof over two repositories

**Files:**
- Create: `packages/cli/test/workspace-e2e.test.ts`

- [ ] **Step 1:** In an isolated daemon directory, initialise two temporary git repositories, start a workspace
      daemon, join both, then drive the bridge end to end: assert `initialize` succeeds and a tool call returns,
      for **both** members. Assert that a third, non-member repository is refused with the membership error.
- [ ] **Step 2:** Run and confirm it fails while the bridge is incomplete; make it pass.
- [ ] **Step 3:** Assert the test leaves no daemon running and no record behind (a teardown assertion, so the suite
      cannot leak a background process into CI).
- [ ] **Step 4:** Commit `test(cli): prove the workspace bridge end to end across two repositories`.

---

## Workstream C — Permission contract

### Task 15 (Workstream C): Re-assert `.noir/.env` to 0600

**Files:**
- Modify: `packages/create/src/writers.ts` (or a new heal helper next to the existing executable-bit one)
- Modify: `packages/create/src/scaffold.ts`, `packages/cli/src/init.ts`, `packages/cli/src/sync.ts`
- Test: `packages/create/test/env-mode.test.ts`

**Interfaces:**
- Produces: `ensureOwnerOnly(path: string): 'unchanged' | 'healed' | 'unsupported'`

- [ ] **Step 1: Write failing tests:** a pre-existing 0644 `.noir/.env` is 0600 after `init`; after `sync`; after
      `init --upgrade`; after `init --force`. A file already at 0600 is untouched (assert on an injected stat/spy so
      "unchanged" is distinguishable from "healed"). On a platform without POSIX bits the helper reports
      `unsupported` and does not throw. A 0640 file is healed too.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Implement the helper following the existing executable-bit pattern, and call it from every path
      that can touch the file. Record the heal in the scaffold result so the command can report it once.
- [ ] **Step 4:** Tests pass; commit `fix(create): re-assert owner-only mode on an existing .noir/.env`.

### Task 16 (Workstream C): Owner-only store database and directory

**Files:**
- Modify: `packages/store/src/sqlite-store.ts` (database creation and the parent-directory creation)
- Test: `packages/store/test/db-mode.test.ts`

- [ ] **Step 1: Write failing tests:** after opening a store in a fresh directory, the database and its parent
      directory are owner-only; an existing database at a wider mode is healed or reported, consistently with Task 15.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Create the directory and the database with explicit owner-only modes, degrading to a no-op where
      unsupported.
- [ ] **Step 4:** Tests pass; commit `fix(store): create the database and its directory owner-only`.

### Task 17 (Workstream C): Make the diagnostic honest

**Files:**
- Modify: `packages/cli/src/doctor.ts` (the environment check)
- Test: `packages/cli/test/doctor-env-mode.test.ts`

- [ ] **Step 1: Write failing tests:** 0600 and 0400 pass; 0640, 0660 and 0604 each fail with the observed mode
      printed in octal; the message says whether the file predates the owner-only contract (so the reader knows it
      is a legacy file, not a mistake they made); the check no longer repeats on every command after a successful
      heal.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Evaluate all permission bits, print the observed mode, and word the message by cause.
- [ ] **Step 4:** Tests pass; commit `fix(cli): report the observed .noir/.env mode and its cause`.

### Task 18 (Workstream C): Correct the false umask claim

**Files:**
- Modify: `packages/cli/src/install-method.ts` (the comment above the atomic write) and any twin
- Test: none (comment-only change; the behaviour is already correct)

- [ ] **Step 1:** Rewrite the comment to state accurately that a `writeFileSync` mode is masked by the process
      umask, and that the owner bits survive only because the default umask clears group and other bits.
- [ ] **Step 2:** Commit `docs(cli): correct the umask claim above the atomic write`.

---

## Workstream D — Output hygiene system

### Task 19 (Workstream D): A tiered hygiene rule source

**Files:**
- Create: `packages/skills/src/hygiene.ts`
- Modify: `packages/skills/src/residue.ts`, `packages/skills/src/index.ts`
- Test: `packages/skills/test/hygiene.test.ts`

**Interfaces:**
- Produces: `HYGIENE_RULES: readonly HygieneRule[]` where
  `HygieneRule = { id: string; tier: 'fail' | 'warn'; pattern: RegExp; rationale: string; fix: string; appliesTo: 'code' | 'markdown' | 'both' }`
  and `checkHygiene(text: string, kind: 'code' | 'markdown'): HygieneFinding[]`

- [ ] **Step 1: Write failing tests.** FAIL tier, anchored so they cannot match ordinary prose: a decorative banner
      (`// ==== X ====`-style runs of punctuation around a label), workflow narration (`// Step 1:`), decorative
      emoji in a code comment. WARN tier: an over-long comment block, an unexplained abbreviation, a bare `// TODO`
      with no owner or reason. Also assert the negative: ordinary prose containing the word "step", a comment
      containing a single `=`, and a legitimate emoji stripped from a user-facing string do **not** fire.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Implement the rule table and the checker, keeping the existing residue tokens as their own rule so
      nothing that is forbidden today becomes allowed.
- [ ] **Step 4:** Tests pass; commit `feat(skills): add a tiered output-hygiene rule source`.

### Task 20 (Workstream D): Enforce through the skills quality gate

**Files:**
- Modify: `packages/skills/src/quality.ts`, `packages/cli/src/commands/skills.ts`
- Test: `packages/skills/test/quality-hygiene.test.ts`

- [ ] **Step 1: Write failing tests:** a skill whose body contains a decorative banner fails validation; one with a
      long comment block produces a warning; `noir skills lint` prints both tiers and exits non-zero only for FAIL.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Wire `checkHygiene` into `validateSkill` (FAIL) and `lintSkill` (WARN), returning structured
      findings with the rule id, the line, the rationale and the fix.
- [ ] **Step 4:** Tests pass; commit `feat(skills): gate skill bodies through the hygiene rules`.

### Task 21 (Workstream D): A doctor check with two tiers

**Files:**
- Modify: `packages/cli/src/commands/doctor.ts`, `packages/cli/src/doctor.ts`
- Test: `packages/cli/test/doctor-hygiene.test.ts`

- [ ] **Step 1: Write failing tests:** a repository containing a FAIL-tier pattern reports a failing check;
      WARN-tier patterns report a warning; a clean repository passes; the check's detail names the file and line.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Add the check over the repository's own source and documents, respecting the planning-corpus
      exemption list from the spec.
- [ ] **Step 4:** Tests pass; commit `feat(cli): add a two-tier output-hygiene check to doctor`.

### Task 22 (Workstream D): A builtin skill carrying the guidance

**Files:**
- Create: `packages/skills/builtin/noir-code-hygiene/SKILL.md`
- Create: `packages/skills/builtin/noir-code-hygiene/references/examples.md`
- Test: `packages/skills/test/builtin-hygiene-skill.test.ts`

- [ ] **Step 1: Write a failing test** asserting the new skill passes `validateSkill`, has no lint warnings, carries
      a WHAT+WHEN description, and contains at least one worked before/after pair.
- [ ] **Step 2:** Author the skill following the house skeleton established by the existing pack, with entries in
      Tell/Why/Fix form covering: decorative banners, restating the obvious, workflow narration, empty labels, stale
      comments, decorative icons and emoji, verbosity, internal jargon, and unstated assumptions.
- [ ] **Step 3:** Test passes; confirm the skill count assertion elsewhere in the suite is updated.
- [ ] **Step 4:** Commit `feat(skills): add the noir-code-hygiene builtin skill`.

### Task 23 (Workstream D): Make the rules seed host-neutral

**Files:**
- Modify: the rules seed template under `packages/create/` and its rendering context
- Test: `packages/create/test/rules-seed.test.ts`

- [ ] **Step 1: Write failing tests:** the seed rendered for each supported host contains no Claude-only importer
      syntax and no reference to this repository's own paths; the seed contains the core hygiene rules; it stays
      within the rules budget.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Rewrite the seed body host-neutrally, moving the Claude-specific importer line into the Claude
      adapter's own emitted block.
- [ ] **Step 4:** Tests pass; commit `fix(create): make the rules seed host-neutral`.

### Task 24 (Workstream D): Make the evals assert against real output

**Files:**
- Modify: `packages/skills/evals/` (runner and a new suite for the hygiene skill)
- Test: `packages/skills/test/evals-real-output.test.ts`

- [ ] **Step 1: Write a failing test** proving the current harness passes a case whose `expected_output` matches but
      whose candidate output violates the rule — i.e. that the harness cannot currently fail for the right reason.
- [ ] **Step 2:** Extend the harness to accept a candidate-output source and assert the four assertion types against
      it, keeping `expected_output` suites working.
- [ ] **Step 3:** Add a hygiene eval suite that fails on a slop-laden candidate and passes on a clean one.
- [ ] **Step 4:** Commit `fix(skills): assert evals against real output, not only the expected file`.

### Task 25 (Workstream D): Fix the two latent gate bugs

**Files:**
- Modify: `packages/skills/src/quality.ts`
- Test: `packages/skills/test/quality-bugs.test.ts`

- [ ] **Step 1: Write failing tests:** the thin-body rule measures the body, not the whole file (a file whose body is
      short but whose frontmatter is long still warns); the no-example rule is not satisfied by an `e.g.` inside
      frontmatter.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Split frontmatter from body before measuring, and search for an example only inside the body.
- [ ] **Step 4:** Tests pass; commit `fix(skills): measure the skill body and its examples, not the frontmatter`.

### Task 26 (Workstream D): Rules for this repository

**Files:**
- Modify: `CLAUDE.md`, `AGENTS.md`

- [ ] **Step 1:** Add the hygiene rules to `AGENTS.md` in the established convention style (why the pattern is noise,
      what to write instead), and the matching one-line entry to the `CLAUDE.md` "Do not" list.
- [ ] **Step 2:** Record the planning-corpus exemption explicitly, so a future reader knows the exclusion is
      deliberate and where its boundary sits.
- [ ] **Step 3:** Commit `docs: add output-hygiene rules to the repository guidance`.

### Task 27 (Workstream D): Make the rules configuration block honest

**Files:**
- Modify: the core configuration schema, `packages/create/src/manifest.ts`, the seed registration
- Test: `packages/core/test/config-rules.test.ts`, `packages/create/test/rules-gate.test.ts`

The block declares an enable switch that nothing reads, and its own description is stale.

- [ ] **Step 1: Write failing tests:** with the switch off, the rules seed is not emitted into a new repository and
      the doctor budget check reports itself as disabled rather than passing silently; with it on, behaviour is
      unchanged from today.
- [ ] **Step 2:** Run and confirm failure.
- [ ] **Step 3:** Wire the switch to the seed's emission and to the doctor check, and correct the stale description
      text on the block and its fields.
- [ ] **Step 4:** Commit `fix(core,create): make the rules block's switch and description accurate`.

### Task 28 (Workstream D): Write co-owned host files atomically

**Files:**
- Modify: `packages/create/src/writers.ts`, `packages/core/src/block-writer.ts`
- Test: `packages/create/test/atomic-host-files.test.ts`

Both writers rewrite a file the user also owns (the host context file and its managed regions) with a plain
truncating write, so an interrupted write can leave a user's file half-written.

- [ ] **Step 1: Write a failing test** that simulates an interrupted write (inject a failing write after truncation)
      and asserts the original content is still intact on disk.
- [ ] **Step 2:** Run and confirm failure — the current writers destroy the original.
- [ ] **Step 3:** Route both writers through the existing atomic write helper, preserving the destination's mode as
      that helper already does, while keeping the file-executable helper's re-assert behaviour intact.
- [ ] **Step 4:** Commit `fix(create,core): write co-owned host files atomically`.

---

## Workstream E — Repository sweep

### Task 29 (Workstream E): Sweep jargon from code comments

**Files:**
- Modify: `packages/*/src/**` and `packages/*/test/**` comment text (34 located candidates across 27 files)

- [ ] **Step 1:** Re-run the scanner to get the current list (it drifts as code changes) and confirm each hit is a
      comment, not a string literal or a fixture.
- [ ] **Step 2:** Rewrite each in self-contained plain language that keeps the original why-depth; never change
      executable code, identifiers, string literals or user-facing text. Delete shorthand that adds nothing rather
      than translating it.
- [ ] **Step 3:** Run the new gate (Task 21) over the tree and confirm the code-comment findings are gone.
- [ ] **Step 4:** Commit `docs: remove internal planning shorthand from code comments`.

### Task 30 (Workstream E): Sweep the outward-facing documents

**Files:**
- Modify: `README.md`, `CONTRIBUTING.md`, `docs/usage/**`, `docs/architecture/**`, `docs/how-to/**`,
  `docs/reference/**`, `docs/guides/**` as they exist

- [ ] **Step 1:** For each outward-facing document, list every token a reader cannot resolve without an internal
      planning document.
- [ ] **Step 2:** Rewrite them in plain language; where a citation is genuinely useful to a reader (a published
      ADR), keep the link but spell out what it decided.
- [ ] **Step 3:** `pnpm docs:validate` clean.
- [ ] **Step 4:** Commit `docs: remove internal planning shorthand from reader-facing documentation`.

### Task 31 (Workstream E): Wire the gate into continuous integration

**Files:**
- Modify: the CI workflow that runs the gate (`.github/workflows/ci.yml`)

- [ ] **Step 1:** Add the hygiene check to the CI sequence so a FAIL-tier pattern blocks a merge while WARN-tier
      output is printed and does not block.
- [ ] **Step 2:** Prove it locally by planting a temporary FAIL-tier pattern, observing the non-zero exit, then
      removing it.
- [ ] **Step 3:** Commit `ci: gate merges on the output-hygiene check`.

---

## Workstream F — Documentation accuracy and release choreography

### Task 32 (Workstream F): Record the two interface decisions

**Files:**
- Create: `docs/decisions/0013-workspace-transport-and-daemon-routing.md`
- Modify: `docs/decisions/README.md`

- [ ] **Step 1:** Write the record: the stdio bridge replacing the URL entry, and the 400 response for a
      misdirected workspace URL. State the alternatives, why each was rejected, and what would reverse the decision.
- [ ] **Step 2:** Add it to the decisions index. Commit `docs(adr): record the workspace transport and routing decisions`.

### Task 33 (Workstream F): Rewrite the shared-workspaces guide

**Files:**
- Modify: `docs/how-to/shared-workspaces.md`

- [ ] **Step 1:** Rewrite around the bridge: how a repo joins, what the entry looks like, what happens on daemon
      restart, how to diagnose a failure, and what the token protects.
- [ ] **Step 2:** Remove the now-irrelevant guidance about host header forwarding, and the claim that a URL-only
      entry is intentional.
- [ ] **Step 3:** Walk the document end to end against the shipped code and fix anything that does not match.
- [ ] **Step 4:** Commit `docs: rewrite the shared-workspaces guide around the stdio bridge`.

### Task 34 (Workstream F): Regenerate and verify the reference documents

**Files:**
- Modify: the generated reference documents under `docs/reference/`

- [ ] **Step 1:** Run the documentation generator and review the diff rather than accepting it blindly.
- [ ] **Step 2:** Verify the counts the generator embeds (tool counts, flag lists) against the built binary.
- [ ] **Step 3:** `pnpm docs:validate` clean; commit `docs: regenerate the reference documents`.

### Task 35 (Workstream F): Sync the roadmap and release documents

**Files:**
- Modify: `CHANGELOG.md`, `docs/roadmap/releases.md`, `docs/roadmap/STATUS.md`, `docs/roadmap/backlog.md`,
  `docs/roadmap/roadmap.manifest.yaml`

- [ ] **Step 1:** Add the release section, naming each behaviour change and the migration for existing joined
      repositories.
- [ ] **Step 2:** Update the status block, the next-milestone entry, the backlog history of resolutions, and the
      manifest note.
- [ ] **Step 3:** Commit `docs: sync the roadmap and changelog with the shipped changes`.

### Task 36 (Workstream F): The full gate

- [ ] **Step 1:** Run `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate` and fix every
      failure. Do not claim completion on a partial pass.
- [ ] **Step 2:** Re-run the four reported reproductions from the audit (overlay at 100 columns; join then `sync`;
      project daemon `?p=` response; `.env` at 0644 then `init`) and confirm each now behaves correctly.
- [ ] **Step 3:** Commit any remaining changes; report the observed command output, not a summary of it.

---

## Resolved decision

Task 1's dependency question is settled: **declare `string-width` directly.** The package is already present in
the install graph as a dependency of Ink (`ink` → `string-width@^8.2.0`, plus `slice-ansi@^9` and
`cli-truncate@^6`), so declaring it adds no new package to the install — it only turns an already-installed
transitive dependency into an explicit, relyable one. Pin the declared range to the same major Ink resolves so a
future Ink bump cannot silently change the measurement underneath both.

The hand-rolled alternative is recorded in this plan's history as rejected, on the grounds that an East-Asian
width table would become ours to maintain and its edge cases (combining marks, zero-width joiner sequences,
regional indicators) are easy to get wrong without extensive testing.
