# Display integrity, workspace transport, permission contract, and output hygiene — design

**Status:** Approved (design decisions confirmed with the maintainer on 2026-09-24)
**Date:** 2026-09-24
**Supersedes:** nothing
**Related decisions:** ADR-0009 (shared workspaces), ADR-0010 (per-project daemon records), ADR-0011 (`.noir/.env` and scaffold versions)

## Problem

Four defect classes were reported against 1.15.0, plus a standing quality obligation. Each was root-caused by
an evidence-based audit (6 area readers, each finding then adversarially refuted against the real source:
47 findings raised, 44 survived, 3 discarded, 21 further defects surfaced by the refuters).

### 1. Terminal rendering breaks its own layout

Two symptoms, one mechanism: **width is measured without accounting for the space the container actually
gives, and without accounting for the display width of the text**.

- The post-run action overlay renders its focused row 62 columns wide into a 58-column budget, so Ink wraps
  the overflow onto a stray second line and the two-column list shape collapses. The budget is
  `OVERLAY_WIDTH 64 − border 2 − Panel paddingX 2 − row paddingX 2 = 58`, while the row body is
  `truncate(label,28).padEnd(30) + truncate(hint,30)` (60 columns) plus a 2-column `▸ ` prefix inside the
  same `Text`. The sibling file `palette/Palette.tsx:23-33` already derives
  `ROW_TEXT_WIDTH = PALETTE_WIDTH - 6` and carries a comment about this exact defect class; the overlay
  hard-codes 30+30 and re-introduces the bug it was fixed for.
- The same class recurs in three more places the refuters found: the dashboard divider is always 2 columns
  too wide (`App.tsx:686` renders `divider()` — `terminalWidth − 4` — inside nested `paddingX` boxes whose
  budget is `terminalWidth − 6`); the footer hint is a 105-character untruncated, unwrappable `Text`, so it
  splits on any terminal under 105 columns; and the overlay's *non-focused* row path has the identical
  missing accounting, latent only because every current label is ≤24 characters.
- Non-TUI output measures columns with `String.length` (`output.ts:258`), which is a UTF-16 code-unit count:
  **ANSI SGR escapes are counted as visible width** (a colored `WARN` badge measures 16 instead of 6, so the
  doctor Status column is inflated roughly 2×), and wide characters (emoji, CJK) are counted as 1 when the
  terminal draws them as 2. The greedy trim then stops at the header floor and can leave the table wider than
  the terminal; long single-token paths are truncated from the tail, cutting the identifying part of the path;
  the live run-status line is drawn unclamped and cleared with `\r\x1b[K`, so a longer line leaves stale wrapped
  text behind; and five truncation sites slice by index without checking for a surrogate-pair boundary.
- Geometry is also derived from the wrong stream: `theme.ts:153-160` reads `COLUMNS`/`process.stdout.columns`
  while the tables are written to stderr.

### 2. A workspace daemon cannot be reached by a host

`noir daemon start --workspace <name>` prints a listening URL and writes it into each member's `.mcp.json`, but
the host reports `HTTP 404` and `not authenticated`. Neither is accidental:

- The **project daemon** matches `req.url === '/mcp'` exactly (`http.ts:156`) and answers everything else,
  including `/mcp?p=<uuid>`, with `404 not found` (`http.ts:197`). It is the only producer of a 404 for that URL
  shape in the tree. The **workspace daemon** matches both `/mcp` and `/mcp?…` (`workspace-http.ts:248`) and
  answers 401 without a token, 403 for a non-member, 200 otherwise — it can never answer 404 for that shape.
  Verified live: project daemon → 404 with and without a valid token; workspace daemon → 401 without, 200 with.
- `.mcp.json` entries written by `join`/`start --workspace` carry **no auth material at all**
  (`workspace-mcp.ts:59-76`), while the workspace daemon requires a bearer token minted fresh on every start.
  So "not authenticated" is an independent failure, not a consequence of the 404.
