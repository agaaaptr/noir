// Dashboard root component. Owns the interactive state (input buffer, scroll
// offset, dispatched output, snapshot, help overlay, the active screen) and the
// single keybinding dispatcher. The snapshot is fetched via
// {@link TuiDeps.fetchStatus} on a short interval (paused while a
// `/<command>` is dispatching, so a StatusBar refresh can never race the stream
// capture). Dispatch goes through the EXISTING {@link TuiDeps.dispatch} seam —
// the same `home(opts, deps).dispatch` shape — so command routing is NOT
// reimplemented here.
//
// Screens (the {@link Mode} union): `dashboard` (default), `palette` (B2 — the
// fuzzy command palette opened by Ctrl+K), `confirm` (C1 — the `y/N` gate
// before a destructive palette dispatch), and `search` (C2 — output-pane find
// opened by Ctrl+F, n/N/Enter advance the active match). Palette selections
// route through {@link handlePaletteSelect}, so destructive commands always
// pause at the confirm overlay before dispatch.

import { Box, type Key, Text, useApp, useInput } from 'ink';
import { type ReactElement, useEffect, useState } from 'react';
import type { StatusPayload } from '../commands/status.js';
import { c } from '../theme.js';
import { CommandInput } from './CommandInput.js';
import { captureProcessOutput } from './capture.js';
import { Footer } from './Footer.js';
import { formatStatusPayload } from './format.js';
import { Header } from './Header.js';
import { useInputBuffer } from './hooks/useInputBuffer.js';
import { OutputPane } from './OutputPane.js';
import { ConfirmOverlay } from './overlays/ConfirmOverlay.js';
import { computeMatches } from './overlays/SearchMode.js';
import { loadRecent } from './palette/history.js';
import { type FuzzyMatcher, handRolledMatcher } from './palette/matcher.js';
import { Palette } from './palette/Palette.js';
import type { PaletteCommand } from './palette/types.js';
import { StatusBar } from './StatusBar.js';

/**
 * Default recent-commands loader (C3): read the on-disk history and hydrate the
 * bare `{argv, id}` entries against the live `commands` so the palette renders
 * real labels/descriptions. Entries whose argv no longer exists in the command
 * tree are dropped (a command removed from a newer build vanishes from recents).
 */
function defaultLoadRecent(
  commands: readonly PaletteCommand[],
): () => Promise<readonly PaletteCommand[]> {
  const byId = new Map(commands.map((cmd) => [cmd.id, cmd]));
  return async () => {
    const entries = loadRecent();
    return entries.flatMap((entry) => {
      const cmd = byId.get(entry.id);
      return cmd ? [cmd] : [];
    });
  };
}

/** Injected dependencies (mirrors the `home(opts, deps)` seam). */
export interface TuiDeps {
  /**
   * Run a Noir sub-command by user-form argv on a fresh commander program.
   * Same contract as {@link HomeDeps.dispatch}: must not throw — it owns its
   * own error → exit-code mapping and leaves the outcome on `process.exitCode`.
   */
  dispatch: (argv: readonly string[]) => Promise<void>;
  /**
   * Fetch the live status snapshot. Defaults to a wrapper around
   * `gatherStatusPayload` that folds ANY failure to `null` so the dashboard
   * degrades cleanly (uninitialized project, daemon down, probe hiccup).
   */
  fetchStatus: () => Promise<StatusPayload | null>;
  /**
   * The palette source — one {@link PaletteCommand} per leaf `noir` subcommand,
   * derived from the commander tree at `noir tui` launch (NOT re-walked per
   * keystroke). Optional for backward-compat (B1 tests omit it); when absent the
   * palette falls back to an empty command list.
   */
  readonly commands?: readonly PaletteCommand[];
  /** The fuzzy matcher. Optional — defaults to {@link handRolledMatcher}. */
  readonly matcher?: FuzzyMatcher;
  /**
   * Record a dispatched command into the persisted recent-commands list
   * (C3). Optional for backward-compat — when absent, recents are not recorded.
   */
  record?: (argv: readonly string[]) => Promise<void>;
  /**
   * Load the persisted recent commands (newest first) for the palette's recent
   * section. Optional — when absent, defaults to the on-disk history loader.
   */
  loadRecent?: () => Promise<readonly PaletteCommand[]>;
}

/** Optional initial state for tests (the live entry leaves these at defaults). */
export interface AppProps {
  deps: TuiDeps;
  /** Initial snapshot — skips the first fetch when provided (tests). */
  initialPayload?: StatusPayload | null;
  /** Refresh interval in ms (default 5000). Set large in tests. */
  refreshMs?: number;
}

