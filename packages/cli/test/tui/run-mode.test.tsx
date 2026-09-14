// The live host-run screen, driven by an injected run source.
//
// Nothing here spawns a host or touches the network: `start` is a fake that
// hands the screen the callbacks a real spawn would have given it, so a test
// emits exactly the normalized events it wants to watch render, and settles the
// run when it likes.
//
// The invariant this file guards beyond the rendering is the reason the screen
// exists at all: a run does NOT go through the dispatch capture, so Ink keeps
// drawing while the host streams. The capture swaps `process.stdout.write` for
// a collector, and Ink renders every frame through that same function — so a
// run wrapped in it would eat its own frames. Two tests below pin both halves:
// an ordinary dispatched command is still captured, and the writer the process
// had is still the writer the run screen sees while it is live.

import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { NoirEvent, RunHostResult } from '../../src/orchestrator.js';
import {
  type PostRunAction,
  type PostRunMenuOption,
  type PostRunOutcome,
  postRunActions,
} from '../../src/run-actions.js';
import { App, type TuiDeps } from '../../src/tui/App.js';
import {
  type RunActionRequest,
  type RunDeps,
  RunMode,
  type RunStarter,
  type RunStartHandlers,
} from '../../src/tui/modes/run.js';
import type { PaletteCommand } from '../../src/tui/palette/types.js';
import type { TranscriptStore } from '../../src/tui/transcripts.js';

const ESC = '';
const ENTER = '\r';
const DOWN = '[B';

/** A settled run that did what was asked of it. */
const OK_RESULT: RunHostResult = {
  exitCode: 0,
  usage: { inputTokens: 120, outputTokens: 34, totalCostUsd: 0, numTurns: 1 },
  eventCount: 0,
  stderr: '',
  isError: false,
};

/** One fake host: emits events on demand and settles when the test says so. */
interface FakeHost {
  readonly start: RunStarter;
  readonly prompts: readonly string[];
  readonly resumes: readonly (string | undefined)[];
  /** The writer the process had during the most recent emitted event. */
  readonly writerSeen: () => typeof process.stdout.write;
  emit(event: NoirEvent): void;
  emitAll(events: readonly NoirEvent[]): void;
  line(raw: string): void;
  settle(over?: Partial<RunHostResult>): void;
  readonly aborted: () => boolean;
  readonly lines: () => readonly string[];
}

function fakeHost(): FakeHost {
  let handlers: RunStartHandlers | null = null;
  let resolveDone: ((result: RunHostResult) => void) | null = null;
  const prompts: string[] = [];
  const resumes: (string | undefined)[] = [];
  let writerSeen = process.stdout.write;

  const start: RunStarter = (prompt, given, resumeSessionId) => {
    handlers = given;
    prompts.push(prompt);
    resumes.push(resumeSessionId);
    return {
      binary: 'claude',
      done: new Promise<RunHostResult>((resolve) => {
        resolveDone = resolve;
      }),
    };
  };

  function need(): RunStartHandlers {
    if (handlers === null) throw new Error('the run screen never started a host');
    return handlers;
  }

  return {
    start,
    prompts,
    resumes,
    writerSeen: () => writerSeen,
    emit: (event) => {
      const live = need();
      // Read the writer from inside the run, not from the test body: a screen
      // that wrapped itself in the capture would have swapped it by now.
      writerSeen = process.stdout.write;
      live.onEvent(event);
    },
    emitAll: (events) => {
      for (const event of events) {
        const live = need();
        writerSeen = process.stdout.write;
        live.onEvent(event);
      }
    },
    line: (raw) => need().onLine(raw),
    settle: (over = {}) => {
      resolveDone?.({ ...OK_RESULT, ...over });
    },
    aborted: () => need().signal.aborted,
    lines: () => [],
  };
}

/** A transcript store with nothing on disk and one path for a written run. */
function memoryTranscripts(): TranscriptStore & { readonly written: string[][] } {
  const written: string[][] = [];
  return {
    written,
    list: async () => [],
    read: async () => [],
    write: async (lines) => {
      written.push([...lines]);
      return '/tmp/fake-transcripts/claude-run.jsonl';
    },
  };
}

interface Mounted {
  readonly instance: ReturnType<typeof render>;
  readonly host: FakeHost;
  readonly perform: ReturnType<typeof vi.fn>;
  readonly options: readonly PostRunMenuOption[];
  readonly exit: ReturnType<typeof vi.fn>;
}