- The workspace daemon always binds an ephemeral port (`workspace-http.ts:330-337`; its only caller passes no
  port) and rotates its token per start, while `.mcp.json` is written once at join time. **The URL is stale by
  construction.**
- **No CLI path can produce the workspace daemon's token**: `noir daemon token` resolves the *caller's project*
  identity and reads the project-scoped secret (`commands/daemon.ts:507-549`), so a host-managed connection has
  no supported credential path.
- Re-running `noir sync` or `noir init --force` regenerates `.mcp.json` from a workspace-unaware manifest,
  reverting a joined repo to stdio while the workspace marker survives. And `join`/`leave` replace the whole
  `noir` entry, silently discarding any `headers`/`headersHelper`/`env` the user hand-wired.
- Refuters added two independent safety defects: `noir workspace stop` sends SIGTERM to the pid in the record
  with no `/health` ownership proof (a recycled pid kills an unrelated process), and `noir workspace status`
  reports liveness from `pidAlive` alone.

### 3. `.noir/.env` never becomes owner-only

Every repository warns `permissions 644 allow others to read — run chmod 600`, on every command. The 0600
contract is **create-only**: the manifest declares `skipIfExists` with `fileMode: 0o600`
(`manifest.ts:259-263`) and the writer returns immediately when the path exists, so the mode is applied only on
first creation. No code path anywhere in the tree ever changes an existing file's mode, no migration touches it,
and `noir env` is read-only with no `set` subcommand. `init --force` rewrites the file and still leaves 644.

Two further defects sit alongside: the diagnostic only tests group/other bits (`mode & 0o077`), so 0640/0660/0604
warn while 0600/0400/0000 pass; and the store database `.noir/store/<projectId>.db` is created with no mode at
all (so 0644), as is its parent directory.

### 4. Nothing constrains agent output quality

Searches across skills, templates, adapters, config and docs find **no emoji/icon guidance anywhere**, and
comment-hygiene guidance reaches a user's repo through exactly three shipped lines. Jargon and verbosity
guidance are absent from every shipped surface. Three further structural weaknesses make the gap worse: the
rules seed template is emitted to *every* host but its body is Claude-specific and Noir-repo-specific; the
`rules:` config block is half-inert (`rules.enabled` has no consumer); and the residue gate
(`FORBIDDEN_RESIDUE`) is asserted only by a CI test — it is not part of `validateSkill`/`lintSkill`, so
`noir skills lint` cannot surface it. Finally, the evals harness is self-referential: its assertions run against
`expected_output`, not against model output.

### 5. Documentation accuracy obligation

Every behaviour above is described somewhere in `docs/`, and several descriptions are already wrong (the
`rules:` block comment is stale; the transport section of `docs/how-to/shared-workspaces.md` described
header-forwarding behaviour that the new transport makes irrelevant). Documentation must reflect shipped
reality at the same checkpoint.

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | The host reaches a workspace through the existing **stdio bridge** (`noir mcp serve --stdio`), which reads the 0600 token itself and forwards to the workspace daemon. `.mcp.json` stays stdio. | Removes three failure classes at once: no secret in a committed config file, no stale-URL class (no URL in config), and the host's undocumented header-forwarding bugs become irrelevant. Verified that stdio is the already-proven transport. |
| D2 | A **project daemon answers `400`** with an explicit message when it receives a query-string MCP URL, instead of 404. | 404 means "path does not exist", which is false and misleading. A 400 that names the flavour mismatch turns a confusing failure into an actionable one. |
| D3 | Existing `.noir/.env` files are **re-asserted to 0600** on `init`/`sync`/`--upgrade`, plus `noir doctor --fix`; the store database and its parent directory are created 0600/0700. | Follows the precedent already in this repo (`ensureShimExecutable` re-asserts `0o755` after every install because `atomicWriteFile` preserves the old mode). Silent drift is worse than an explicit heal. |
| D4 | All six workstreams ship in one release, and **all affected documentation is updated in the same checkpoint**. | The maintainer's requirement: no leftover tasks, no stale or misleading documentation. |
| D5 | The hygiene gate has **two tiers**: deterministic patterns fail CI, judgement patterns warn only. | Deterministic patterns (decorative banners, `// Step 1:` narration, decorative emoji in code) are objectively wrong; judgement patterns (long comments, abbreviations) would produce false positives that block legitimate work. |

