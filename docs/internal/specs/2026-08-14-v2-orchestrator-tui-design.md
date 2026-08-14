# Spec — v2 Orchestrator TUI: single-surface consolidation, streaming, and host-driving (Archetype B)

- **Date:** 2026-08-14
- **Status:** Design (approved direction; supersedes the deferred ADR-0006 §6 scope)
- **Discovery:** [`2026-08-14-v2-orchestrator-tui-discovery.md`](../discovery/2026-08-14-v2-orchestrator-tui-discovery.md)
- **Plan:** [`2026-08-14-v2-orchestrator-tui.md`](../plans/2026-08-14-v2-orchestrator-tui.md)
- **Capability:** capability-02 (CLI Runtime & UX) — the v2 increment deferred by ADR-0006 §6
- **Constraints (binding):** NF3 (pure-JS, no native bindings, no new runtime deps), D5 (Noir drives the host; no model+tool loop), daemon single-writer, scriptable contract (exit 0/1/2/3/4/5, `--json` stdout, `--no-input` never blocks).

> **⚠️ Shipped-shape reconciliation — ADR-0008 is the authoritative record.** This design was scoped down at implementation (2026-08-14). The orchestrator shipped as the **`noir run <prompt>` CLI command**, not a TUI subprocess view: the live StatusBar token/cost line, the transcript session picker, and the `stream.ts` streaming pipeline were **not** built (token/cost is the `noir run` summary line, the transcript is a raw `.noir/transcripts/*.jsonl` file, and the in-process `/command` dispatch still uses `capture.ts`). The module lives at `packages/cli/src/orchestrator.ts` (not `tui/`); the custom command is a per-invocation `--command` flag (not persisted); the corpus set is `commands|output|help` (no `home`); `PaletteCommand` keeps `keywords` and gained no `section`/`keybinding`; the normalized event union is `init|assistant|result|other`.

---

## 1. Goals

1. **Collapse command discovery to one surface.** Home menu (`h`), static help (`?`), and output search (`Ctrl+F`) fold into the single command palette (`Ctrl+K`). The TUI reduces to two layers: a **dashboard** (context/output view) and a **palette** (the only command/discovery surface).
2. **Replace the synchronous `capture.ts`** with a true streaming pipeline: `spawn` + `readline` + throttled React updates into a bounded ring buffer, so dispatched output and (later) host-agent output stream live.
3. **Add the orchestrator (Archetype B):** drive the host CLI headless (`claude -p --output-format stream-json`), normalize its event stream, and render it — without reimplementing command routing (D5).
4. **Make the host spawn command configurable, not hardcoded.** Default per host (e.g. `claude`) plus a user-filled **custom command** (e.g. `claude-work`), remembered per project. Applies to every host adapter.
5. **Add a token/cost status line** sourced from the child's `result` event, with the `max-usage-per-message.id` dedup rule so the number is correct.
6. **Add a transcript mode** backed by the host's JSONL sidecar + Noir's store.
7. **Eliminate the redundancy/dead-weight findings** from the discovery doc (single recents store, single input model, unified confirm gate, single keyboard router, shared footer constant, dropped dead fields).

---

## 2. Decisions (locked, user-confirmed)

| # | Decision |
|---|---|
| D1 | **Normal-buffer hybrid** form factor. No fullscreen alternate-screen. |
| D2 | Full v2 in one release: consolidation + streaming + orchestrator + token/cost + transcript. |
| D2a | **Custom spawn command** per host: default (e.g. `claude`) + user custom (e.g. `claude-work`), remembered, all hosts. |
| D3 | **Merge total to one palette**: home + help + search → `Ctrl+K`. |
| D4 | **Clack bare-`noir` home menu untouched** (capability-02 "home menu as sole entry" preserved). |

---

## 3. Architecture

### 3.1 Surface model

The `Mode` union collapses from `dashboard | palette | home | confirm | search` to:

```ts
type Mode =
  | { kind: 'dashboard' }
  | { kind: 'palette'; corpus: Corpus }   // corpus = 'commands' | 'output' | 'home' | 'help'
  | { kind: 'confirm'; argv: string[] };
```

- `dashboard` — the only full-screen context view: `StatusBar` (now with token/cost), `OutputPane` (snapshot or streaming output), `CommandInput`, `Footer`.
- `palette` — the single command surface. `corpus` selects what the query filters:
  - `commands` — the ~40 leaf commands (existing `registry.ts`) **plus** the ~22 curated quick-actions (existing `sections.ts`, promoted to palette entries with a `section` tag).
  - `output` — the captured/streamed output lines (the former `Ctrl+F` search, now a palette modality).
  - `home` — the curated quick-action view (the former `h` menu; now a palette section, not a screen).
  - `help` — the keybinding manifest (the former `?` help; now a palette entry/section).