/**
 * The dashboard's discriminated screen union. Exactly one screen is active at a
 * time; the App keys its render + keybinding handler off `mode.kind`.
 * - `dashboard` — the default screen: live snapshot, command input, output pane.
 * - `palette` — the command palette overlay (added by B2).
 * - `search` — a full-dashboard search with a live query + result indices (C2).
 * - `confirm` — an in-TUI confirmation prompt for a destructive dispatch (C1).
 *
 * The `search` payload IS the {@link SearchState} — the query + the output-line
 * indices that match + the active-match cursor. It carries no per-mode state of
 * its own beyond that; the search input reads `mode.query`, and `mode.active`
 * is never `-1` once a query has at least one match (see
 * {@link handleSearchInput}). `palette` carries no payload (the registry is
 * fixed for the session); `confirm` carries the argv it is asking the user to
 * approve.
 */
export type Mode =
  | { kind: 'dashboard' }
  | { kind: 'palette' }
  | { kind: 'search'; query: string; matches: number[]; active: number }
  | { kind: 'confirm'; argv: string[] };

interface DispatchedOutput {
  title: string;
  lines: string[];
}

export function App({ deps, initialPayload = null, refreshMs = 5000 }: AppProps): ReactElement {
  const { exit } = useApp();
  // `recall` (Up/Down history walk) is part of the hook surface but is NOT
  // wired here yet — arrows must keep scrolling the output pane (B1 is
  // behavior-preserving); a later task moves the arrow bindings onto recall.
  const { buffer, setBuffer, pushHistory, clear } = useInputBuffer();
  // The active screen. B1 defaults to the dashboard; B2/C1 switch into palette /
  // confirm from their own entry keys.
  const [mode, setMode] = useState<Mode>({ kind: 'dashboard' });
  const [payload, setPayload] = useState<StatusPayload | null>(initialPayload);
  const [loading, setLoading] = useState(initialPayload === null);
  const [output, setOutput] = useState<DispatchedOutput | null>(null);
  // C2 — the output lines the search screen searches. Captured from the CURRENT
  // dispatched output when search opens, so a new dispatch landing mid-search
  // cannot change the corpus mid-filter.
  const [searchLines, setSearchLines] = useState<readonly string[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [help, setHelp] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The argv of a dispatch the user just submitted. An effect watches this so
  // the dispatch runs AFTER React flushes the "running…" frame — guaranteeing
  // the stream swap happens when Ink is idle (no mid-dispatch rerender).
  const [pending, setPending] = useState<string[] | null>(null);
  // The persisted recent-commands list for the palette (C3), loaded once on
  // mount. Empty until loaded; the palette renders the full list until then.
  const [recent, setRecent] = useState<readonly PaletteCommand[]>([]);

  // ----- load the palette's recent commands once on mount ------------------
  // `deps.loadRecent` (when provided) supplies fully-hydrated PaletteCommands;
  // otherwise the on-disk history (a plain {argv, id} list) is hydrated against
  // the live `commands` so the palette renders the real labels/descriptions.
  useEffect(() => {
    const loader = deps.loadRecent ?? defaultLoadRecent(deps.commands ?? []);
    let cancelled = false;
    void loader()
      .then((entries) => {
        if (!cancelled) setRecent(entries);
      })
      .catch(() => {
        // Recents are a nice-to-have — a read failure leaves the full list.
      });
    return () => {
      cancelled = true;
    };
  }, [deps.loadRecent, deps.commands]);

  // ----- snapshot refresh: paused while a dispatch is in flight ----------
  useEffect(() => {
    if (running) return; // pause refreshes during dispatch
    let cancelled = false;
    setLoading(true);
    void deps
      .fetchStatus()
      .then((p) => {
        if (!cancelled) {
          setPayload(p);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPayload(null);
          setLoading(false);
        }
      });
    const id = setInterval(() => {
      void deps
        .fetchStatus()
        .then((p) => {
          if (!cancelled) setPayload(p);
        })
        .catch(() => {
          /* keep the last good payload on a transient probe failure */
        });
    }, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, refreshMs, deps]);

  // ----- dispatch runner: fires after the "running" frame has flushed ------
  useEffect(() => {
    if (pending === null) return;
    const argv = pending;
    let active = true;
    const run = async (): Promise<void> => {
      const captured = await captureProcessOutput(() => deps.dispatch(argv));
      if (!active) return;
      const combined = `${captured.stdout}${captured.stderr}`;
      const lines = combined.split('\n');
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const title = `/${argv.join(' ')} → exit ${captured.exitCode}`;
      setOutput({ title, lines });
      setNotice(`ran /${argv.join(' ')} → exit ${captured.exitCode}`);
      setRunning(false);
      setPending(null);
      setScrollOffset(0);
    };
    void run();
    return () => {
      active = false;
    };
  }, [pending, deps]);

  // ----- shared dispatch helper (typed /command + palette selections) ------
  // Sets pending (→ effect) + running (→ frame + pause refresh) so Ink paints
  // the "running…" frame BEFORE the dispatch's stream swap starts. Same shape
  // the typed `/command` submit uses.
  function dispatchCmd(argv: readonly string[]): void {
    setOutput(null);
    setRunning(true);
    setPending([...argv]);
  }

  // ----- dashboard-mode keybinding handler -------------------------------
  // Every existing dashboard keybinding, moved verbatim out of the old single
  // `useInput` closure into a handler that fires when `mode.kind === 'dashboard'`.
  // Behavior-preserving: q / ? / Esc progressive-back / backspace / arrows /
  // Enter submit / ctrl-swallow / single + multi-char text are all unchanged.
  function handleDashboardInput(input: string, key: Key): void {
    if (running) return; // swallow keystrokes while a command is dispatching
    setNotice(null); // any keystroke clears the transient notice

    if (help) {
      if (input === '?' || key.escape || input === 'q') setHelp(false);
      return;
    }

    if (key.return) {
      submit();
      return;
    }
    if (key.escape) {
      // Progressive back: clear buffer → dismiss dispatched output → quit.
      if (buffer.length > 0) clear();
      else if (output !== null) setOutput(null);
      else exit();
      return;
    }
    if (key.backspace || key.delete) {
      setBuffer((b) => b.slice(0, -1));
      return;
    }
    if (key.upArrow) {
      setScrollOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.downArrow) {
      setScrollOffset((o) => o + 1); // OutputPane clamps to content height
      return;
    }
    if (key.ctrl) {
      // Ctrl+K opens the palette (before the generic ctrl-swallow).
      if (input === 'k') {
        openPalette();
        return;
      }
      // Ctrl+F opens output search (C2) — only when there is dispatched output
      // to search. The '/' dispatch prefix makes '/' unusable as a search key,
      // so Ctrl+F is the entry (documented in SearchMode.ts).
      if (input === 'f' && output !== null) {
        openSearch();
        return;
      }
      return; // ignore other Ctrl-combos (Ctrl+C is handled by Ink)
    }
    // Single-char input (the normal per-keystroke case): check the buffer-empty
    // global keys (q quits, ? toggles help) BEFORE treating it as text.
    if (input.length === 1) {
      if (buffer.length === 0) {
        if (input === 'q') {
          exit();
          return;
        }
        if (input === '?') {
          setHelp(true);
          return;
        }
      }
      setBuffer((b) => b + input);
      return;
    }
    // Multi-char input (a pasted string, or a batched test write): append it
    // verbatim as text. The q/? globals do NOT fire for batched input — a paste
    // that happens to start with 'q' must not quit the dashboard.
    if (input.length > 1) {
      setBuffer((b) => b + input);
    }
  }

  // ----- dashboard-mode keybinding additions (B2 / C2) ---------------------
  // Ctrl+K opens the palette from the dashboard (handled above, before the
  // generic ctrl-swallow). Ctrl+F opens output search (handled above, gated on
  // dispatched output being present).
  function openPalette(): void {
    setMode({ kind: 'palette' });
    setNotice(null);
  }

  // C2 — open output search over the CURRENT dispatched output. `lines` is
  // captured eagerly so the search is stable against a dispatch landing mid-
  // search; the fresh empty search state recomputes matches on the first key.
  function openSearch(): void {
    if (output === null) return;
    setSearchLines(output.lines);
    setMode({ kind: 'search', query: '', matches: [], active: -1 });
    setNotice(null);
  }

  // ----- palette / confirm selection handlers ------------------------------
  // The single decision point for a palette-selected command. Destructive
  // commands pause at the confirm overlay; everything else dispatches through
  // the same deps.dispatch seam + recency recording the typed /command uses.
  function handlePaletteSelect(cmd: PaletteCommand): void {
    if (cmd.destructive) {
      setMode({ kind: 'confirm', argv: [...cmd.argv] });
      return;
    }
    dispatchCmd([...cmd.argv]);
    void recordRuns([...cmd.argv]);
    setMode({ kind: 'dashboard' });
  }

  function handleConfirmApprove(): void {
    if (mode.kind !== 'confirm') return;
    dispatchCmd([...mode.argv]);
    void recordRuns([...mode.argv]);
    setMode({ kind: 'dashboard' });
  }

  function handleConfirmDecline(): void {
    // Back to the palette (the destructive command was not dispatched).
    setMode({ kind: 'palette' });
  }

  // Record a palette-dispatched command into the persisted recents (C3).
  function recordRuns(argv: readonly string[]): void {
    const recorder = deps.record;
    if (recorder) void recorder(argv);
  }

  // ----- confirm-mode keybinding handler ----------------------------------
  // y approves (dispatch + record + back to dashboard); n / Esc decline (back
  // to the palette, nothing dispatched).
  function handleConfirmInput(input: string, key: Key): void {
    if (key.escape || input === 'n' || input === 'N') {
      handleConfirmDecline();
      return;
    }
    if (input === 'y' || input === 'Y') {
      handleConfirmApprove();
      return;
    }
  }

  // ----- search-mode keybinding handler (C2) -------------------------------
  // The search screen routes its OWN keys here (the App's single useInput):
  // typing appends to the query and recomputes the matches against the
  // captured output lines; n / Enter advance the active match (wrapping); N
  // steps back (wrapping); backspace edits the query; Esc returns to the
  // dashboard. All navigation recomputes the active index from the match list,
  // so the active line can never point at a non-matching line.
  function handleSearchInput(input: string, key: Key): void {
    if (mode.kind !== 'search') return;
    if (key.escape) {
      setMode({ kind: 'dashboard' });
      return;
    }
    if (key.backspace || key.delete) {
      const nextQuery = mode.query.slice(0, -1);
      setMode(searchFor(nextQuery));
      return;
    }
    if (key.ctrl) return; // swallow other Ctrl-combos (Ctrl+C is handled by Ink)
    if (key.return) {
      advanceActive(1);
      return;
    }
    // `n`/`N` navigate ONLY when the query already has matches. When there are
    // none, they fall through to normal typing — otherwise the letter 'n' (the
    // most common in the English alphabet) could never be entered into a search
    // query. Once a query matches, 'n' becomes navigation again.
    if (input === 'n' && mode.matches.length > 0) {
      advanceActive(1);
      return;
    }
    if (input === 'N' && mode.matches.length > 0) {
      advanceActive(-1);
      return;
    }
    if (input.length > 0) {
      setMode(searchFor(mode.query + input));
    }
  }

  // Rebuild a search mode from a (possibly edited) query against the captured
  // corpus. Matches recompute from scratch; an empty query has none.
  function searchFor(query: string): Extract<Mode, { kind: 'search' }> {
    const matches = computeMatches(searchLines, query);
    return { kind: 'search', query, matches, active: matches.length > 0 ? 0 : -1 };
  }

  // Move the active match by `delta` (+1 next, -1 prev), wrapping around the
  // match list. No-op when there is no match to land on.
  function advanceActive(delta: number): void {
    if (mode.kind !== 'search') return;
    const n = mode.matches.length;
    if (n === 0) return;
    const next = (mode.active + delta + n) % n;
    setMode({ ...mode, active: next });
  }

  // ----- keybinding dispatcher -------------------------------------------
  // One `useInput` for the whole App, gated per-mode. The palette owns its own
  // input (its useInput consumes palette keystrokes); the confirm and search
  // branches are handled here. `isActive` is NOT turned off per-mode — each
  // branch returns early for keys it does not own.
  useInput((input, key) => {
    switch (mode.kind) {
      case 'dashboard':
        handleDashboardInput(input, key);
        return;
      case 'palette':
        return; // Palette renders its own useInput; no App-level keys here
      case 'confirm':
        handleConfirmInput(input, key);
        return;
      case 'search':
        handleSearchInput(input, key);
        return;
    }
  });

  function submit(): void {
    const text = buffer;
    if (text.length === 0) return;
    clear(); // empty the buffer + park the recall cursor (behavioral twin of the old setBuffer(''))
    if (!text.startsWith('/')) {
      // Bare text is a hint, not a dispatch.
      setNotice('type a /command to run it (bare text is just a hint)');
      return;
    }
    const argv = text
      .slice(1)
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (argv.length === 0) {
      setNotice('empty /command');
      return;
    }
    // Record the runnable command into history. History is a ref — invisible to
    // the render, so this keeps submit behavior-identical while the hook's
    // Up/Down recall surface (wired by a later task) has data to walk.
    pushHistory(text);
    // Setting pending (→ effect) + running (→ frame + pause refresh) lets Ink
    // paint the "running…" frame BEFORE the dispatch's stream swap starts.
    dispatchCmd(argv);
  }

  // ----- render -----------------------------------------------------------
  if (help) {
    return <Help />;
  }

  if (mode.kind === 'palette') {
    return (
      <Box flexDirection="column">
        <Header tagline="palette" />
        <Palette
          commands={deps.commands ?? []}
          matcher={deps.matcher ?? handRolledMatcher}
          recent={recent}
          onSelect={handlePaletteSelect}
          onClose={() => setMode({ kind: 'dashboard' })}
        />
        <Footer running={false} />
      </Box>
    );
  }

  if (mode.kind === 'confirm') {
    return (
      <Box flexDirection="column">
        <Header tagline="confirm" />
        <ConfirmOverlay argv={mode.argv} />
        <Footer running={false} />
      </Box>
    );
  }

  if (mode.kind === 'search') {
    const activeLine = mode.active >= 0 ? mode.matches[mode.active] : undefined;
    const matchCount = mode.matches.length;
    return (
      <Box flexDirection="column">
        <Header tagline="search" />
        <OutputPane
          lines={searchLines}
          scrollOffset={scrollOffset}
          title={output?.title}
          highlightQuery={mode.query}
          activeLine={activeLine}
        />
        <Text>
          {c.dim('search: ')}
          {mode.query.length > 0 ? mode.query : c.dim('(type to filter output)')}
          <Text>{c.dim(' ▌')}</Text>
        </Text>
        <Text>
          {c.dim(
            matchCount === 0
              ? 'no matches · Esc exit'
              : `${mode.active + 1}/${matchCount} matches · n/Enter next · N prev · Esc exit`,
          )}
        </Text>
        <Footer running={false} />
      </Box>
    );
  }

  const snapshotLines = formatStatusPayload(payload);
  const paneLines = output?.lines ?? snapshotLines ?? [];
  const paneTitle = output?.title ?? 'snapshot';

  return (
    <Box flexDirection="column">
      <Header tagline="dashboard" />
      <StatusBar payload={payload} loading={loading} />
      <OutputPane lines={paneLines} scrollOffset={scrollOffset} title={paneTitle} />
      <CommandInput buffer={buffer} running={running} />
      {notice !== null ? <Text>{c.dim(notice)}</Text> : null}
      <Footer running={running} />
    </Box>
  );
}

function Help(): ReactElement {
  return (
    <Box flexDirection="column">
      <Header tagline="help" />
      <Text> </Text>
      <Text>{c.bold('Keybindings')}</Text>
      <Text>
        {c.dim('  /&lt;command&gt;  run a Noir sub-command (e.g. /status, /sync, /task next)')}
      </Text>
      <Text>{c.dim('  Enter       run the typed /command')}</Text>
      <Text>{c.dim('  Esc         back: clear input → dismiss output → quit')}</Text>
      <Text>{c.dim('  q           quit (when the input is empty)')}</Text>
      <Text>{c.dim('  ↑ / ↓       scroll the output pane')}</Text>
      <Text>{c.dim('  ?           toggle this help')}</Text>
      <Text>{c.dim('  Ctrl+K      open the command palette')}</Text>
      <Text>{c.dim('  Ctrl+F      find in the dispatched output pane')}</Text>
      <Text>{c.dim('  n / N       next / previous match in search (Enter = next)')}</Text>
      <Text>{c.dim('  y / n       approve / decline a destructive command prompt')}</Text>
      <Text>{c.dim('  Ctrl+C      force exit')}</Text>
      <Text> </Text>
      <Text>{c.bold('Commands')}</Text>
      <Text>{c.dim('  Dispatched through the same routing as `noir` at the prompt.')}</Text>
      <Text>
        {c.dim(
          '  /status /sync /doctor /context search &lt;q&gt; /task next /memory recall &lt;q&gt;',
        )}
      </Text>
      <Text>
        {c.dim('  Commands that need their own interactive prompts (e.g. a /sync with a')}
      </Text>
      <Text>{c.dim('  conflict) are best run directly — exit first with q.')}</Text>
      <Text> </Text>
      <Text>{c.dim('press ? / Esc / q to close this help')}</Text>
    </Box>
  );
}
