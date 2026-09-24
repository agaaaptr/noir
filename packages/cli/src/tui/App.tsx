// Dashboard root component. Owns the interactive state (input buffer, scroll
// offset, dispatched output, snapshot, palette query/active, the active screen)
// and the SINGLE keybinding dispatcher (v2 — the palette, home, help, and search
// surfaces all collapsed into one corpus-aware palette, so keyboard routing
// lives here alone). The snapshot is fetched via {@link TuiDeps.fetchStatus} on
// a short interval (paused while a `/<command>` is dispatching, so a StatusBar
// refresh can never race the stream capture). Dispatch goes through the EXISTING
// {@link TuiDeps.dispatch} seam — the same `home(opts, deps).dispatch` shape —
// so command routing is NOT reimplemented here.
//
// Screens (the {@link Mode} union): `dashboard` (default), `palette` (the single
// command surface — corpus `commands` | `output` | `help`, opened by Ctrl+K /
// Ctrl+F / h / ? and cycled with Tab), `confirm` (the `y/N` gate before a
// destructive dispatch — now covering EVERY dispatch path, typed /command
// included), `run` (the live host-run screen) and `transcripts` (the read-only
// transcript picker). Every selection funnels through {@link handleRun}, so
// destructive commands always pause at the confirm overlay — and the two
// self-contained screens own their own keyboards rather than routing keys here.

import { Box, type Key, Text, useApp, useInput } from 'ink';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import type { StatusPayload } from '../commands/status.js';
import { c, divider } from '../theme.js';
import { CommandInput } from './CommandInput.js';
import { captureProcessOutput } from './capture.js';
import { isDestructive, runPromptFrom } from './commands/registry.js';
import { type HomeSection, resolveSections } from './commands/sections.js';
import { Footer } from './Footer.js';
import { formatStatusPayload } from './format.js';
import { Header } from './Header.js';
import { useInputBuffer } from './hooks/useInputBuffer.js';
import { type RunDeps, RunMode } from './modes/run.js';
import { TranscriptPicker } from './modes/transcripts.js';
import { OutputPane } from './OutputPane.js';
import { ConfirmOverlay } from './overlays/ConfirmOverlay.js';
import { Panel, panelTextWidth } from './Panel.js';
import { type FuzzyMatcher, handRolledMatcher } from './palette/matcher.js';
import { Palette } from './palette/Palette.js';
import { buildPaletteRows, CORPORA, type Corpus } from './palette/rows.js';
import type { PaletteCommand } from './palette/types.js';
import { StatusBar } from './StatusBar.js';

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
   * keystroke). Optional for backward-compat (the unit tests omit it); when
   * absent the palette falls back to an empty command list.
   */
  readonly commands?: readonly PaletteCommand[];
  /** The fuzzy matcher. Optional — defaults to {@link handRolledMatcher}. */
  readonly matcher?: FuzzyMatcher;
  /**
   * Record a dispatched command into the persisted recent-commands list.
   * Optional for backward-compat — when absent, recents are not recorded.
   */
  record?: (argv: readonly string[]) => Promise<void>;
  /**
   * Load the persisted recent commands (newest first) for the palette's recent
   * section. Optional — when absent, defaults to the on-disk history loader.
   */
  loadRecent?: () => Promise<readonly PaletteCommand[]>;
  /**
   * The host-run seams (spawn, post-run actions, transcripts). Optional: with
   * it absent a `run` command dispatches like any other and its output is
   * captured into the pane, which is what every other caller and every older
   * test expects.
   */
  run?: RunDeps;
}

/** Optional initial state for tests (the live entry leaves these at defaults). */
export interface AppProps {
  deps: TuiDeps;
  /** Initial snapshot — skips the first fetch when provided (tests). */
  initialPayload?: StatusPayload | null;
  /** Refresh interval in ms (default 5000). Set large in tests. */
  refreshMs?: number;
  /**
   * The mode the App starts in. Defaults to the dashboard. `noir palette`
   * mounts the app palette-first via `{ kind: 'palette', corpus: 'commands' }`.
   */
  initialMode?: Mode;
}