## Required behaviour

### A. Display integrity

A1. One shared display-width module is the single source of truth for measuring terminal text. It strips ANSI
SGR sequences, measures East-Asian wide and fullwidth characters as 2 columns, and truncates without splitting
a surrogate pair or a grapheme cluster. Every renderer — Ink components, `output.ts` tables, status lines,
banners — measures through it.

A2. Every width budget is derived from the container's real budget, never hard-coded. The post-run overlay and
every other two-column surface derive their cells from the palette's existing pattern
(`container width − border − padding`), so a change to `Panel` cannot silently re-break a child.

A3. Ink text that must not wrap is either truncated to the available budget or given an explicit `wrap` prop;
the choice is deliberate at every site, matching `OutputPane.tsx:89`.

A4. Table geometry is derived from the stream the table is written to.

A5. A table never exceeds the terminal width. When columns reach their floor and content still does not fit,
the row is truncated with a visible ellipsis rather than emitting an over-wide row.

A6. Path-like values are truncated from the middle, preserving the leading segments and the final segment.

### B. Workspace transport and daemon safety

B1. `noir daemon join <name>` (and `daemon start --workspace`) writes a **stdio** MCP entry that names the
workspace, so the host spawns a bridge that resolves the daemon, reads its token, and proxies both directions.
Re-running `sync` or `init --force` no longer downgrades a joined repo, because the workspace marker drives the
entry rather than the transport flag.

B2. The bridge verifies daemon ownership through `/health` before using a record, and reports a precise error
when no healthy daemon exists.

B3. A project daemon answers `400` for a query-string MCP URL, naming the flavour mismatch; `404` remains for
genuinely unknown paths. Both daemons answer `405` with `Allow` for a known path with an unsupported method.

B4. `noir workspace stop` proves ownership via `/health` before signalling, and `workspace status` reports
liveness from a probe rather than `pidAlive` alone.

B5. Join/leave preserve any `headers`/`headersHelper`/`env` the user added to the `noir` entry.

### C. Permission contract

C1. `.noir/.env` is 0600 after every command that can touch it, including when the file already existed.
C2. The store database and its parent directory are created owner-only.
C3. The diagnostic reports the observed mode and evaluates all permission bits, and the message distinguishes
"created by an older version" from "changed by something else".
C4. The claim in `install-method.ts` that a `writeFileSync` mode "survives any umask" is corrected, since the
mode is umask-masked.

### D. Output hygiene system

D1. A single rule source defines the prohibited patterns, their tier, and their human-readable rationale. It
extends `residue.ts` rather than creating a parallel system.
D2. The rules are enforced in three places: the skills quality gate (`validateSkill`/`lintSkill`, so
`noir skills lint` surfaces them), a `noir doctor` check, and the repo's own CI.
D3. The rule text reaches every host through a **host-agnostic** seed template, and a new builtin skill
(`noir-code-hygiene`) carries the full guidance with Tell/Why/Fix entries.
D4. The guidance covers: comment hygiene (decorative banners, restating the obvious, workflow narration, empty
labels, stale comments), decorative icon/emoji use, verbosity, internal jargon, and unstated assumptions.
D5. Evals for the new skill assert against real output, not only `expected_output`.

### E. Documentation accuracy

E1. Every document describing a changed behaviour is updated in the same checkpoint, verified by a
link/anchor/version pass (`pnpm docs:validate`) and by a targeted re-read of each affected document.

## Acceptance criteria