- `confirm` — unchanged: `y/N` gate, but now **all** dispatch paths (including typed `/command`) route through it.

Keyboard routing is **unified**: the App owns the single `useInput`; `Palette`, `ConfirmOverlay`, and all sub-surfaces become presentational (no `useInput` of their own). The palette's `corpus` switch is `Tab`; `?` opens the palette at the `help` corpus; `Ctrl+F` opens it at the `output` corpus; `h` opens it at the `home` corpus; `Ctrl+K` opens it at `commands`.

### 3.2 Palette corpus & entries

- `PaletteCommand` gains an optional `section?: string` (curated group) and an optional `keybinding?: string` (teaching hint, per lazygit #3134 / Retool keycap-hint pattern).
- The palette result list renders: `keybinding` hint (dim, right-aligned) · `label` · dim `description`. Section headers group both leaf commands and curated quick-actions. A "Top result" / recents section stays first.
- `corpus: 'output'` reuses `computeMatches` (from the retired `SearchMode.ts`, moved into the palette module) over the output lines; the match walk (`n`/`N`/Enter) is the same interaction as command selection.
- Deleted files: `HomeMenu.tsx`, `overlays/SearchMode.ts` (behavior absorbed by `Palette`).

### 3.3 Unified recents store

One persisted store replaces both the in-memory `useInputBuffer` history and the palette `history.ts` recents:

- `loadRecent`/`recordRecent` (from `palette/history.ts`) become the single source, ProjectId-keyed (`~/.noir/<projectId>/tui-history.json`, capped 50, `NOIR_DISABLE_TUI_HISTORY` opt-out).
- `useInputBuffer`'s shell-history recall (`↑`/`↓` on `/`) reads the **same** persisted list; every dispatch (typed, palette, confirm) records through `recordRecent`. A command run via the palette now appears in shell recall, and vice-versa — one dedup/cap rule.
- The in-memory ref history is kept only as a fast-path overlay, never a divergent source.

### 3.4 Streaming pipeline (replaces `capture.ts`)

`capture.ts` (monkey-patch `process.stdout.write`, one `setState` at completion) is replaced by `packages/cli/src/tui/stream.ts`:

- `spawnStream(cmd: string[], opts): StreamHandle` — `spawn` with piped stdout/stderr, `readline` over lines, a bounded ring buffer (fixed tail, e.g. 1000 lines), and an `onLine` callback throttled ~100 ms into React state.
- Phase enum `idle → running → streaming → done`; `kill()`/`AbortController` on unmount; `pipe-truncation` guard (`process.exit` before flush is tolerated, not fatal).
- Completed output renders through `<Static>` (append-only); the live tail renders through the existing `OutputPane`.
- The `dispatchCmd` seam still routes `/command` dispatch through `deps.dispatch`, but the *capture* is now streaming rather than post-hoc.

### 3.5 Orchestrator (spawn host + stream-json + custom command)

New module `packages/cli/src/tui/orchestrator.ts` (or a sibling under `tui/`):

- **Host spawn resolution (D2a):** `resolveHostCommand(host, custom): string[]` — precedence: user custom command → host default (from the existing `@noir-ai/adapters` host registry). The custom command is stored ProjectId-keyed (`~/.noir/<projectId>/host-cmd.json` or the recents file) and read at spawn time, so it survives restarts. The user fills it once; Noir never hardcodes it.
- **Spawn:** `spawn(cmd, ['-p', '--output-format', 'stream-json', '--verbose'])` (per-host flags via an adapter map, defaulting to claude's contract). No PTY, no vt100 embed.
- **Event normalization:** a `HostAdapter` seam maps each host's `stream-json` to one internal `NoirEvent` union (`init`, `assistant`, `tool_use`, `tool_result`, `result`, `stream`). `result`/`init` are the stable shared payload.
- **Event reducer:** `max usage per message.id` — never sum lines (discovery §3.1). Emits a monotonic `{tokens, costUsd, numTurns}` accumulator for the status bar.

### 3.6 Token/cost status line

Extend `StatusBar` with a single token/cost line (source: the event reducer's accumulator + the child's `result` event):

```
model | 322K ($5.02) | ████░░░░ 43% | 1h10m
```

- Throttled ~300 ms; labeled **"API-equivalent estimate, not billed"**.
- The `deps.fetchStatus` seam already exists; add a `deps.metrics` seam (or extend the payload) so metrics come from one source (the store) and many thin consumers.

### 3.7 Transcript mode

- The host already writes `~/.claude/**/*.jsonl`; Noir persists a normalized event log via the daemon/store.
- Proven feature set (not a novel player): a titled, full-text-searchable **session picker** (a palette corpus), pre-compaction history, **resume-from-summary**, **replay**, **export to Markdown/JSON**.

---

## 4. Component breakdown

| Component | Change | Location |
|---|---|---|
| `App.tsx` | Rewrite `Mode` union, single `useInput`, corpus routing, confirm-all-paths | `tui/App.tsx` |
| `Palette.tsx` | Absorb home/help/search; presentational (no `useInput`); corpus + keybinding hints | `tui/palette/Palette.tsx` |
| `HomeMenu.tsx` | **Delete** (absorbed) | `tui/HomeMenu.tsx` |
| `overlays/SearchMode.ts` | **Delete** (absorbed; `computeMatches` moved into palette module) | `tui/overlays/SearchMode.ts` |
| `capture.ts` | **Replace** with `stream.ts` | `tui/stream.ts` |
| `orchestrator.ts` | **New** — spawn host, event normalization, reducer, custom command | `tui/orchestrator.ts` |
| `palette/history.ts` | **Generalize** to the single recents source; add `loadRecent`/`recordRecent` reuse | `tui/palette/history.ts` |
| `palette/types.ts` | Add `section`/`keybinding` optional fields; drop redundant `keywords` | `tui/palette/types.ts` |
| `commands/registry.ts` | Drop stale `['context','forget']`; keep destructive flags as single source | `tui/commands/registry.ts` |
| `commands/sections.ts` | Drop `HomeSection.key` legacy; keep as palette-entry source (no screen) | `tui/commands/sections.ts` |
| `hooks/useInputBuffer.ts` | Read persisted recents for shell recall (single source) | `tui/hooks/useInputBuffer.ts` |
| `StatusBar.tsx` | Add token/cost line | `tui/StatusBar.tsx` |
| `Footer.tsx` | Shared hint constant; single-source keybinding manifest | `tui/Footer.tsx` |
| `ConfirmOverlay.tsx` | Unchanged (presentational) | `tui/overlays/ConfirmOverlay.tsx` |

---

## 5. Data flow

```
user keystroke ──► App.useInput (single router)
   ├─ dashboard keys → CommandInput / scroll / open palette(corpus)
   ├─ palette keys  → Palette (query → matcher → render → onSelect)
   └─ confirm keys  → ConfirmOverlay (y/N) → dispatch

dispatchCmd(argv)
   ├─ destructive? ─► confirm
   └─ else ─► spawnStream / deps.dispatch ─► recordRecent ─► OutputPane (Static + tail)

orchestrator (host run)
   └─ spawn(hostCmd + stream-json flags) ─► readline ─► HostAdapter.normalize ─► reducer
        ├─ text/thinking/tool events → transcript region (<Static>)
        └─ result/usage events → StatusBar token/cost accumulator
```

---

## 6. Error handling

- `spawn` failure (host missing) → inline notice + `Footer` hint "host command not found — set a custom command".
- stream-json parse failure on a line → skip the line, keep streaming (never crash the TUI); surface a count of skipped lines.
- `process.exit` before flush → treat as truncated output (render what arrived + a `[truncated]` marker).
- Recents/transcript read/write failures → degrade to empty (never block).
- All the above respect the scriptable contract: `--json` on stdout, diagnostics on stderr, `--no-input` never blocks.

---

## 7. Testing strategy

- **Unit** (offline/free, per the repo gate): reducer dedup (`max usage per message.id`), `resolveHostCommand` precedence, event normalization fixtures per host, ring-buffer bounds, throttled flush.
- **Component** (`ink-testing-library`): palette corpus switching (commands/output/home/help), keybinding hints render, confirm gates all paths (typed + palette), single-recents dedup.
- **Contract** (existing CLI tests must stay green): `noir tui` dashboard-first, `noir palette` palette-first (kept as an alias), scriptable contract, no command regresses to interactive-only.
- **Regression** anchors: `tui.test.tsx`, `tui/palette.test.tsx`, `tui/search.test.tsx`, `tui/home-menu.test.tsx` are updated to the new surface model (deleted-home and deleted-search behaviors asserted through the palette).

---

## 8. Out of scope (explicit, tracked)

- Fullscreen alternate-screen mode (D1 — deferred; revisit if demand surfaces).
- Native mouse input (Ink gap; forks add it — not in v2).
- Memory cloud sync, team/multi-user, first-class skill registry (v2.0 ecosystem — see roadmap deferred table).
- Bare-`noir` clack menu changes (D4).
