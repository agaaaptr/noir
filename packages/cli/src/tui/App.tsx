// Dashboard root component. Owns the interactive state (input buffer, scroll
// offset, dispatched output, snapshot, help overlay) and the single keybinding
// dispatcher. The snapshot is fetched via {@link TuiDeps.fetchStatus} on a
// short interval (paused while a `/<command>` is dispatching, so a StatusBar
// refresh can never race the stream capture). Dispatch goes through the
// EXISTING {@link TuiDeps.dispatch} seam — the same `home(opts, deps).dispatch`
// shape — so command routing is NOT reimplemented here.

import { Box, Text, useApp, useInput } from 'ink';
import { type ReactElement, useEffect, useState } from 'react';
import type { StatusPayload } from '../commands/status.js';
import { c } from '../theme.js';
import { CommandInput } from './CommandInput.js';
import { captureProcessOutput } from './capture.js';
import { Footer } from './Footer.js';
import { formatStatusPayload } from './format.js';
import { Header } from './Header.js';
import { OutputPane } from './OutputPane.js';
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
}

/** Optional initial state for tests (the live entry leaves these at defaults). */
export interface AppProps {
  deps: TuiDeps;
  /** Initial snapshot — skips the first fetch when provided (tests). */
  initialPayload?: StatusPayload | null;
  /** Refresh interval in ms (default 5000). Set large in tests. */
  refreshMs?: number;
}

interface DispatchedOutput {
  title: string;
  lines: string[];
}

export function App({ deps, initialPayload = null, refreshMs = 5000 }: AppProps): ReactElement {
  const { exit } = useApp();
  const [buffer, setBuffer] = useState('');
  const [payload, setPayload] = useState<StatusPayload | null>(initialPayload);
  const [loading, setLoading] = useState(initialPayload === null);
  const [output, setOutput] = useState<DispatchedOutput | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [help, setHelp] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The argv of a dispatch the user just submitted. An effect watches this so
  // the dispatch runs AFTER React flushes the "running…" frame — guaranteeing
  // the stream swap happens when Ink is idle (no mid-dispatch rerender).
  const [pending, setPending] = useState<string[] | null>(null);

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

  // ----- keybinding dispatcher -------------------------------------------
  useInput((input, key) => {
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
      if (buffer.length > 0) setBuffer('');
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
    if (key.ctrl) return; // ignore other Ctrl-combos (Ctrl+C is handled by Ink)
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
  });

  function submit(): void {
    const text = buffer;
    if (text.length === 0) return;
    setBuffer('');
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
    // Setting pending (→ effect) + running (→ frame + pause refresh) lets Ink
    // paint the "running…" frame BEFORE the dispatch's stream swap starts.
    setOutput(null);
    setRunning(true);
    setPending(argv);
  }

  // ----- render -----------------------------------------------------------
  if (help) {
    return <Help />;
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
