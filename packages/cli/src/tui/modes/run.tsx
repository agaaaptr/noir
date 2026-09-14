// The run screen: drive the host and watch it work.
//
// This is the TUI's own host-driven mode. It does NOT dispatch a command and
// capture its output — it spawns through the injected run seam, folds the
// host's normalized events into state, and lets Ink render frames normally.
// That distinction is load-bearing: the dispatch path swaps
// `process.stdout.write` for a collector, and Ink draws by calling that same
// function, so a captured run would swallow its own frames. Host output here is
// data, never a write.
//
// Everything the screen shows is derived from one place: the run's stream
// state, the clock, and the phase. The phase is a small machine — a host is
// either running, asking what to do with an answer, waiting for the value an
// action needs, working on it, or finished. Esc means "get me out of here" at
// every step: it asks the host to stop, backs out of a value, and closes the
// screen once there is nothing left to wait for. A cancelled run does not wait
// for a second keystroke — it leaves as soon as the host has actually stopped.

import { Box, Text, useInput } from 'ink';
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NoirEvent, RunHostResult } from '../../orchestrator.js';
import type { PostRunAction, PostRunMenuOption, PostRunOutcome } from '../../run-actions.js';
import { humanizeElapsed } from '../../run-status.js';
import { c, divider } from '../../theme.js';
import { captureProcessOutput } from '../capture.js';
import { Header } from '../Header.js';
import { RUN_CANCEL_HINT, RUN_HINT } from '../hints.js';
import { OutputPane } from '../OutputPane.js';
import { PostRunOverlay, type PostRunValueStep } from '../overlays/PostRunOverlay.js';
import { Panel } from '../Panel.js';
import { RunStream, type RunStreamSnapshot } from '../run-stream.js';
import { StatusBar } from '../StatusBar.js';
import type { TranscriptStore } from '../transcripts.js';

/** What the run seam is handed while it works. */
export interface RunStartHandlers {
  /** One normalized host event, as it arrives. */
  readonly onEvent: (event: NoirEvent) => void;
  /** One raw stream-json line, for the transcript. */
  readonly onLine: (line: string) => void;
  /** Aborting this asks the host to stop; the run still resolves normally. */
  readonly signal: AbortSignal;
}

/** A run in progress: the binary being driven, and how it ends. */
export interface RunSession {
  /** The binary being driven — what the failure text and the status line name. */
  readonly binary: string;
  readonly done: Promise<RunHostResult>;
}

/**
 * Start a host run for `prompt`. The implementation owns profile resolution
 * (which binary, which env, which extra args) and the spawn; the screen owns
 * the rendering. `resumeSessionId` continues a session an earlier run started.
 */
export type RunStarter = (
  prompt: string,
  handlers: RunStartHandlers,
  resumeSessionId?: string,
) => RunSession;

/** What a finished run hands the post-run action set. */
export interface RunActionRequest {
  readonly answer: string;
  readonly transcript: string;
  readonly sessionId?: string;
  readonly host: string;
  /** Whether a continuation is on offer (the host reported a session id). */
  readonly canContinue?: boolean;
}

/** The action seams the run screen needs, injected so no test spawns a host. */
export interface RunDeps {
  readonly start: RunStarter;
  /** The rows to offer for a finished run (the shared action set). */
  readonly actions: (input: RunActionRequest) => readonly PostRunMenuOption[];
  /** Do one chosen action. Never throws. */
  readonly perform: (
    input: RunActionRequest,
    choice: PostRunAction,
    value?: string,
  ) => Promise<PostRunOutcome>;
  /** Where this run's raw stream is persisted, and where old ones are listed. */
  readonly transcripts?: TranscriptStore;
}

export interface RunModeProps {
  readonly prompt: string;
  readonly deps: RunDeps;
  /** Leave the run screen. `notice` is reported on the dashboard's notice line. */
  readonly onExit: (notice?: string) => void;
  /** Visible pane height. */
  readonly height?: number;
  /** Elapsed-time redraw interval in ms. */
  readonly tickMs?: number;
  /** Wall clock, injected so elapsed time is assertable in a test. */
  readonly now?: () => number;
}

/** The screen's state machine. */
type Phase =
  | { kind: 'running' }
  | { kind: 'menu'; active: number }
  | { kind: 'value'; option: PostRunMenuOption }
  | { kind: 'working'; message: string }
  | { kind: 'result'; ok: boolean; message: string }
  | { kind: 'ended'; ok: boolean; message: string };

const EMPTY_STREAM: RunStreamSnapshot = {
  lines: [],
  answer: '',
  toolCount: 0,
  inputTokens: 0,
  outputTokens: 0,
};

/** The token cell of the status line, in the same shape the CLI prints. */
function tokenCell(input: number, output: number): string {
  return `↓${input.toLocaleString()}↑${output.toLocaleString()} tokens`;
}

