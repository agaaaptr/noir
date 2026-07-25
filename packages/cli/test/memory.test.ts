// S9 t5 — `noir memory {recall,save,sessions,forget,consolidate}` tests.
// daemon-client is mocked at the module boundary (no real daemon) and
// @clack/prompts is mocked so the interactive `save` prompt is deterministic.
// These pin the contract:
//   • --json emits `{ok:true,data}` to STDOUT only; human output to STDERR;
//   • `save --content` from a flag is forwarded; `save` w/o content under
//     non-interactive / --json → exit 2 (USAGE) naming the flag; w/o content
//     under an interactive TTY → the @clack text prompt supplies it;
//   • `consolidate` discovers the daemon tool surface: tool absent → exit 1
//     "not exposed"; tool present + success → lessons; refusal → exit 1 reason;
//   • tool logical-failure envelopes → exit 1 (ERROR), not exit 4.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { payloads, clackMock, CANCEL } = vi.hoisted(() => ({
  payloads: { current: {} as Record<string, unknown> },
  CANCEL: Symbol('cancel'),
  clackMock: {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    text: vi.fn(async (): Promise<string | symbol> => 'prompted content'),
    isCancel: vi.fn((v: unknown) => v === CANCEL),
  },
}));

vi.mock('../src/daemon-client.js', () => ({
  callDaemonTool: vi.fn(
    async (_opts: unknown, name: string, _args?: Record<string, unknown>) => payloads.current[name],
  ),
  // withDaemon invokes fn(caller); caller.listTools() returns the payload keys
  // so `consolidate`'s capability discovery is controllable per-test.
  withDaemon: vi.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ listTools: async () => Object.keys(payloads.current) }),
  ),
}));

vi.mock('@clack/prompts', () => clackMock);

import {
  type MemoryOptions,
  memoryConsolidate,
  memoryForget,
  memoryRecall,
  memorySave,
  memorySessions,
} from '../src/commands/memory.js';
import { callDaemonTool } from '../src/daemon-client.js';

function reset(): void {
  payloads.current = {
    memory_recall: {
      ok: true,
      results: [
        {
          id: '01A',
          type: 'pattern',
          score: 0.04,
          content: 'always pass ProjectId, never a path',
          concepts: ['store'],
          files: ['src/store.ts'],
          ts: 1700000000000,
          importance: 0.8,
          source: 'explicit',
        },
        {
          id: '01B',
          type: 'decision',
          score: 0.02,
          content: 'use RRF k=60',
          concepts: [],
          files: [],
          ts: 1700000001000,
          importance: 0.5,
          source: 'explicit',
        },
      ],
      degraded: false,
    },
    memory_save: {
      ok: true,
      id: '01C',
      observation: {
        id: '01C',
        type: 'fact',
        content: 'remembered',
        importance: 0.5,
        ts: 1700000002000,
        source: 'explicit',
        project: 'proj-abc',
      },
    },
    memory_sessions: {
      ok: true,
      sessions: [
        { id: 's1', count: 2, lastTs: 1700000000000 },
        { id: 's2', count: 3, lastTs: 1700000001000 },
      ],
    },
    memory_forget: { ok: true, deleted: 1, ids: ['01A'] },
    // NOTE: memory_consolidate intentionally absent by default → "not exposed".
  };
}

// --- TTY + env management (isInteractive = stdin&stdout TTY && !CI && !NO_COLOR)
let savedCi: string | undefined;
let savedNoColor: string | undefined;
let savedStdoutTty: boolean | undefined;
let savedStdinTty: boolean | undefined;

function setTty(stdout: boolean, stdin: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdout,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdin, 'isTTY', {
    value: stdin,
    configurable: true,
    writable: true,
  });
}
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  savedCi = process.env.CI;
  savedNoColor = process.env.NO_COLOR;
  savedStdoutTty = process.stdout.isTTY;
  savedStdinTty = process.stdin.isTTY;
  delete process.env.CI;
  delete process.env.NO_COLOR;
  setTty(false, false); // default: non-interactive (scriptable path)
  vi.clearAllMocks();
  reset();
});

afterEach(() => {
  setEnv('CI', savedCi);
  setEnv('NO_COLOR', savedNoColor);
  setTty(savedStdoutTty ?? false, savedStdinTty ?? false);
});