| # | Criterion | Verified by |
|---|-----------|-------------|
| AC1 | The post-run overlay renders its focused row within the container budget at 80, 100, 120 and 200 columns, with the hint in a second column and no continuation line | Render-to-string tests through `ink-testing-library` at each width |
| AC2 | No rendered frame is wider than the terminal at 80/100/120 columns, for the dashboard, the overlay, the palette, the footer, and every table | Frame-width assertions over the full TUI and `output.ts` |
| AC3 | A colored badge measures its visible width; a wide character measures 2 | Unit tests on the shared width module and on `computeColWidths` with colour on and off |
| AC4 | Truncation never splits a surrogate pair, at all five sites | Property test over astral-plane strings |
| AC5 | A table overflows gracefully: columns stop at their floor, the row is ellipsised, the frame never exceeds the terminal | Table tests at 80/100/120 |
| AC6 | A joined repo's `.mcp.json` resolves to a workspace-aware entry that survives `sync` and `init --force` | CLI integration test |
| AC7 | Reaching a workspace daemon through the bridge succeeds end to end, including `initialize` and a tool call | Live two-repo test with an isolated daemon directory |
| AC8 | A project daemon returns 400 for `/mcp?p=…` and 404 for an unknown path | HTTP tests against a real daemon |
| AC9 | `noir workspace stop` refuses to signal a process that does not answer `/health` as this workspace | Unit test with a planted foreign pid |
| AC10 | `.noir/.env` is 0600 after `init`, `sync`, `init --upgrade`, and `init --force`, including on a pre-existing 0644 file; the store DB and directory are owner-only | Permission tests over each path |
| AC11 | The hygiene gate fails on each deterministic pattern and warns on each judgement pattern, through both `noir skills lint` and `noir doctor` | Gate tests with fixture files |
| AC12 | The seed rules template is host-neutral and the new skill passes the structural quality gate | Skill validation test plus template assertions |
| AC13 | `pnpm docs:validate` is clean and every document touched by a behaviour change is accurate | Gate |

## Non-goals

- Rewriting the Ink TUI architecture, or replacing `cli-table3`. The fixes are width accounting, not a rewrite.
- Adding a second MCP transport. The stdio bridge reuses the existing serve path.
- Removing the workspace daemon's token requirement, or trusting loopback blindly.
- A general-purpose prose linter for arbitrary user repositories. The gate targets Noir's own tree and its
  emitted skill/template text.
- Judging aesthetic choices. The gate flags objectively mechanical patterns, not taste.

## Risks and open questions

| Risk / question | Status |
|---|---|
| Which process held the reported port at the moment the host dialled it cannot be determined from this repository (no process listing or daemon record survives) | Accepted; D1 removes the dependency on a stable port, so the question stops mattering |
| The host's own HTTP client behaviour for a query-string MCP URL (whether it preserves, strips or re-encodes `?p=`) is unverified | Accepted; D1 removes the query-string URL from the config entirely |
| East-Asian ambiguous-width glyph rendering could not be observed on a real ambiguous-wide terminal | Mitigated by centralising the measurement so a future setting is one change |
| The exact external vector that produced 0644 `.noir/.env` files (possibly an editor that saves by rename) cannot be pinned | Mitigated by D3: every command now re-asserts the mode, so the vector stops mattering |
| Whether the store database needs owner-only mode on every platform (Windows has no POSIX bits) | Addressed by degrading to a no-op where the platform does not support it |
| Changing the emitted MCP entry shape is a behaviour change for already-joined repositories | Addressed by having `sync`/`init --upgrade` migrate existing http entries to the bridge entry, documented in `CHANGELOG.md` |

## Documentation obligations

- `CHANGELOG.md` — a release section naming the behaviour changes, including the migrated MCP entry shape.
- `docs/how-to/shared-workspaces.md` — rewritten around the bridge; the header-forwarding guidance is removed.
- `docs/reference/` — config, environment, and MCP tool references regenerated and checked.
- `docs/roadmap/releases.md`, `STATUS.md`, `backlog.md`, `roadmap.manifest.yaml` — status sync.
- `CLAUDE.md` and `AGENTS.md` — the hygiene rules and the sweep exemption list.
- A new ADR recording D1 and D2, since both change a documented interface.
