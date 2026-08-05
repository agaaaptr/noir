# ADR-0006: C2 TUI command palette + daemon `--detach` (and the deferred v2 orchestrator TUI)

- **Status:** Accepted
- **Date:** 2026-08-05

## Context

Capability 2 (CLI Runtime & UX) shipped a commander command tree + a lazy-loaded Ink TUI MVP in S9, but four acceptance-condition gaps remained open in the C2 grounding (`docs/roadmap/capability-02-cli-runtime.md`), plus a TUI delta milestone was named next:

1. **No command palette / searchable command index** — the TUI dashboard had a single input line + `?` help; discoverability of the ~27-command surface was poor.
2. **`daemon start --detach` was wired but refused** — exit 2 "not implemented (tracked: v1.x)" (S9 DS-6 deliberate v0 debt). The acceptance criterion asked for real backgrounding with `stop`/`status` over a socket.
3. **`context index --force` was a no-op** — content-hash incremental always ran; the acceptance criterion asked for a forced full rebuild.
4. **`--dry-run`/`--preview` not surfaced on `init`/`create`/`sync`** — the scaffold engine already supported `dryRun` internally, but the CLI never exposed it.
5. **No in-process read fallback** — active read commands (`context search`, `memory recall`, `memory sessions`, `task status`) exit-4'd when the daemon was down (S9 DS-5 deferred item).

A prior discovery doc (`docs/internal/discovery/2026-07-26-scaffold-tui-discovery.md` §3) had already settled the TUI architecture line: **Archetype B** (orchestrator TUI that drives the host CLI as a subprocess and renders its `stream-json`) fits Noir's BYO-agent / D5 constraints; **Archetype A** (Noir runs its own model + tool loop) violates D5 and was rejected. The full-screen orchestrator TUI is the roadmap v2 line; the C2 TUI delta is the v1 increment that precedes it.