/**
 * The dashboard's discriminated screen union. Exactly one screen is active at a
 * time; the App keys its render + keybinding handler off `mode.kind`.
 * - `dashboard` — the default screen: live snapshot, command input, output pane.
 * - `palette` — the single command surface, with a `corpus` selecting what the
 *   query filters (commands / output / help). `collecting` is set while the
 *   selected command's argument is being typed.
 * - `confirm` — an in-TUI confirmation prompt for a destructive dispatch.
 */
export type Mode =
  | { kind: 'dashboard' }
  | { kind: 'palette'; corpus: Corpus; collecting?: ArgCollection }
  | { kind: 'confirm'; argv: string[] }
  | { kind: 'run'; prompt: string }
  | { kind: 'transcripts' };

/**
 * A command waiting for its argument: the argv to dispatch once one is typed,
 * the label naming that value, and whether the dispatch then needs confirming.
 */
interface ArgCollection {
  readonly argv: string[];
  readonly label: string;
  readonly destructive: boolean;
}

interface DispatchedOutput {
  title: string;
  lines: string[];
}

export function App({
  deps,
  initialPayload = null,
  refreshMs = 5000,
  initialMode = { kind: 'dashboard' },
}: AppProps): ReactElement {
  const { exit } = useApp();
  const { buffer, setBuffer, pushHistory, recall, clear, seed } = useInputBuffer();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [payload, setPayload] = useState<StatusPayload | null>(initialPayload);
  const [loading, setLoading] = useState(initialPayload === null);
  const [output, setOutput] = useState<DispatchedOutput | null>(null);
  // The output lines the `output` corpus searches. Captured from the CURRENT
  // dispatched output when the corpus opens, so a new dispatch landing mid-search
  // cannot change the corpus mid-filter.
  const [searchLines, setSearchLines] = useState<readonly string[]>([]);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The argv of a dispatch the user just submitted. An effect watches this so
  // the dispatch runs AFTER React flushes the "running…" frame.
  const [pending, setPending] = useState<string[] | null>(null);
  // The persisted recent-commands list for the palette, loaded once on mount.
  const [recent, setRecent] = useState<readonly PaletteCommand[]>([]);
  // The curated home sections, resolved against the live registry once.
  const [homeSections, setHomeSections] = useState<readonly HomeSection[]>([]);
  // v2 — the single palette's query + active row (owned here so the App's one
  // `useInput` routes palette keys and can resolve the active row on Enter).
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteActive, setPaletteActive] = useState(0);
  // The argument being typed for the selected command (only meaningful while
  // the palette is collecting one), plus the one-line notice shown when the
  // user submits an empty one.
  const [argBuffer, setArgBuffer] = useState('');
  const [argNotice, setArgNotice] = useState<string | null>(null);

  // Load the palette's recent commands once on mount.
  useEffect(() => {
    if (!deps.loadRecent) return;
    const loader = deps.loadRecent;
    let cancelled = false;
    void loader()
      .then((entries) => {
        if (!cancelled) {
          setRecent(entries);
          // Seed the shell-recall overlay from the SAME persisted recents the
          // palette shows, so ↑/↓ recall and the palette recents never diverge.
          seed(entries.map((c) => `/${c.argv.join(' ')}`));
        }
      })
      .catch(() => {
        // Recents are a nice-to-have — a read failure leaves the full list.
      });
    return () => {
      cancelled = true;
    };
  }, [deps.loadRecent, seed]);

  // Resolve the curated home sections once.
  useEffect(() => {
    let cancelled = false;
    void resolveSections(deps.commands ?? []).then((sections) => {
      if (!cancelled) setHomeSections(sections);
    });
    return () => {
      cancelled = true;
    };
  }, [deps.commands]);

  // Snapshot refresh, paused while a dispatch is in flight.
  useEffect(() => {
    // Pause polling while a dispatch runs OR the palette/confirm overlay is
    // open (the dashboard snapshot is off-screen then, so polling only wastes
    // a fetch + a re-render).
    if (running || mode.kind !== 'dashboard') return;
    let cancelled = false;
    let inFlight = false;
    const fetched = (p: StatusPayload | null): void => {
      inFlight = false;
      if (cancelled) return;
      setPayload(p);
      setLoading(false);
    };
    setLoading(true);
    inFlight = true;
    void deps
      .fetchStatus()
      .then(fetched)
      .catch(() => fetched(null));
    const id = setInterval(() => {
      // Skip the tick while a fetch is still pending — a slow/restarting daemon
      // (gatherStatusPayload does a probe + MCP round-trips) must not stack
      // concurrent fetches.
      if (inFlight) return;
      inFlight = true;
      void deps
        .fetchStatus()
        .then(fetched)
        .catch(() => {
          // Keep the last-good payload on a transient probe/daemon failure — a
          // poll-time hiccup must not wipe the dashboard to "down".
          inFlight = false;
        });
    }, refreshMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [running, mode.kind, refreshMs, deps.fetchStatus]);

  // Dispatch runner, fired after the "running" frame has flushed.
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
  }, [pending, deps.dispatch]);

  // Shared dispatch helper.
  function dispatchCmd(argv: readonly string[]): void {
    setOutput(null);
    setRunning(true);
    setPending([...argv]);
  }

  // Unified run seam: every selection path (palette / home / confirm).
  function handleRun(argv: readonly string[], destructive: boolean): void {
    if (destructive) {
      setMode({ kind: 'confirm', argv: [...argv] });
      return;
    }
    enterRunOrDispatch(argv);
  }

  /**
   * The `run <prompt>` command has two homes. When the run seams are wired, it
   * opens the live run screen (the host streams into the pane). Otherwise — and
   * for every other command, and for a `run` that carries flags — it is an
   * ordinary dispatch whose output is captured into the pane.
   */
  function enterRunOrDispatch(argv: readonly string[]): void {
    const prompt = deps.run === undefined ? null : runPromptFrom(argv);
    if (prompt !== null) {
      setMode({ kind: 'run', prompt });
      return;
    }
    dispatchCmd([...argv]);
    void recordRuns([...argv]);
    pushHistory(`/${argv.join(' ')}`);
    setMode({ kind: 'dashboard' });
  }

  function recordRuns(argv: readonly string[]): void {
    const recorder = deps.record;
    if (recorder) void recorder(argv);
  }

  // Palette open / cycle helpers.
  function openPalette(corpus: Corpus): void {
    setPaletteQuery('');
    setPaletteActive(0);
    setMode({ kind: 'palette', corpus });
    setNotice(null);
  }

  function openOutputSearch(): void {
    if (output === null) return;
    setSearchLines(output.lines);
    openPalette('output');
  }

  function nextCorpus(current: Corpus): Corpus {
    const idx = CORPORA.indexOf(current);
    const candidates = [...CORPORA.slice(idx + 1), ...CORPORA.slice(0, idx + 1)];
    for (const corpus of candidates) {
      if (corpus === 'output' && output === null) continue; // no output to search
      return corpus;
    }
    return 'commands';
  }

  // Dashboard-mode keybinding handler.
  function handleDashboardInput(input: string, key: Key): void {
    if (running) return;
    setNotice(null);

    if (key.return) {
      submit();
      return;
    }
    if (key.escape) {
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
      if (buffer === '/') {
        const entry = recall('up');
        if (entry !== null) {
          setBuffer(() => entry);
          return;
        }
      }
      setScrollOffset((o) => Math.max(0, o - 1));
      return;
    }
    if (key.downArrow) {
      if (buffer === '/') {
        const entry = recall('down');
        if (entry !== null) {
          setBuffer(() => entry);
          return;
        }
      }
      setScrollOffset((o) => o + 1);
      return;
    }
    if (key.ctrl) {
      if (input === 'k') {
        openPalette('commands');
        return;
      }
      if (input === 'f' && output !== null) {
        openOutputSearch();
        return;
      }
      if (input === 't' && deps.run?.transcripts !== undefined) {
        setMode({ kind: 'transcripts' });
        return;
      }
      return;
    }
    if (input.length === 1) {
      if (buffer.length === 0) {
        if (input === 'q') {
          exit();
          return;
        }
        if (input === '?') {
          openPalette('help');
          return;
        }
        if (input === 'h') {
          openPalette('commands');
          return;
        }
      }
      setBuffer((b) => b + input);
      return;
    }
    if (input.length > 1) {
      setBuffer((b) => b + input);
    }
  }

  // Palette-mode keybinding handler (single router).
  // Clamp the active cursor to the FULL row list. The renderer slides a
  // VISIBLE_ROWS window over the list, so the cursor (and Enter) can reach
  // every row, not just the first ten.
  function moveActive(delta: number): void {
    const max = Math.max(0, paletteRows.length - 1);
    setPaletteActive((a) => Math.min(max, Math.max(0, a + delta)));
  }

  function handlePaletteInput(input: string, key: Key): void {
    if (mode.kind !== 'palette') return;
    if (mode.collecting !== undefined) {
      handleArgInput(input, key, mode.collecting);
      return;
    }
    if (key.escape) {
      setPaletteQuery('');
      setPaletteActive(0);
      setMode({ kind: 'dashboard' });
      return;
    }
    if (key.tab) {
      setMode({ kind: 'palette', corpus: nextCorpus(mode.corpus) });
      setPaletteQuery('');
      setPaletteActive(0);
      return;
    }
    if (mode.corpus === 'help') {
      if (key.upArrow) moveActive(-1);
      else if (key.downArrow) moveActive(1);
      return; // help corpus takes no typing
    }
    if (key.return) {
      if (mode.corpus === 'commands') {
        const row = paletteRows[paletteActive];
        if (!row?.argv) return;
        if (row.needsArg !== undefined) {
          // The command cannot run bare — collect its argument on the input
          // line before anything dispatches.
          setArgBuffer('');
          setArgNotice(null);
          setMode({
            kind: 'palette',
            corpus: mode.corpus,
            collecting: {
              argv: [...row.argv],
              label: row.needsArg,
              destructive: row.destructive,
            },
          });
          return;
        }
        handleRun(row.argv, row.destructive);
      } else {
        moveActive(1); // output corpus: next match
      }
      return;
    }
    if (key.upArrow) {
      moveActive(-1);
      return;
    }
    if (key.downArrow) {
      moveActive(1);
      return;
    }
    if (key.backspace || key.delete) {
      setPaletteQuery((q) => q.slice(0, -1));
      setPaletteActive(0);
      return;
    }
    if (key.ctrl) return;
    if (input.length > 0) {
      setPaletteQuery((q) => q + input);
      setPaletteActive(0);
    }
  }

  // Argument-collection keybinding handler.
  // The input line now carries the command's argument: Enter dispatches the
  // command with it appended (through the same confirm gate as any other
  // selection), and Esc drops back to the filter with the query untouched.
  function handleArgInput(input: string, key: Key, collecting: ArgCollection): void {
    if (mode.kind !== 'palette') return;
    const corpus = mode.corpus;
    if (key.escape) {
      setArgBuffer('');
      setArgNotice(null);
      setMode({ kind: 'palette', corpus });
      return;
    }
    if (key.return) {
      const value = argBuffer.trim();
      if (value.length === 0) {
        // An empty value would dispatch the same bare argv the palette cannot
        // run — hold the step open and say why, so Enter is never a silent
        // no-op.
        setArgNotice(`a ${collecting.label} is required`);
        return;
      }
      setArgBuffer('');
      setArgNotice(null);
      handleRun([...collecting.argv, value], collecting.destructive);
      return;
    }
    if (key.backspace || key.delete) {
      setArgBuffer((b) => b.slice(0, -1));
      setArgNotice(null);
      return;
    }
    // Tab cycles the corpus in the filter; here it would only add a stray
    // character to the argument.
    if (key.ctrl || key.tab) return;
    if (input.length > 0) {
      setArgBuffer((b) => b + input);
      setArgNotice(null);
    }
  }

  // Confirm-mode keybinding handler.
  function handleConfirmInput(input: string, key: Key): void {
    if (key.escape || input === 'n' || input === 'N') {
      // Back to the palette with a clean query so the full list is visible.
      setPaletteQuery('');
      setPaletteActive(0);
      setMode({ kind: 'palette', corpus: 'commands' });
      return;
    }
    if (input === 'y' || input === 'Y') {
      if (mode.kind !== 'confirm') return;
      // The confirmed argv goes through the same run-or-dispatch split as an
      // unconfirmed one: `y` approves the run, it does not choose how it runs.
      enterRunOrDispatch(mode.argv);
    }
  }

  // Keybinding dispatcher (a single useInput for the whole App).
  useInput((input, key) => {
    // Ctrl+C leaves the dashboard, as it always has — except while a host is
    // live, where the run screen takes it as "stop the host" (the same thing Esc
    // means there). Ink's own Ctrl+C exit is turned off at the entry point so
    // this is the one place that decides: a keystroke can never tear the frame
    // down from under a screen that still has a child process to stop.
    if (key.ctrl && input === 'c') {
      if (mode.kind !== 'run') exit();
      return;
    }
    switch (mode.kind) {
      case 'dashboard':
        handleDashboardInput(input, key);
        return;
      case 'palette':
        handlePaletteInput(input, key);
        return;
      case 'confirm':
        handleConfirmInput(input, key);
        return;
      case 'run':
      case 'transcripts':
        // These screens own their keyboard: the run screen takes Esc to cancel
        // a host, the picker takes arrows to browse. Routing their keys here as
        // well would give one keystroke two meanings.
        return;
    }
  });

  function submit(): void {
    const text = buffer;
    if (text.length === 0) return;
    clear();
    if (!text.startsWith('/')) {
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
    if (isDestructive(argv)) {
      // Destructive typed /commands go through the SAME confirm gate the
      // palette uses (v2 — closes the old typed-path bypass).
      setMode({ kind: 'confirm', argv });
      return;
    }
    pushHistory(text);
    dispatchCmd(argv);
    void recordRuns(argv);
  }

  // The rows for the active palette corpus, memoized so the dashboard hot path
  // (every keystroke + snapshot poll) does NOT rebuild ~60 row objects. Only
  // recompute when a palette input actually changes.
  const paletteRows = useMemo(
    () =>
      buildPaletteRows({
        corpus: mode.kind === 'palette' ? mode.corpus : 'commands',
        query: paletteQuery,
        commands: deps.commands ?? [],
        matcher: deps.matcher ?? handRolledMatcher,
        recent,
        homeSections,
        outputLines: searchLines,
      }),
    [mode, paletteQuery, deps.commands, deps.matcher, recent, homeSections, searchLines],
  );

  // Render the view for the active mode.
  if (mode.kind === 'palette') {
    const collecting = mode.collecting;
    return (
      <Box flexDirection="column">
        <Header tagline={`palette · ${mode.corpus}`} />
        <Palette
          corpus={mode.corpus}
          query={paletteQuery}
          active={paletteActive}
          rows={paletteRows}
          arg={
            collecting === undefined
              ? undefined
              : {
                  value: argBuffer,
                  placeholder: `${collecting.label} for ${collecting.argv.join(' ')}…`,
                  hint: argNotice ?? undefined,
                }
          }
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

  if (mode.kind === 'run' && deps.run !== undefined) {
    return (
      <RunMode
        prompt={mode.prompt}
        deps={deps.run}
        onQuit={exit}
        onExit={(notice) => {
          if (notice !== undefined) setNotice(notice);
          setMode({ kind: 'dashboard' });
        }}
      />
    );
  }

  const transcripts = deps.run?.transcripts;
  if (mode.kind === 'transcripts' && transcripts !== undefined) {
    return (
      <TranscriptPicker transcripts={transcripts} onExit={() => setMode({ kind: 'dashboard' })} />
    );
  }

  const snapshotLines = formatStatusPayload(payload);
  const paneLines = output?.lines ?? snapshotLines ?? [];
  const paneTitle = output?.title ?? 'snapshot';

  return (
    <Box flexDirection="column">
      <Header tagline="dashboard" />
      <Panel>
        <Box paddingX={1}>
          <StatusBar payload={payload} loading={loading} />
        </Box>
        <Box paddingX={1}>
          <Text>{divider(panelTextWidth(1))}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1}>
          <OutputPane lines={paneLines} scrollOffset={scrollOffset} title={paneTitle} />
        </Box>
      </Panel>
      <CommandInput buffer={buffer} running={running} />
      {notice !== null ? <Text>{c.dim(notice)}</Text> : null}
      <Footer running={running} />
    </Box>
  );
}