export function RunMode({
  prompt,
  deps,
  onExit,
  height = 14,
  tickMs = 1000,
  now = Date.now,
}: RunModeProps): ReactElement {
  const [stream, setStream] = useState<RunStreamSnapshot>(EMPTY_STREAM);
  const [binary, setBinary] = useState('host');
  const [phase, setPhase] = useState<Phase>({ kind: 'running' });
  const [elapsedMs, setElapsedMs] = useState(0);
  // The turn being run: the prompt, plus the session to continue when this is a
  // follow-up. Replacing it starts a fresh turn on the same screen.
  const [turn, setTurn] = useState<{ prompt: string; sessionId?: string }>({ prompt });
  const [valueBuffer, setValueBuffer] = useState('');
  const [valueNotice, setValueNotice] = useState<string | null>(null);
  const [postRun, setPostRun] = useState<RunActionRequest | null>(null);
  const [statusHint, setStatusHint] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const rawLinesRef = useRef<string[]>([]);
  const startedAtRef = useRef(now());
  // Leaving the screen is read through a ref: the parent re-renders on every
  // status poll and hands a fresh `onExit` closure each time, and a turn keyed
  // off that identity would abandon a running host and spawn another.
  const exitRef = useRef(onExit);
  useEffect(() => {
    exitRef.current = onExit;
  }, [onExit]);

  // One turn, from spawn to settlement. The cleanup aborts: leaving the screen
  // (or starting a follow-up) must not leave a host running in the background.
  useEffect(() => {
    const streamState = new RunStream();
    const controller = new AbortController();
    controllerRef.current = controller;
    rawLinesRef.current = [];
    startedAtRef.current = now();
    let live = true;
    setStream(streamState.snapshot());
    setElapsedMs(0);
    setPostRun(null);
    setPhase({ kind: 'running' });
    setStatusHint(null);

    const tick = setInterval(() => {
      if (live) setElapsedMs(now() - startedAtRef.current);
    }, tickMs);

    let session: RunSession;
    try {
      session = deps.start(
        turn.prompt,
        {
          onEvent: (event) => {
            streamState.apply(event);
            if (live) setStream(streamState.snapshot());
          },
          onLine: (line) => {
            rawLinesRef.current.push(line);
          },
          signal: controller.signal,
        },
        turn.sessionId,
      );
    } catch (err) {
      // A run that could not even resolve its spawn command (an unknown
      // profile, a host with no CLI) is a failure of THIS screen, not a crash.
      clearInterval(tick);
      setPhase({
        kind: 'ended',
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
      return () => {
        live = false;
      };
    }
    setBinary(session.binary);

    void session.done
      .then(async (result) => {
        streamState.finalize();
        const snapshot = streamState.snapshot();
        const cancelled = controller.signal.aborted;
        // Persist before reporting: the transcript path is offered to the
        // post-run actions, and a run that is not on disk cannot be reopened
        // from the transcript picker.
        const transcript =
          (await deps.transcripts?.write(rawLinesRef.current)) ?? '(not persisted)';
        if (!live) return;
        setStream(snapshot);
        if (cancelled) {
          // Esc asked the host to stop, and it has: leave now rather than
          // holding a second keystroke. The transcript above is already on
          // disk, which is where the partial answer can still be read back.
          exitRef.current(`${session.binary} stopped — the run is in the transcript picker`);
          return;
        }
        if (result.isError || result.exitCode !== 0) {
          setPhase({ kind: 'ended', ok: false, message: failureText(result, session.binary) });
          return;
        }
        setPostRun({
          answer: snapshot.answer,
          transcript,
          host: session.binary,
          ...(snapshot.sessionId === undefined ? {} : { sessionId: snapshot.sessionId }),
          canContinue: snapshot.sessionId !== undefined,
        });
        setPhase({ kind: 'menu', active: 0 });
      })
      .catch((err: unknown) => {
        if (!live) return;
        setPhase({
          kind: 'ended',
          ok: false,
          message: `could not run ${session.binary}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      });

    return () => {
      live = false;
      clearInterval(tick);
      controller.abort();
    };
  }, [turn, deps, now, tickMs]);

  const options = useMemo(() => (postRun === null ? [] : deps.actions(postRun)), [postRun, deps]);

  /** Do the focused action, collecting its value first when it needs one. */
  const choose = useCallback(
    (choice: PostRunAction, value?: string) => {
      if (postRun === null) return;
      const label = options.find((o) => o.value === choice)?.label ?? 'That action';
      if (choice === 'dismiss') {
        onExit('run finished');
        return;
      }
      if (choice === 'resume') {
        // A continuation is another turn on this screen, not a command: the
        // same session, a prompt collected fresh, a fresh pane.
        const sessionId = postRun.sessionId;
        if (sessionId === undefined || value === undefined || value.trim().length === 0) {
          setValueNotice('a follow-up prompt is required');
          return;
        }
        setValueBuffer('');
        setValueNotice(null);
        setTurn({ prompt: value.trim(), sessionId });
        return;
      }
      setPhase({ kind: 'working', message: label });
      // The actions are CLI commands: they write to stdout/stderr and may
      // prompt. Captured here so none of that reaches the frame Ink is drawing,
      // and so a captured failure cannot rewrite the finished run's result. The
      // outcome is read back through the closure rather than the capture's
      // return value — the capture exists for the bytes, not the result.
      void (async () => {
        let outcome: PostRunOutcome = { ok: true, message: '' };
        const captured = await captureProcessOutput(async () => {
          outcome = await deps.perform(postRun, choice, value);
        });
        const written = `${captured.stdout}${captured.stderr}`.trim();
        setPhase({
          kind: 'result',
          ok: outcome.ok,
          message: [outcome.message, outcome.detail, written]
            .filter((part): part is string => part !== undefined && part.length > 0)
            .join(' — ')
            .replace(/\s+/g, ' '),
        });
      })();
    },
    [deps, onExit, options, postRun],
  );

  /** Submit the value step's text, or hold the step open and say why. */
  const submitValue = useCallback(
    (option: PostRunMenuOption) => {
      const value = valueBuffer;
      if (option.needsValue !== undefined && value.trim().length === 0 && option.value !== 'save') {
        setValueNotice(`a ${option.needsValue.label} is required`);
        return;
      }
      setValueBuffer('');
      setValueNotice(null);
      choose(option.value, value);
    },
    [choose, valueBuffer],
  );

  useInput((input, key) => {
    if (phase.kind === 'running') {
      if (key.escape) {
        controllerRef.current?.abort();
        setStatusHint(RUN_CANCEL_HINT);
      }
      return;
    }
    if (phase.kind === 'ended') {
      if (key.return || key.escape) onExit();
      return;
    }
    if (phase.kind === 'result') {
      if (key.return || key.escape) setPhase({ kind: 'menu', active: 0 });
      return;
    }
    if (phase.kind === 'working') return;
    if (phase.kind === 'value') {
      if (key.escape) {
        setValueBuffer('');
        setValueNotice(null);
        setPhase({ kind: 'menu', active: 0 });
        return;
      }
      if (key.return) {
        submitValue(phase.option);
        return;
      }
      if (key.backspace || key.delete) {
        setValueBuffer((b) => b.slice(0, -1));
        setValueNotice(null);
        return;
      }
      if (key.ctrl || key.tab || key.upArrow || key.downArrow) return;
      if (input.length > 0) {
        setValueBuffer((b) => b + input);
        setValueNotice(null);
      }
      return;
    }
    // The menu.
    if (key.escape) {
      onExit('run finished');
      return;
    }
    if (key.return) {
      const option = options[phase.active];
      if (option === undefined) return;
      if (option.needsValue === undefined) {
        choose(option.value);
        return;
      }
      setValueBuffer('');
      setValueNotice(null);
      setPhase({ kind: 'value', option });
      return;
    }
    if (key.upArrow) {
      setPhase({ kind: 'menu', active: Math.max(0, phase.active - 1) });
      return;
    }
    if (key.downArrow) {
      setPhase({
        kind: 'menu',
        active: Math.min(Math.max(0, options.length - 1), phase.active + 1),
      });
    }
  });

  const valueStep: PostRunValueStep | undefined =
    phase.kind === 'value' && phase.option.needsValue !== undefined
      ? {
          label: phase.option.needsValue.label,
          placeholder: phase.option.needsValue.placeholder,
          value: valueBuffer,
          ...(valueNotice === null ? {} : { notice: valueNotice }),
        }
      : undefined;

  const overlay =
    phase.kind === 'menu' ||
    phase.kind === 'value' ||
    phase.kind === 'working' ||
    phase.kind === 'result' ? (
      <PostRunOverlay
        options={options}
        active={phase.kind === 'menu' ? phase.active : 0}
        {...(valueStep === undefined ? {} : { value: valueStep })}
        {...(phase.kind === 'working' ? { working: true } : {})}
        {...(phase.kind === 'result' ? { result: { ok: phase.ok, message: phase.message } } : {})}
      />
    ) : null;

  return (
    <Box flexDirection="column">
      <Header tagline="run" />
      <Panel>
        <Box paddingX={1}>
          <StatusBar
            payload={null}
            run={{
              model: stream.model ?? binary,
              elapsed: humanizeElapsed(elapsedMs),
              tokens: tokenCell(stream.inputTokens, stream.outputTokens),
              tools: stream.toolCount,
            }}
          />
        </Box>
        <Box paddingX={1}>
          <Text>{divider()}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1}>
          <OutputPane
            lines={stream.lines}
            scrollOffset={0}
            height={height}
            title={prompt}
            followTail
          />
        </Box>
      </Panel>
      {phase.kind === 'running' ? <Text>{c.dim(statusHint ?? RUN_HINT)}</Text> : null}
      {phase.kind === 'ended' ? (
        <Text>{phase.ok ? c.ok(phase.message) : c.warn(phase.message)}</Text>
      ) : null}
      {overlay}
    </Box>
  );
}

/** What a failed run says: the host's own reason, or its exit code. */
function failureText(result: RunHostResult, binary: string): string {
  const reason =
    result.errorText !== undefined && result.errorText.trim().length > 0
      ? result.errorText.trim()
      : `exit code ${result.exitCode}`;
  return `${binary} failed: ${reason}`;
}
