# Noir — Discovery: v2 Orchestrator TUI — surface consolidation, streaming, and host-driving (Archetype B)

- **Date:** 2026-08-14
- **Status:** Discovery (pre-spec — direction, not a locked design)
- **Track:** v2 (deferred from ADR-0006 §6; the v1 TUI delta shipped in 1.8.0–1.9.2)
- **Related:** [ADR-0006](../../decisions/0006-c2-tui-and-daemon-detach.md), [capability-02](../../roadmap/capability-02-cli-runtime.md), prior [2026-07-26-scaffold-tui-discovery.md](2026-07-26-scaffold-tui-discovery.md) §3, [ADR-0007](../../decisions/0007-generated-artifact-standard.md)
- **Evidence base:** 11-agent parallel sweep — 5 code-audit agents over `packages/cli/src/tui/` (every surface enumerated with file, role, key bindings, LOC) + 6 web-research agents (each ≥4 cited sources, ~30+ distinct references). All research synthesized in §3 with URLs in §7.

> **⚠️ Shipped-shape note:** §5's "target architecture" describes a TUI-embedded orchestrator (StatusBar token/cost, transcript session picker). The shipped 1.11.0 scoped this down to the **`noir run` CLI command** (module `packages/cli/src/orchestrator.ts`); token/cost is the run summary, the transcript is a raw `.noir/transcripts/*.jsonl` file, and the in-process `/command` dispatch still uses `capture.ts`. See **ADR-0008** for the authoritative shipped decision.

---

## TL;DR — key findings