Two sub-decisions flowed from web research on command-palette UX (convergent across [@m86/renderer](https://www.npmjs.com/package/@m86/renderer), [polza-cli](https://github.com/judas-priest/hives/pull/86/files), [blackInkhaven](https://github.com/vulogov/blackInkhaven/blob/main/Documentation/PROPOSALS/PALETTE_PLAN.md), [VS Code](https://github.com/stevekinney/stevekinney.net/blob/main/courses/visual-studio-code/vscode-command-palette.md), [cmdease](https://www.npmjs.com/package/cmdease), [IBM mcp-context-forge](https://github.com/IBM/mcp-context-forge/issues/2278)) and fuzzy libraries ([fzf-for-js](https://github.com/ajitid/fzf-for-js), fuse.js, [nucleo-matcher-wasm](https://www.npmjs.com/package/nucleo-matcher-wasm)):

- **Palette architecture:** modal overlay triggered by `Ctrl+K` (VS Code's `Ctrl+Shift+P` is unreliable in terminals — shift-swallow). Backed by a **data-driven command registry derived from the commander tree** (single source of truth — the palette can never drift from the dispatchable command set).
- **Fuzzy matching:** a **hand-rolled subsequence + gap-penalty scorer** behind a thin `interface FuzzyMatcher` swap seam. Zero new runtime deps (NF3 no-native-bindings + "don't import sprawl"); <5ms on Noir's ~40-60-entry palette. The seam lets fuse.js/nucleo drop in later without refactoring callers.
- **Recent-command persistence:** `~/.noir/<projectId>/tui-history.json` via `atomicWriteFile`, capped (50), opt-out (`NOIR_DISABLE_TUI_HISTORY`). Keyed by canonical `ProjectId` (not a filesystem path) — respects the `.noir/` single-source-of-truth invariant. Reversible + private.

For the daemon, Node's detached-child pattern (convergent across [Fastify daemon guide](https://dev.to/whetlan/running-a-nodejs-daemon-with-fastify-no-pm2-no-systemd-99i), [salvatore](https://www.npmjs.com/package/salvatore), [NodeDaemon](https://www.npmjs.com/package/@nodedaemon/core)) is `spawn`/`fork` with `{detached:true, stdio:'ignore', windowsHide:true}` + `unref()` + child writes its own PID record + `/health` poll for boot confirmation. Noir already had the PID-record, `stop`, and `/health` probe infra (`@noir-ai/daemon` lifecycle + `daemon.ts`), so the only new piece was the spawn-detached path + a hidden `--_detached-child` flag so the child runs foreground-style within itself and writes an honest `mode:'detached'` record.

## Decision

**Six load-bearing decisions, all landed in one C2-completion session:**

### 1. TUI gains a `Ctrl+K` command palette (modal overlay) + richer widgets

A data-driven `buildPaletteCommands(program)` derives the palette from the commander tree (leaf commands only, with `destructive` flags). A hand-rolled `fuzzyMatch.ts` subsequence scorer ranks label > keywords > description behind a `FuzzyMatcher` swap seam. Four widgets ride on the same dispatch seam (`home(opts,deps).dispatch` — command routing is NOT reimplemented; D5 intact):

- **Input history + recall** (↑/↓ on an empty `/`-input, shell-like, in-memory).
- **Persistent recent commands** (projectId-keyed `~/.noir/<projectId>/tui-history.json`, capped 50, `atomicWriteFile`, opt-out env).
- **In-TUI confirmation** before destructive commands (e.g. `/context index --force`) launched from the palette — the direct input bar is unchanged.
- **Searchable output pane** (`Ctrl+F` — `/` is taken by the dispatch prefix; `n`/`N` next/prev, `n`/`N` only navigate when the query already matches so the letter 'n' is typeable).

App state was refactored to a discriminated `Mode` union (`dashboard` | `palette` | `search` | `confirm`) so overlays route input cleanly without keybinding collisions. **Home menu remains the sole entry; no CLI command regresses to interactive-only.**

### 2. `daemon start --detach` is fully implemented (real backgrounding)

`spawnDetachedDaemon({project})` spawns `node <bin> daemon start --_detached-child --cwd <root>` with `{detached:true, stdio:'ignore', windowsHide:true}` + `unref()`, waits for the child's daemon record (matching its pid) + a `/health` OK, and returns `{pid, port}`. The child is the single writer of the record (via `ensureDaemonRunning` → `startHttpServer`) with `mode:'detached'` (from `NOIR_DAEMON_MODE=detached`). The parent exits. `daemon stop`/`status` work unchanged (SIGTERM pid + `/health` probe); `status` reports the honest `mode`. A `--_detached-child` hidden flag tells the child to run foreground-style within itself and never spawn again. Double-spawn is guarded (a reused healthy daemon is reported, not re-spawned). `probeDaemon` gained a bounded `/health` fetch (`AbortSignal.timeout(1500)`) so a blackhole port never hangs the probe.

### 3. `context index --force` forces a full reindex

The daemon `context_index` tool gained `force?: boolean` → calls the indexer's existing `reindex()` (drop all chunks+vectors, re-index roots from scratch); the CLI forwards `--force` as `{force:true}`. Default (no `--force`) stays content-hash incremental. The previous "recognized but not yet honored" notice is removed.

### 4. `--dry-run` / `--preview` on `init`/`create`/`sync`

Both flags collapse to a single `dryRun` boolean forwarded into the scaffold engine's existing `dryRun` support (reports planned writes, writes nothing). `--preview` is an alias for `--dry-run`.

### 5. In-process read-only fallback when the daemon is down

`withInProcessRead(opts, fn)` opens the store READ-ONLY and builds the context + memory + workflow engines in-process over one handle. Read commands (`context search`, `memory recall`, `memory sessions`, `task status`) use it when `probeDaemon` confirms `{running:false}` instead of exit-4. The probe is conservative: an unavailable probe defaults to the daemon path (which maps a genuinely-down daemon to exit 4). **Writes keep the daemon-required exit-4 path** (single-writer invariant preserved — the store is never opened for writes in-process).

### 6. v2 orchestrator TUI (Archetype B) is deferred and tracked — NOT part of C2

The palette registry + matcher seam are designed to extend to it, but the orchestrator itself (spawning the host CLI, rendering its `stream-json`, token/cost status bar, mouse, fullscreen alternate-screen, transcript mode) is the roadmap v2 line and must be re-researched when started.

## Consequences

**Positive.** C2's four acceptance-condition gaps are closed and the TUI delta shipped: a discoverable, keyboard-first command palette; honest backgrounded daemon control; forced reindex; dry-run scaffolding; reads that keep working daemon-down. No new runtime deps (pure-JS, no native bindings — NF3). All writes stay daemon-gated (single writer). `probeDaemon` is bounded so a stale port never hangs a read. Docs (`capability-02`, STATUS, releases, manifest, CHANGELOG, cli.md) were synced to shipped reality.

**Trade-offs / risks.** The palette fuzzy matcher is hand-rolled — it does NOT do typo tolerance (subsequence matching only); the swap seam is the escape hatch. Recent-command persistence writes user activity to `~/.noir/` (bounded, opt-out, projectId-keyed — reversible). Detached daemon ownership is tracked via a `mode` field on the record, but a crash leaving a stale record is handled by the existing `pidAlive` + `/health` stale-cleanup path. The in-process read fallback opens the store readonly in the CLI process — a second read handle is safe (reads only); a concurrent writer is still forbidden (the readonly open refuses writes).

**Deferred (tracked, not lost).** v2 orchestrator TUI (Archetype B — host subprocess driving); Windows native-install bugs (C1 debt, need a Windows VM); three-way merge / semantic dedup / conflict menu (separate sub-projects from the 2026-07-26 discovery).