interface Captured {
  out: string;
  err: string;
}
function captureStreams(): { capture: () => Captured; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => {
    out.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    err.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  return {
    capture: () => ({ out: out.join(''), err: err.join('') }),
    restore: () => {
      process.stdout.write = o;
      process.stderr.write = e;
    },
  };
}

const base: MemoryOptions = {};

describe('memory recall', () => {
  it('--json emits {ok:true,data} with full-content hits to STDOUT only', async () => {
    const { capture, restore } = captureStreams();
    try {
      await memoryRecall({ ...base, json: true, query: 'ProjectId', limit: '5' });
      const c = capture();
      expect(c.err).toBe('');
      const env = JSON.parse(c.out);
      expect(env.data.hits[0].content).toBe('always pass ProjectId, never a path');
      expect(env.data.hits).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('forwards limit (number) + query', async () => {
    await memoryRecall({ ...base, query: 'auth', limit: '3' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'memory_recall', {
      query: 'auth',
      limit: 3,
    });
  });

  it('human renders full content blocks to STDERR (never truncated for display data)', async () => {
    const { capture, restore } = captureStreams();
    try {
      await memoryRecall({ ...base, query: 'ProjectId' });
      const c = capture();
      expect(c.out).toBe('');
      expect(c.err).toContain('always pass ProjectId, never a path');
      expect(c.err).toContain('pattern');
      expect(c.err).toContain('0.0400');
    } finally {
      restore();
    }
  });

  it('logical-failure envelope → exit 1', async () => {
    payloads.current.memory_recall = { ok: false, degraded: true, error: 'no embedder' };
    await expect(memoryRecall({ ...base, query: 'x' })).rejects.toMatchObject({ exitCode: 1 });
  });

  it('invalid --limit → exit 2, no daemon call', async () => {
    await expect(memoryRecall({ ...base, query: 'x', limit: '0' })).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
  });
});

describe('memory save', () => {
  it('--content from flag is forwarded (with type + files parsed)', async () => {
    await memorySave({ ...base, content: 'remembered', type: 'fact', files: 'a.ts,b.ts' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'memory_save', {
      content: 'remembered',
      type: 'fact',
      files: ['a.ts', 'b.ts'],
    });
  });

  it('--json emits {ok:true,data:{id,observation}} on STDOUT', async () => {
    const { capture, restore } = captureStreams();
    try {
      await memorySave({ ...base, json: true, content: 'remembered' });
      const c = capture();
      expect(c.err).toBe('');
      expect(JSON.parse(c.out).data.id).toBe('01C');
    } finally {
      restore();
    }
  });

  it('omits content arg entirely when --content missing + non-interactive → exit 2', async () => {
    await expect(memorySave({ ...base, json: true })).rejects.toMatchObject({ exitCode: 2 });
    expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
    expect(clackMock.text).not.toHaveBeenCalled();
  });

  it('missing content under an interactive TTY → @clack prompt supplies it', async () => {
    setTty(true, true);
    clackMock.text.mockResolvedValue('prompted content');
    await memorySave({ ...base }); // no --content, but interactive
    expect(clackMock.text).toHaveBeenCalledTimes(1);
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'memory_save', {
      content: 'prompted content',
    });
  });

  it('cancel at the prompt → exit 5 (CANCELLED), no save', async () => {
    setTty(true, true);
    clackMock.text.mockResolvedValue(CANCEL);
    await expect(memorySave({ ...base })).rejects.toMatchObject({ exitCode: 5 });
    expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
  });

  it('read-only fence envelope → exit 1', async () => {
    payloads.current.memory_save = {
      ok: false,
      degraded: true,
      error: 'store is read-only (daemon down) — memory_save is unavailable',
    };
    await expect(memorySave({ ...base, content: 'x' })).rejects.toMatchObject({ exitCode: 1 });
  });
});

describe('memory sessions', () => {
  it('--json emits sessions array on STDOUT', async () => {
    const { capture, restore } = captureStreams();
    try {
      await memorySessions({ ...base, json: true });
      const c = capture();
      expect(c.err).toBe('');
      expect(JSON.parse(c.out).data.sessions).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it('human renders a sessions table to STDERR', async () => {
    const { capture, restore } = captureStreams();
    try {
      await memorySessions({ ...base });
      const c = capture();
      expect(c.out).toBe('');
      expect(c.err).toContain('s1');
      expect(c.err).toContain('Observations');
    } finally {
      restore();
    }
  });
});

describe('memory forget', () => {
  it('forwards variadic ids', async () => {
    await memoryForget({ ...base, ids: ['01A', '01B'] });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'memory_forget', {
      ids: ['01A', '01B'],
    });
  });

  it('--json emits {deleted, ids}', async () => {
    const { capture, restore } = captureStreams();
    try {
      await memoryForget({ ...base, json: true, ids: ['01A'] });
      expect(JSON.parse(capture().out).data).toEqual({ deleted: 1, ids: ['01A'] });
    } finally {
      restore();
    }
  });

  it('empty ids → exit 2', async () => {
    await expect(memoryForget({ ...base, ids: [] })).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('memory consolidate (capability-discovered)', () => {
  it('tool not exposed → exit 1 (ERROR), honest message, no callTool', async () => {
    await expect(memoryConsolidate({ ...base })).rejects.toMatchObject({ exitCode: 1 });
    expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalledWith(
      expect.anything(),
      'memory_consolidate',
      expect.anything(),
    );
  });

  it('tool exposed + success → {ok:true,data:{lessons,from}}', async () => {
    payloads.current.memory_consolidate = {
      ok: true,
      lessons: [{ id: 'L1', type: 'lesson', content: 'derived lesson' }],
      from: ['01A', '01B'],
    };
    const { capture, restore } = captureStreams();
    try {
      await memoryConsolidate({ ...base, json: true, types: 'pattern,decision', limit: '20' });
      const c = capture();
      const env = JSON.parse(c.out);
      expect(env.ok).toBe(true);
      expect(env.data.lessons).toHaveLength(1);
      expect(env.data.from).toEqual(['01A', '01B']);
    } finally {
      restore();
    }
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(
      expect.anything(),
      'memory_consolidate',
      { types: ['pattern', 'decision'], limit: 20 },
    );
  });

  it('provider refusal ({ok:false,reason}) → exit 1 with the reason', async () => {
    payloads.current.memory_consolidate = { ok: false, reason: 'no-provider', logged: true };
    await expect(memoryConsolidate({ ...base })).rejects.toMatchObject({ exitCode: 1 });
  });
});