/** Render the run screen over a fake host, with the real action set. */
function mountRun(
  props: Partial<{ prompt: string; now: () => number; tickMs: number }> = {},
): Mounted {
  const host = fakeHost();
  const transcripts = memoryTranscripts();
  const perform = vi.fn(
    async (): Promise<PostRunOutcome> => ({ ok: true, message: 'Saved to memory.' }),
  );
  const options: PostRunMenuOption[] = [];
  const deps: RunDeps = {
    start: host.start,
    actions: (request: RunActionRequest) => {
      // The real, shared action set: the overlay must offer exactly what the
      // terminal prompt offers for the same finished run.
      const rows = postRunActions({
        ...request,
        opts: {},
      });
      options.length = 0;
      options.push(...rows);
      return rows;
    },
    perform,
    transcripts,
  };
  const exit = vi.fn();
  const element = (
    <RunMode
      prompt={props.prompt ?? 'fix the bug'}
      deps={deps}
      onExit={exit}
      now={props.now ?? (() => 0)}
      tickMs={props.tickMs ?? 100000}
    />
  ) as unknown as ReactElement;
  return { instance: render(element), host, perform, options, exit };
}

/** Resolve after a short macrotask so React's state flush lands. */
function flush(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('run screen — live render', () => {
  it('shows assistant text as it streams, then commits it once the host confirms', async () => {
    const m = mountRun();
    await flush();

    m.host.emit({ kind: 'delta', text: 'Looking at the parser' });
    await flush();
    expect(m.instance.lastFrame() ?? '').toContain('Looking at the parser');

    // The host re-reports the block verbatim; the stream preview must be
    // replaced by it, not appended to it.
    m.host.emit({ kind: 'assistant', messageId: 'msg_1', text: 'Looking at the parser now.' });
    await flush();
    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toContain('Looking at the parser now.');
    expect(frame.match(/Looking at the parser/g)?.length).toBe(1);
    m.instance.unmount();
  });

  it('shows tool activity, deduped, and counts it on the status line', async () => {
    const m = mountRun();
    await flush();

    // The real sequence for one agentic turn on a host asked for partial
    // messages: the call is announced as its block opens, then reported again
    // inside the message that finished it — and the message can carry text the
    // announced call came after.
    m.host.emitAll([
      { kind: 'init', sessionId: 'sess-1', model: 'claude-sonnet-4' },
      { kind: 'delta', text: 'Let me read the parser' },
      { kind: 'tool', name: 'Read' },
      { kind: 'assistant', messageId: 'msg_1', text: 'Let me read the parser.', tools: ['Read'] },
      { kind: 'tool', name: 'Bash' },
      { kind: 'assistant', messageId: 'msg_2', tools: ['Bash'] },
    ]);
    await flush();

    const frame = m.instance.lastFrame() ?? '';
    expect(frame.match(/● Read/g)?.length).toBe(1);
    expect(frame.match(/● Bash/g)?.length).toBe(1);
    expect(frame).toContain('run:');
    expect(frame).toContain('claude-sonnet-4');
    expect(frame).toContain('· 2 tools');
    // The message's text stays above the call it introduced.
    expect(frame.indexOf('Let me read the parser.')).toBeLessThan(frame.indexOf('● Read'));
    m.instance.unmount();
  });

  it('reports elapsed time and tokens on the status line', async () => {
    let clock = 1_000;
    const m = mountRun({ now: () => clock, tickMs: 20 });
    await flush();

    m.host.emit({ kind: 'init', model: 'claude-sonnet-4' });
    clock = 1_000 + 68_000;
    m.host.emit({
      kind: 'assistant',
      messageId: 'msg_1',
      text: 'done',
      usage: { inputTokens: 120, outputTokens: 34 },
    });
    // The clock is only read on a tick, so let a couple land before reading.
    await flush(80);

    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toContain('1m 08s');
    expect(frame).toContain('↓120↑34 tokens');
    m.instance.unmount();
  });

  it('offers the shared post-run actions once the run succeeds', async () => {
    const m = mountRun();
    await flush();
    m.host.line('{"type":"system"}');
    m.host.emit({ kind: 'init', sessionId: 'sess-1', model: 'claude-sonnet-4' });
    m.host.emit({ kind: 'assistant', messageId: 'msg_1', text: 'The fix is in parser.ts.' });
    await flush();

    m.host.settle();
    await flush();

    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toContain('run finished');
    expect(frame).toContain('Save answer to memory');
    expect(frame).toContain('Continue this session');
    expect(frame).toContain('Dismiss');
    // The raw stream was persisted before the menu was offered, so the answer
    // is reopenable from the transcript picker.
    m.instance.unmount();
  });

  it('shows the failure and offers nothing when the run failed', async () => {
    const m = mountRun();
    await flush();
    const actions = m.options;

    m.host.settle({ exitCode: 1, isError: true, errorText: 'Not logged in', stderr: 'no auth' });
    await flush();

    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toContain('claude failed: Not logged in');
    expect(frame).not.toContain('run finished');
    expect(actions.length).toBe(0);
    // Enter leaves the screen; a failed run is not a menu.
    m.instance.stdin.write(ENTER);
    await flush();
    expect(m.exit).toHaveBeenCalled();
    m.instance.unmount();
  });

  it('cancels the host on Esc and returns to the dashboard', async () => {
    const m = mountRun();
    await flush();
    expect(m.host.aborted()).toBe(false);

    m.instance.stdin.write(ESC);
    await flush();
    expect(m.host.aborted()).toBe(true);
    expect(m.instance.lastFrame() ?? '').toContain('cancelling');

    // The host still settles (a signalled child closes like any other): the
    // screen leaves on its own, saying why, and never offers the menu.
    m.host.settle();
    await flush(60);
    expect(m.exit).toHaveBeenCalledWith(expect.stringContaining('stopped'));
    const frame = m.instance.lastFrame() ?? '';
    expect(frame).not.toContain('run finished');
    m.instance.unmount();
  });

  it('keeps the cancelled run’s raw stream for the transcript picker', async () => {
    const host = fakeHost();
    const transcripts = memoryTranscripts();
    const exit = vi.fn();
    const deps: RunDeps = {
      start: host.start,
      actions: () => [],
      perform: async () => ({ ok: true, message: '' }),
      transcripts,
    };
    const instance = render(
      (<RunMode prompt="fix the bug" deps={deps} onExit={exit} />) as unknown as ReactElement,
    );
    await flush();
    host.line('{"type":"system","subtype":"init"}');
    instance.stdin.write(ESC);
    await flush();
    host.settle();
    await flush(60);
    // Persisted before the screen left, so the partial run is reopenable.
    expect(transcripts.written).toEqual([['{"type":"system","subtype":"init"}']]);
    instance.unmount();
  });

  it('performs a chosen action with the value its row asked for', async () => {
    const m = mountRun();
    await flush();
    m.host.emit({ kind: 'init', sessionId: 'sess-1', model: 'claude-sonnet-4' });
    m.host.emit({ kind: 'assistant', messageId: 'msg_1', text: 'The fix is in parser.ts.' });
    await flush();
    m.host.settle();
    await flush();

    // Rows: memory, research, handoff, resume, save, dismiss.
    for (let i = 0; i < 4; i++) {
      m.instance.stdin.write(DOWN);
      await flush(10);
    }
    m.instance.stdin.write(ENTER);
    await flush();
    expect(m.instance.lastFrame() ?? '').toContain('file path');

    m.instance.stdin.write('notes/answer.md');
    await flush();
    m.instance.stdin.write(ENTER);
    await flush(60);

    expect(m.perform).toHaveBeenCalledTimes(1);
    const [request, choice, value] = m.perform.mock.calls[0] as [
      RunActionRequest,
      PostRunAction,
      string,
    ];
    expect(choice).toBe('save');
    expect(value).toBe('notes/answer.md');
    expect(request.answer).toContain('The fix is in parser.ts.');
    expect(m.instance.lastFrame() ?? '').toContain('Saved to memory.');
    m.instance.unmount();
  });

  it('continues the session as another turn on the same screen', async () => {
    const m = mountRun();
    await flush();
    m.host.emit({ kind: 'init', sessionId: 'sess-1', model: 'claude-sonnet-4' });
    m.host.emit({ kind: 'assistant', messageId: 'msg_1', text: 'The fix is in parser.ts.' });
    await flush();
    m.host.settle();
    await flush();

    // resume is the fourth row.
    for (let i = 0; i < 3; i++) {
      m.instance.stdin.write(DOWN);
      await flush(10);
    }
    m.instance.stdin.write(ENTER);
    await flush();
    m.instance.stdin.write('now write the tests');
    await flush();
    m.instance.stdin.write(ENTER);
    await flush();

    expect(m.perform).not.toHaveBeenCalled();
    expect(m.host.prompts).toEqual(['fix the bug', 'now write the tests']);
    expect(m.host.resumes).toEqual([undefined, 'sess-1']);
    m.instance.unmount();
  });

  it('reports a run that could not even resolve its spawn', async () => {
    const exit = vi.fn();
    const deps: RunDeps = {
      start: () => {
        throw new Error('unknown run profile "work"');
      },
      actions: () => [],
      perform: async () => ({ ok: true, message: '' }),
    };
    const element = (
      <RunMode prompt="hello" deps={deps} onExit={exit} />
    ) as unknown as ReactElement;
    const instance = render(element);
    await flush();
    expect(instance.lastFrame() ?? '').toContain('unknown run profile "work"');
    instance.unmount();
  });
});

// ---------------------------------------------------------------------------
// Entry from the dashboard, and the capture invariant either side of it.
// ---------------------------------------------------------------------------

const RUN: PaletteCommand = {
  id: 'run',
  label: 'Run',
  argv: ['run'],
  category: 'run',
  keywords: ['run'],
  description: 'ask the host agent a question',
  destructive: true,
  needsArg: 'prompt',
};

const STATUS: PaletteCommand = {
  id: 'status',
  label: 'Status',
  argv: ['status'],
  category: 'status',
  keywords: ['status'],
  description: 'project + daemon + store snapshot',
  destructive: false,
};

interface MountedApp {
  readonly instance: ReturnType<typeof render>;
  readonly host: FakeHost;
  readonly dispatch: ReturnType<typeof vi.fn>;
}

function mountApp(runDeps?: RunDeps): MountedApp {
  const host = fakeHost();
  const dispatch = vi.fn(async (): Promise<void> => {});
  const deps: TuiDeps = {
    dispatch,
    fetchStatus: async () => null,
    commands: [RUN, STATUS],
    record: async () => {},
    loadRecent: async () => [],
    ...(runDeps === undefined ? {} : { run: runDeps }),
  };
  const element = (<App deps={deps} refreshMs={600000} />) as unknown as ReactElement;
  return { instance: render(element), host, dispatch };
}

function runDepsOver(host: FakeHost): RunDeps {
  return {
    start: host.start,
    actions: () => [],
    perform: async () => ({ ok: true, message: '' }),
    transcripts: memoryTranscripts(),
  };
}

describe('dashboard entry into the run screen', () => {
  it('opens the run screen for a typed /run prompt instead of dispatching it', async () => {
    const host = fakeHost();
    const m = mountApp(runDepsOver(host));
    await flush(60);

    m.instance.stdin.write('/run fix the bug');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(60);
    // `run` is a destructive command, so it still passes the confirm gate.
    m.instance.stdin.write('y');
    await flush(80);

    expect(m.dispatch).not.toHaveBeenCalled();
    expect(host.prompts).toEqual(['fix the bug']);
    expect(m.instance.lastFrame() ?? '').toContain('streaming');
    m.instance.unmount();
  });

  it('opens the run screen from the palette’s run row', async () => {
    const host = fakeHost();
    const m = mountApp(runDepsOver(host));
    await flush(60);

    m.instance.stdin.write(''); // Ctrl+K
    await flush(80);
    m.instance.stdin.write('run');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(60);
    // The row declares a required argument, so the prompt is collected first.
    m.instance.stdin.write('explain the store');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(60);
    m.instance.stdin.write('y');
    await flush(80);

    expect(host.prompts).toEqual(['explain the store']);
    m.instance.unmount();
  });

  it('keeps dispatching a `run` that carries flags through the captured path', async () => {
    const host = fakeHost();
    const m = mountApp(runDepsOver(host));
    await flush(60);

    m.instance.stdin.write('/run --json fix the bug');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(60);
    m.instance.stdin.write('y');
    await flush(120);

    // A one-shot invocation with its own output discipline: not the live screen.
    expect(host.prompts).toEqual([]);
    expect(m.dispatch).toHaveBeenCalledWith(['run', '--json', 'fix', 'the', 'bug']);
    m.instance.unmount();
  });
});

describe('the stdout writer', () => {
  it('is swapped for a collector while an ordinary command is dispatched', async () => {
    const before = process.stdout.write;
    let writerDuringDispatch: typeof process.stdout.write = before;
    const dispatch = vi.fn(async (): Promise<void> => {
      writerDuringDispatch = process.stdout.write;
      process.stdout.write('captured line\n');
    });
    const deps: TuiDeps = {
      dispatch,
      fetchStatus: async () => null,
      commands: [STATUS],
      record: async () => {},
      loadRecent: async () => [],
    };
    const instance = render((<App deps={deps} refreshMs={600000} />) as unknown as ReactElement);
    await flush(60);

    instance.stdin.write('/status');
    await flush(60);
    instance.stdin.write(ENTER);
    await flush(160);

    // The command's own writes went to the collector, not the terminal…
    expect(writerDuringDispatch).not.toBe(before);
    // …and what it wrote is what the pane shows.
    expect(instance.lastFrame() ?? '').toContain('captured line');
    instance.unmount();
  });

  it('is untouched while the run screen is live', async () => {
    const before = process.stdout.write;
    const host = fakeHost();
    const m = mountApp(runDepsOver(host));
    await flush(60);
    m.instance.stdin.write('/run fix the bug');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(60);
    m.instance.stdin.write('y');
    await flush(80);

    // Emitted from inside the run: a screen that went through the dispatch
    // capture would be holding a collector writer right now, and Ink would be
    // drawing into it.
    host.emit({ kind: 'delta', text: 'working' });
    await flush(60);
    expect(host.writerSeen()).toBe(before);
    expect(process.stdout.write).toBe(before);
    m.instance.unmount();
  });
});