1. **The user's redundancy instinct is correct and confirmed by audit.** The TUI exposes **six interaction surfaces** — dashboard, command palette (`Ctrl+K`), curated home menu (`h`), output search (`Ctrl+F`), destructive confirm, static help (`?`) — plus a standalone `noir palette` entry point. Four of them (palette, home, help, search) are *command-discovery* surfaces with overlapping interaction shells: two arrow-key lists with the **same copy-pasted footer hint string** (`↑/↓ navigate · Enter run · Esc close`), three free-text input rows, two "recently run" stores, and a destructive-confirm gate that covers only the palette/home paths but **not** typed `/command`s. Research (lazygit #3134, Retool, koda) converges on collapsing command discovery into **one** searchable, executable palette.
2. **Form factor correction to ADR-0006 §6.** The ADR deferred v2 as a *fullscreen alternate-screen + mouse* orchestrator. The 2025–26 landscape has moved the other way: **no terminal-based AI agent uses a fullscreen TUI framework** (koda's competitive analysis; Claude Code, goose, aider, zed, cursor all write the normal buffer to keep native scrollback, Ctrl+F, selection). **Decision: normal-buffer hybrid** — output in the normal terminal buffer, one inline bottom viewport for input + a single status line + inline approval widgets. Fullscreen stays an opt-in, toggleable mode at most.
3. **Ink stays; the capture model is what must change.** Ink 7.1.1 (already pinned `^7.1.1`, React 19.2) is healthy and is the de-facto standard for Node agentic CLIs (Claude Code, Gemini CLI). Its real gaps are native mouse (absent; forks add it) and alternate-screen (experimental — buffer-exit artifacts, no dynamic toggle; Gemini CLI #22869). The single biggest v2 upgrade is replacing the **synchronous `capture.ts`** (monkey-patches `process.stdout.write`, one `setState` at completion) with a **true streaming** pipeline: `spawn` + `readline` + throttled (~100 ms) `setState` into a bounded ring buffer + `<Static>` for completed output.
4. **The token/cost bar has a numeric trap.** `stream-json` emits one JSONL line **per content block** of an assistant message, all sharing one `message.id`, and each line's `usage` is a *cumulative snapshot*, not a per-block bill. Naive summation over-counts **~2.5–3×** (ccusage, Untether cheatsheet both document this). Known-good rule: **take the `max` usage per `message.id`, never sum lines**; source the bar from the child's terminal `result` event (`total_cost_usd`, `usage`, `num_turns`) plus per-message deltas for live burn-in.
5. **Custom spawn command is a hard requirement (user-confirmed).** Users run multiple host-CLI profiles (e.g. two Claude Code profiles: `claude` and `claude-work`). The orchestrator must therefore **not hardcode the spawn command**: offer the host default (e.g. `claude`) plus a per-host **custom command the user fills in before execution** — and this must hold for every host adapter, not just Claude.
6. **The clack home menu stays untouched.** capability-02 locks "home menu as sole entry" as a MET acceptance criterion. The bare-`noir` clack menu is out of scope; consolidation happens **inside the TUI only**.
7. **Constraints carried forward unbroken.** NF3 (pure-JS, no native bindings, no new runtime deps), D5 (Noir drives the host — it never reimplements command routing or runs its own model/tool loop), daemon single-writer (in-process fallback stays read-only), and the scriptable contract (exit codes 0/1/2/3/4/5, `--json` on stdout, `--no-input` never blocks, no command regresses to interactive-only).

---

## 1. Current TUI inventory (audited)

### 1.1 Surfaces and their triggers

| Surface | Trigger | What it does | Where |
|---|---|---|---|
| **Dashboard** | default `noir tui` | `StatusBar` (host/mode/phase/daemon) + `OutputPane` (live `noir status` snapshot, or captured `/command` output) + `CommandInput` (`/cmd` → dispatch) + `Footer` hint | `App.tsx` Mode `dashboard` |
| **Command palette** | `Ctrl+K` | ~40 leaf commands derived by walking the live commander tree; hand-rolled subsequence fuzzy scorer; section headers; `── recent ──` section | `palette/Palette.tsx`, `commands/registry.ts`, `palette/fuzzyMatch.ts`, `palette/matcher.ts` |
| **Home menu** | `h` on empty buffer | ~22 curated quick-actions in 5 sections, sourced from the **same** `sections.ts` as the clack menu | `HomeMenu.tsx`, `commands/sections.ts` |
| **Search** | `Ctrl+F` when output present | case-insensitive substring filter over the **captured dispatched output** (not commands); `n/N` next/prev | `overlays/SearchMode.ts`, `App.tsx` Mode `search` |
| **Confirm** | destructive palette/home select | `y/N` gate; **only** for palette/home paths — typed `/command`s bypass it | `overlays/ConfirmOverlay.tsx` |
| **Help** | `?` | static keybinding list (~90 lines in `App.tsx`), hand-maintained | `App.tsx` `help` boolean |

### 1.2 Entry points

- `noir tui` — `runTui`, mounts App dashboard-first (`tui/index.tsx`).
- `noir palette` — `runPalette`, mounts the **same** App+Palette palette-first with identical deps (factored into `buildTuiDeps` to prevent drift, but it is a duplicated mounting path).
- bare `noir` — clack-based home menu in `bin.ts` (out of scope per decision 6).

### 1.3 Interaction model

- **Dispatch is single-source.** Typed `/command`, palette select, home select, and confirm-approve all funnel through the same `dispatchCmd → pending effect → captureProcessOutput → recordRuns` path. The duplication is in the *surfaces*, not the execution.
- **Keyboard routing is split across three components.** `App.tsx`'s single `useInput` owns dashboard/confirm/search; `Palette.tsx` and `HomeMenu.tsx` each own their own `useInput`. The same letters get conditional meanings per mode (`q`, `h`, `n/N`, `j/k`) — a subtle footgun.
- **`capture.ts` is synchronous.** It monkey-patches `process.stdout.write`/`stderr`, runs the dispatch in-process, restores, and does one `setState` at the end. No live feedback, no streaming.

---

## 2. Redundancy map (from the code audit)

1. **HomeMenu ≈ Palette.** Two arrow-key list shells over the same curated actions; near-identical interaction model (Panel-wrapped, ↑/↓, Enter, Esc); the inline footer hint is **copy-pasted verbatim** (`HomeMenu.tsx` line 119 vs `Palette.tsx` line 215) — a candidate for one shared constant. Both render sections from the same `sections.ts` source.
2. **Two "home" surfaces.** Clack bare-`noir` menu (`bin.ts`) and TUI Mode `home` — same quick-action taxonomy in two UIs (kept: see decision 6).
3. **Two palette entry points.** `Ctrl+K` in `noir tui` and standalone `noir palette`.
4. **Three free-text input rows.** `CommandInput` (dispatch buffer), palette query, search query. Palette and search are both *type-to-filter* and visually near-identical (dim `>` / `search:` prompt + block cursor) but operate on different corpora.
5. **Two "recently run" stores.** In-memory `useInputBuffer` history (↑/↓ recall, only when buffer is exactly `/`) vs persisted palette recents (`~/.noir/<projectId>/tui-history.json`, capped 50, dedup-by-id). Different dedup/cap rules over the same concept; a command run via the palette never appears in shell recall.
6. **Two highlight mechanisms.** Palette matched-character highlight (`matchedIndices`) vs OutputPane search highlight (bold substring + accent active line).
7. **Destructive-confirm asymmetry.** Palette/home selects are gated; typed `/command`s dispatch immediately. The same destructive command is gated or ungated depending on how it was invoked.
8. **Dead weight.** `HomeSection.key` (legacy selectKey digit, "no longer read"); stale registry entry `['context','forget']` (matches no command — only `memory forget` exists); `PaletteCommand.keywords` equals the label tokens (redundant matcher input); unused TUI theme tokens (`c.error`, `c.info`, `badge()`, `terminalWidth()`, `accessibleMode()`, `isCiEnv()`).
9. **Duplicate "destructive" knowledge.** `DESTRUCTIVE_PREFIXES` in `registry.ts` AND per-action `destructive: true` in `sections.ts` — two sources to keep in sync.
10. **Help duplicates the footer.** The static `?` help re-lists keybindings that the `Footer` idle hint and each surface's inline hint already enumerate — three to four text encodings of the same keyboard model.

---

## 3. Research synthesis

### 3.1 Orchestrator TUI pattern (stream-json) — what the ecosystem actually does

The orchestrator pattern is now a mature category with one dominant architecture: **spawn the headless child CLI** (`claude -p --output-format stream-json`, `gemini -p --output-format stream-json`, `codex exec --json`), **read its newline-delimited JSON event stream over a stdio pipe**, and **re-render your own UI from the typed events**. This sidesteps PTY emulation entirely — wrappers that drive an *interactive* child (mush harness, renga, tui-use) must embed a real vt100/xterm emulator and forward keys/resize, which is exactly the cost Archetype B avoids. Claude Agent SDK, Goose 2.0's TUI, Gemini, and headless-coder-sdk all follow the structured-event contract.

Load-bearing details:
- Canonical event order (Claude): `system(init: session_id/tools/model/cwd)` → `assistant` (tool_use blocks in content) → `user` (tool_result blocks) → … → `result` (`subtype`, `is_error`, `duration_ms`, `num_turns`, `result`, `session_id`, `total_cost_usd`, `usage`, `tools`).
- Exit codes are part of the contract: 0 success, 1 error/`is_error`, 2 usage error, 100 permission denied in non-interactive mode.
- **Token/cost rule:** per-message `usage` is cumulative across the content-block lines sharing one `message.id`; take `max` per id, never sum. Source the bar from the `result` event (`total_cost_usd`, `usage`, `num_turns`) plus per-message deltas; do **not** source from Claude statusline hooks (they omit per-turn tokens — issues #52089/#32406).
- Do **not** build a vt100/xterm-headless embed. The stream-json contract is purpose-built for a wrapper to reconstruct the transcript itself.

### 3.2 Command palette design (Retool, Linear, VS Code, Raycast, Warp)

- **Reject the bifurcated model.** Retool surveyed content-focused (Things, macOS, Notion) vs action-focused (Superhuman, Linear, Cron) palettes and rejected the split: deciding "am I searching or acting?" first adds mental overhead, and the two blur. The answer is **one surface combining actions + search results in typed sections**, with a pinned **"Top result"** section so category ordering never buries the best match.
- **Empty state is prime real estate.** The pre-typing view (recents + frequent + contextual suggestions) doubles as the home surface.
- **Contextual scoping.** Linear groups by "what you're focusing on / the view you're in"; VS Code uses `when`-clauses; Retool uses scope pills. Progressive disclosure via context, not hiding.
- **Keyboard-first + teaching.** Fuzzy match (streak + boundary bonuses, ~100 ms), 6–8 visible rows, **keycap hints on each result row** teach the fast path while the user executes.

### 3.3 Dashboard vs palette in real terminal apps (lazygit, k9s, helix, tmux, wezterm, Zellij, gitlens)

- **Single-surface wins.** lazygit #3134 proposes turning `?` into an executable fuzzy palette — *"the only thing a user would need to learn to start using lazygit is to press `?`"* — and folds help + palette into one surface. Zellij #2364 asks for the same. Helix/zed/vscode mirror it via `:` / Space / `Cmd+Shift+P`.
- **Palette is the middle tier.** Menus win for rare at-a-glance discovery, shortcuts for high-frequency actions, the fuzzy palette for the large in-between tier. Palette rows showing the keybinding teach muscle memory while executing.
- **Persistent contextual hints beat hidden bindings.** Apps praised for discoverability (lazygit footer, k9s resource-aware shortcut bar, Zellij mode-aware status bar, helix which-key popups) surface relevant keys continuously; tmux is the canonical counter-example and is criticized for it.
- **lazygit's rules:** don't require the user to memorise keybindings; if a keybinding is disabled, say why; **prefer disabling menu items over hiding them** (muscle memory); don't overwhelm with options.
- **Overlapping key semantics confuse** (lazygit #2650): the same key meaning different things across surfaces (help vs main UI) is a documented user-facing bug class.

### 3.4 Node TUI framework landscape (Ink 7)

- **Keep Ink.** 7.1.1 (already pinned), React ≥19.2, ~39.6k stars, actively maintained; the standard for Node agentic CLIs. A switch to blessed/neo-blessed trades React for a semi-active fork; ratatui/Bubble Tea are different languages.
- **Known gaps:** native mouse absent (forks like Dye and nastechai/ink add it); alternate-screen path experimental (Gemini CLI #22869: buffer-exit artifacts, no dynamic toggle, scrollback clipping).
- **Streaming render:** Ink already throttles internally (32 ms leading/trailing, `maxFps` default 30, `throttledLog`, optional `incrementalRendering` line-diffing). App-side job = bounded ring buffer + throttled state flushes; render completed output through `<Static>` (the known flicker fix, matching how Claude Code solved re-render flicker).
- **Borrowable architecture:** ratatui/Bubble Tea's phase discipline (explicit `idle → running → streaming → done` status enum + channel-bridged async output into a message loop; loading state for every async source).

### 3.5 UX trends 2025–26 (status bar, transcripts, scrollback)

- **Normal buffer wins.** The 2025–26 AI-CLI landscape deliberately rejects fullscreen alternate-screen TUIs to preserve native scrollback, Ctrl+F search, selection/copy, and muscle memory. Emerging pattern: **hybrid** — normal output above, one small inline bottom viewport for multi-line input + a single status line + inline approval widgets.
- **Status bar = one glanceable line**, color-thresholded: model, approval/permission mode, context-window % (red <10%, yellow <25%, green otherwise), timer, and (heavily demanded) live token + cost. Metrics that used to be interrupt-commands (`/cost`, `/status`) become persistent, ambient indicators. Costs are labeled **API-equivalent estimates, not the bill**.
- **Transcript is the source of truth; the TUI is a view.** Full JSONL transcripts on disk regardless of UI; proven demands: titled, full-text-searchable session picker; pre-compaction history; resume-from-summary; replay; export to Markdown/JSON. The host already writes `~/.claude/**/*.jsonl`; Noir's own store can persist a normalized event log.
- **One core, thin surfaces, no duplication.** Metrics should come from one source (the store) consumed by many thin consumers (statusline, widgets, daemon, transcripts) — the anti-duplication move. This matches Noir's existing CLI→daemon→store shape.
- **Mouse is secondary** but must not break native wheel-scroll / right-click when captured; toggles must be discoverable, not hidden env vars.

### 3.6 Locked v1 decisions + constraints (ADR-0006, capability-02)

Locked v1 TUI decisions that carry forward: `Ctrl+K` palette derived from the commander tree; hand-rolled subsequence scorer behind a `FuzzyMatcher` swap seam; ProjectId-keyed `tui-history.json` (capped 50, opt-out `NOIR_DISABLE_TUI_HISTORY`); in-TUI destructive confirm; `Ctrl+F` searchable output pane; discriminated `Mode` union; daemon `--detach`. The palette registry + matcher seam were explicitly designed to extend to the orchestrator.

Hard constraints: **NF3** (pure-JS, no native bindings, no new runtime deps); **D5** (no model+tool loop inside Noir; command routing never reimplemented); **daemon single-writer** (in-process fallback read-only). capability-02 acceptance criteria a redesigned surface must still satisfy: scriptable contract, single Commander tree, **home menu as sole entry** (unchanged — decision 6), no command regresses to interactive-only.

---

## 4. Decisions (user-confirmed, 2026-08-14)

| # | Decision | Chosen |
|---|---|---|
| D1 | **Form factor** | **Normal-buffer hybrid** (follows research). Output in the normal terminal buffer; one inline bottom viewport for input + status line + inline approval. No fullscreen alternate-screen as default. |
| D2 | **Scope** | **Full v2 in one release**: surface consolidation + real streaming + orchestrator (spawn host CLI, render `stream-json`, token/cost bar) — **plus configurable custom host spawn command** (see D2a). |
| D2a | **Custom spawn command** | The orchestrator must **not hardcode** the host spawn command. Offer the host default (e.g. `claude`) and a **custom command the user fills in before execution** (e.g. `claude-work`). Applies to **every host adapter**, not just Claude. Rationale: users run multiple profiles and should not have to restart the terminal to switch. |
| D3 | **Surface consolidation** | **Merge total to one palette.** Home (`h`), Help (`?`), and Search (`Ctrl+F`) all fold into the single palette (`Ctrl+K`). Dashboard remains the output/context view. |
| D4 | **Clack home menu** | **Untouched.** Bare `noir` keeps the clack menu (sole-entry acceptance criterion preserved). Consolidation is inside the TUI only. |

---

## 5. Target v2 architecture (proposal)

### 5.1 Form factor

Keep Ink, drop the manual `\x1b[2J\x1b[H` clear, and **stay inline** (matches how the dashboard already works). If a fullscreen mode is ever offered, it must own virtual scrollback + wheel and be toggleable via a discoverable setting — not a hidden env var. Respect the `INK_SCREEN_READER` / patched-console path (Gemini CLI #22869 accessibility flag).

### 5.2 Single command surface (palette-first)

The TUI reduces to **two layers**:

1. **Dashboard (context view)** — live `noir status` snapshot / streaming output, one `CommandInput` line, one `StatusBar` line (now with token/cost), a contextual 3–5-key `Footer`.
2. **One palette (command surface)** — `Ctrl+K` (and `?`, which becomes the same surface, per lazygit #3134). One fuzzy, executable list that subsumes:
   - all ~40 leaf commands (existing `registry.ts`),
   - the ~22 curated quick-actions (existing `sections.ts` → become palette entries, not a separate screen),
   - **help** (each palette row shows its keybinding; `?` opens the palette; a small "keybindings" entry shows the full manifest),
   - **output search** (the palette gains a filter modality over the *output corpus* in addition to the *command corpus* — one trigger, one type-and-narrow interaction, two corpora; Retool's "reject bifurcation" result),
   - **recents** (single source, from the unified recents store, §5.5).

The `Mode` union collapses to `dashboard | palette | confirm` (+ a `palette` corpus selector). `HomeMenu.tsx`, `overlays/SearchMode.ts`, and the standalone `help` screen are deleted; their behavior lives inside `Palette`.

### 5.3 Streaming pipeline (replaces `capture.ts`)

- `spawn` the subcommand with piped stdout; `readline` over lines; streaming JSON parse into a bounded queue; **throttled (~100 ms) functional `setState`** into a bounded ring buffer; `useCallback` handlers; `kill()`/`AbortController` on unmount.
- Render completed output through `<Static>` (append-only transcript region) and the live tail through the existing windowed `OutputPane`; optionally `incrementalRendering: true` and capped `maxFps`.
- Phase discipline: explicit `idle → running → streaming → done` status enum; loading state for every async source.
- stdio discipline: never accumulate the whole transcript in memory (fixed-size tail buffer for the pane; full transcript streams to a sidecar for transcript mode). Watch the pipe-truncation pitfall (`process.exit` before flush) and the `CLAUDE_CODEC=1`/`CLAUDE=1` env-inheritance trap when spawning a host that is itself a CLI.

### 5.4 Orchestrator: spawn host + `stream-json` + custom command

- **Host spawn is configurable, not hardcoded.** Per host, the orchestrator resolves a spawn command from a precedence order: **user-provided custom command (D2a) → host default** (e.g. `claude` for the `claude` adapter). The user fills their custom command before execution; Noir remembers it (ProjectId-keyed, like the recents store) so it survives across runs and terminal restarts. This covers multi-profile setups (`claude` vs `claude-work`) for **every** host adapter, not just Claude.
- **Stream-json is the contract; no PTY emulation.** Spawn `claude -p --output-format stream-json --verbose` (optionally `--include-partial-messages` for text deltas), consume the newline-delimited JSON, render from typed events.
- **HostAdapter seam** (already roadmap-planned) normalizes claude/gemini/codex `stream-json` to one internal event type; the `init`/`result` events are the shared, stable payload across all three.
- **Event reducer with the dedup rule** — `max` usage per `message.id`, never sum lines (§3.1). This is the single detail that separates a credible from a wrong token/cost bar.

### 5.5 Token/cost status line

Extend `StatusBar` (seam `deps.fetchStatus` already exists) with a single token/cost line: `model | $ | color-coded context-% | tokens`, throttled ~300 ms, labeled **"API-equivalent estimate, not billed"**, mirroring claude-bar / cc-costline conventions. Source from the child's `result` event (`total_cost_usd`, `usage`, `num_turns`) + per-message `usage` deltas. Expose the metrics via the **store** once (one source, many thin consumers — statusline, widgets, transcripts), not re-derived per surface.

### 5.6 Transcript mode

Merge with the file-sidecar channel: the host already writes `~/.claude/**/*.jsonl`; Noir's daemon/store persists a normalized event log. Proven set, not a novel player: titled, full-text-searchable **session picker**; pre-compaction history; **resume-from-summary**; **replay**; **export to Markdown/JSON**.

### 5.7 What to remove / merge / add (full table)

| Current function | Action | Target |
|---|---|---|
| Home menu (`h`, Mode `home`) | **Merge** | into palette (D3) |
| Static help (`?`, `help` boolean) | **Merge** | into palette (keybinding hints on rows + "keybindings" entry) |
| Output search (`Ctrl+F`, Mode `search`) | **Merge** | into palette as a second corpus filter modality |
| `noir palette` standalone entry | **Merge** | fold into `noir tui` (`Ctrl+K` is the only palette entry; keep a hidden/aliased path if the CLI contract needs it) |
| `HomeMenu.tsx`, `overlays/SearchMode.ts`, help screen in `App.tsx` | **Remove** | behavior absorbed by `Palette` |
| `capture.ts` (synchronous monkey-patch) | **Replace** | streaming pipeline (§5.3) |
| In-memory `useInputBuffer` history + persisted palette recents | **Merge** | one recents store (persisted, ProjectId-keyed); shell recall and palette recents read the same source |
| Three free-text input rows (CommandInput, palette query, search query) | **Merge** | one input model/component (palette + search reuse the input-buffer hook) |
| Keyboard routing split across App/Palette/HomeMenu `useInput` | **Unify** | single dispatcher in `App` (surfaces stay presentational) |
| Two highlight mechanisms (palette matched chars, search bold/active) | **Merge** | one highlight renderer |
| Destructive-confirm asymmetry (typed `/command` bypass) | **Fix** | gate **all** dispatch paths through the same confirm |
| `HomeSection.key` legacy field | **Remove** | dead weight |
| Stale registry entry `['context','forget']` | **Remove** | matches no command |
| `PaletteCommand.keywords` (= label tokens) | **Remove** | redundant matcher input |
| Unused TUI theme tokens (`c.error`, `c.info`, `badge()`, `terminalWidth()`, `accessibleMode()`, `isCiEnv()`) | **Defer** | dead in TUI only; keep for the CLI layer — do not remove from `theme.ts` |
| Copy-pasted footer hint (`HomeMenu.tsx:119` = `Palette.tsx:215`) | **Fix** | one shared constant |
| Duplicate "destructive" knowledge (`registry.ts` table + `sections.ts` flags) | **Merge** | single source of truth (registry-derived) |
| **—** | **Add** | custom host spawn command config (D2a, §5.4) |
| **—** | **Add** | token/cost status line (§5.5) |
| **—** | **Add** | transcript mode via sidecar + store (§5.6) |
| **—** | **Add** | streaming output pipeline (§5.3) |

---

## 6. Open questions (pre-spec)

1. **Palette corpus switcher UX.** One trigger, two corpora (commands vs output). Should it be a keybinding inside the palette (`Tab`), a scoped trigger (`Ctrl+K` = commands, `Ctrl+F` = output), or a typed prefix (`/` = output)? TBD in the spec — the discovery leans "one trigger, `Tab` to switch corpus."
2. **`noir palette` CLI contract.** capability-02 does not gate it, but is it a documented public command? If so, keep it as an alias for `noir tui` palette-first rather than deleting.
3. **Custom spawn command storage shape.** ProjectId-keyed `~/.noir/<projectId>/host-cmd.json` vs a single per-host record in `settings`; whether it should be per-project or global. TBD in spec.
4. **Host event normalization scope.** Which hosts ship a stable `stream-json`-style contract today (claude, gemini, codex confirmed in research); which adapters (agents-md, cursor, opencode) degrade to what fallback until they do?
5. **Fullscreen toggle.** Research says "discoverable toggle, not env var" — but the decision D1 is normal-buffer. Do we ship a fullscreen mode at all in v2, or defer entirely? Lean: defer; revisit if demand surfaces.
6. **Transcript sidecar lifecycle.** Retention/cap on normalized event logs in the store; interplay with `tui-history.json`. TBD in spec.

---

## 7. References

### Orchestrator / stream-json
- Claude Code CLI reference — print mode / `--output-format stream-json` — https://code.claude.com/docs/en/cli-reference
- Untether AMP stream-json event cheatsheet — https://github.com/littlebearapps/untether/blob/master/docs/reference/runners/amp/stream-json-cheatsheet.md
- Gemini CLI headless mode reference (`stream-json`) — gemini CLI docs (github.com/google-gemini/gemini-cli)
- Claude Agent SDK, Goose 2.0 TUI, headless-coder-sdk (structured-event wrapper architecture)
- ccusage (token/cost accounting over JSONL — documents the summation trap)

### Command palette design
- Retool — "Designing the Command Palette" (Andrew Shen) — https://retool.com/blog/designing-the-command-palette
- Linear — "New command menu" changelog — https://linear.app/changelog/2019-12-18-new-command-menu
- VS Code command palette + `when`-clauses (contextual command visibility)

### Dashboard vs palette in terminal apps
- lazygit VISION.md — discoverability principles — https://github.com/clayne/lazygit/blob/master/VISION.md
- lazygit Discussion #3134 — "Command palette for discoverability" — https://github.com/jesseduffield/lazygit/discussions/3134
- lazygit Issue #2650 / PR #2651 — misleading shared key semantics across surfaces — https://github.com/jesseduffield/lazygit/issues/2650
- Zellij Issue #2364 — palette-style discoverability request
- koda competitive analysis — "no terminal-based AI agent uses a fullscreen TUI framework"
- gitlens Issue #3443 — overlapping command surfaces

### Node TUI framework landscape
- Ink — React for CLIs (vadimdemedes/ink) — https://github.com/vadimdemedes/ink
- Dye / nastechai/ink — mouse-support forks of Ink
- Gemini CLI PR #22869 — alternate-screen buffer-exit artifacts, no dynamic toggle, accessibility (`INK_SCREEN_READER`)

### UX trends 2025–26
- claude-bar — token/cost status line for Claude Code — https://www.npmjs.com/package/claude-bar
- cc-costline — usage/cost statusline — https://github.com/Ventuss-OvO/cc-costline
- claude-statusbar, cconeline, ClaudeExtensions, ocstatusline, tokens-metric, ccstatusline (statusline ecosystem over JSONL/daemon)
- goose, aider, zed, cursor, opencode (normal-buffer AI-CLI UX)
- koda PR #477 (own-scrollback / wheel handling if fullscreen)

### Local
- ADR-0006 — `docs/decisions/0006-c2-tui-and-daemon-detach.md`
- capability-02 — `docs/roadmap/capability-02-cli-runtime.md`
- Prior discovery — `docs/internal/discovery/2026-07-26-scaffold-tui-discovery.md` (§3 Archetype A vs B)

> Note: several secondary sources above were surfaced by the research agents as named projects/blogs; exact URLs for the ones listed without one are captured in the workflow journal (`workflow-tui-v2` run, `journal.jsonl`) and can be pulled into the spec if needed.
