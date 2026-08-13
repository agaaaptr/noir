// `noir handoff` (alias `noir wrap`) tests. The daemon MCP client is mocked at
// the module boundary (same pattern as status.test.ts): probeDaemon +
// withRunningDaemon are stubbed so the handoff command never touches a real
// daemon or HTTP. These pin the handoff contract:
//   • default → structured MARKDOWN to STDOUT (key sections present + the host
//     directive names the configured host);
//   • `--write` → persists under `.noir/handoff/` AND that path is gitignored;
//   • `--json` → the structured `{ok,data}` envelope, not markdown;
//   • daemon-down → artifact still renders (in-process reads + the "start
//     daemon" note), exit 0;
//   • missing-embedder → bounded extraction degrades to a note, exit 0.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted bridges between per-test setup and the mock factory (factory reads at
// call time). `callerHolder` is the fake DaemonToolCaller; `probeHolder` is the
// probe result; `projectHolder` carries the in-process project info.
const { callerHolder, probeHolder, projectHolder } = vi.hoisted(() => ({
  callerHolder: { current: null as unknown },
  probeHolder: {
    current: { running: true, pid: 4242, uptimeSec: 125 } as {
      running: boolean;
      pid?: number;
      port?: number;
      uptimeSec?: number;
    },
  },
  projectHolder: {
    current: {
      id: 'proj-abc',
      name: 'noir-demo',
      root: '/tmp/noir-handoff-test',
      config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
    } as {
      id: string;
      name: string;
      root: string;
      config: { host: string; mode?: string; daemon?: { idleTimeoutSec?: number } };
    },
  },
}));

vi.mock('../src/daemon-client.js', () => ({
  // probe-only — never starts a daemon; withRunningDaemon reuses the probe.
  probeDaemon: vi.fn(async () => probeHolder.current),
  withRunningDaemon: vi.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn(callerHolder.current),
  ),
}));

vi.mock('@noir-ai/core', async (importOriginal) => {
  // Spread the real module so `syncIgnores` / `IGNORE_BLOCK` / `NOIR_DIR` stay
  // the actual implementations (the gitignore dogfood test relies on the real
  // syncIgnores writing `/.noir/handoff/`); only `loadProjectInfo` is overridden.
  const actual = await importOriginal<typeof import('@noir-ai/core')>();
  return {
    ...actual,
    loadProjectInfo: vi.fn(() => projectHolder.current),
  };
});

import { type HandoffOptions, handoff } from '../src/commands/handoff.js';

// ---------------------------------------------------------------------------
// Fake daemon caller. `callTool(name, args)` returns PAYLOADS[name]; per-test
// overrides are applied by re-mapping PAYLOADS or swapping callerHolder.current.
// ---------------------------------------------------------------------------
type Caller = { callTool: ReturnType<typeof vi.fn> };

const PAYLOADS: Record<string, unknown> = {};
let currentCaller: Caller;

function resetPayloads(): void {
  for (const k of Object.keys(PAYLOADS)) delete PAYLOADS[k];
  PAYLOADS.host_status = { transport: 'streamable-http' };
  PAYLOADS.store_status = {
    ok: true,
    projectId: 'proj-abc',
    docCount: 12,
    vecCount: 7,
    dbPath: '/tmp/x.db',
    degraded: false,
  };
  PAYLOADS.context_status = {
    ok: true,
    projectId: 'proj-abc',
    docCount: 12,
    vecCount: 7,
    indexedFiles: 3,
    embedder: { kind: 'local', model: 'all-MiniLM-L6-v2', dim: 384 },
    degraded: false,
  };
  PAYLOADS.workflow_status = {
    ok: true,
    taskId: 'auth-flow',
    phase: 'plan',
    state: 'in_progress',
    mode: 'full',
    nextGate: 'execute',
    degraded: false,
  };
  PAYLOADS.memory_sessions = {
    ok: true,
    sessions: [{ id: 's1', count: 2, lastTs: 1 }],
  };
  PAYLOADS.context_search = {
    ok: true,
    results: [
      {
        path: 'src/auth.ts',
        score: 0.91,
        snippet: 'export function authenticate()',
        source: 'store',
      },
      { path: 'src/auth.test.ts', score: 0.82, snippet: 'describe(authenticate)', source: 'store' },
    ],
    consumedTokens: 120,
    truncated: false,
    degraded: false,
    mode: 'hybrid',
  };
  PAYLOADS.memory_recall = {
    ok: true,
    results: [
      { id: 'obs-1', observation: { type: 'decision', content: 'Use JWT for auth sessions.' } },
    ],
    degraded: false,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPayloads();
  currentCaller = { callTool: vi.fn(async (name: string) => PAYLOADS[name]) };
  callerHolder.current = currentCaller;
  probeHolder.current = { running: true, pid: 4242, uptimeSec: 125 };
  projectHolder.current = {
    id: 'proj-abc',
    name: 'noir-demo',
    root: '/tmp/noir-handoff-test',
    config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
  };
});

interface Captured {
  out: string;
  err: string;
}
function captureStreams(): { capture: () => Captured; restore: () => void } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    capture: () => ({ out: outChunks.join(''), err: errChunks.join('') }),
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

const base: HandoffOptions = { json: false };

describe('noir handoff — default markdown to STDOUT', () => {
  it('emits the structured markdown block to stdout with the key sections', async () => {
    const { capture, restore } = captureStreams();
    try {
      await handoff({ ...base });
      const c = capture();
      // STDOUT carries the artifact; STDERR is empty (no diagnostics in default mode).
      expect(c.out).toContain('# Noir handoff — noir-demo (proj-abc)');
      expect(c.out).toContain('**Phase:** plan — next gate: execute');
      expect(c.out).toContain('## Open host');
      expect(c.out).toContain('## Next step');
      expect(c.out).toContain('`noir-executing-plans`'); // next gate's skill
      expect(c.out).toContain('## Extracted context (seed)');
      expect(c.out).toContain('src/auth.ts');
      expect(c.out).toContain('## Extracted memory (seed)');
      expect(c.out).toContain('Use JWT for auth sessions.');
      expect(c.out).toContain('## Live data');
      expect(c.out).toContain('noir.workflow_status');
      // No daemon-down note (daemon is up).
      expect(c.out).not.toContain('daemon not running');
      // STDERR silent in default mode.
      expect(c.err).toBe('');
    } finally {
      restore();
    }
  });

  it('the host directive names the configured host (claude)', async () => {
    const { capture, restore } = captureStreams();
    try {
      await handoff({ ...base });
      const c = capture();
      expect(c.out).toContain('Open `claude`');
      expect(c.out).toContain('other hosts: agents-md, gemini, cursor, opencode');
    } finally {
      restore();
    }
  });

  it('names the gemini host when the project is configured for gemini', async () => {
    projectHolder.current = {
      id: 'proj-g',
      name: 'gem-proj',
      root: '/tmp/noir-handoff-gem',
      config: { host: 'gemini', mode: 'full', daemon: { idleTimeoutSec: 900 } },
    };
    const { capture, restore } = captureStreams();
    try {
      await handoff({ ...base });
      const c = capture();
      expect(c.out).toContain('Open `gemini`');
      expect(c.out).toContain('# Noir handoff — gem-proj (proj-g)');
    } finally {
      restore();
    }
  });
});

describe('noir handoff --json — structured payload', () => {
  it('emits the {ok,data} envelope to stdout (not markdown)', async () => {
    const { capture, restore } = captureStreams();
    try {
      await handoff({ ...base, json: true });
      const c = capture();
      expect(c.err).toBe('');
      const env = JSON.parse(c.out);
      expect(env.ok).toBe(true);
      expect(env.data.project).toEqual({ id: 'proj-abc', name: 'noir-demo' });
      expect(env.data.host).toBe('claude');
      expect(env.data.task.taskId).toBe('auth-flow');
      expect(env.data.task.nextSkill).toBe('noir-executing-plans');
      expect(Array.isArray(env.data.contextSeed)).toBe(true);
      expect(env.data.contextSeed[0].path).toBe('src/auth.ts');
      expect(env.data.memorySeed[0].id).toBe('obs-1');
      expect(env.data.degraded.daemonDown).toBe(false);
      // The envelope is JSON, not markdown.
      expect(c.out).not.toContain('# Noir handoff');
    } finally {
      restore();
    }
  });
});

describe('noir handoff --write — persists under .noir/handoff/ (gitignored)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'noir-handoff-write-'));
    projectHolder.current = {
      id: 'proj-write',
      name: 'write-demo',
      root,
      config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
    };
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes the artifact to .noir/handoff/HO-<NNNN>-<taskId>.md and confirms on stderr', async () => {
    const { capture, restore } = captureStreams();
    try {
      await handoff({ ...base, write: true });
      const c = capture();
      // STDOUT is empty (the artifact went to the file); stderr carries the path.
      expect(c.out).toBe('');
      expect(c.err).toContain('handoff written to');
      const expected = join(root, '.noir', 'handoff', 'HO-0001-auth-flow.md');
      expect(c.err).toContain(expected);
      expect(existsSync(expected)).toBe(true);
      const md = readFileSync(expected, 'utf8');
      expect(md).toContain('# Noir handoff — write-demo (proj-write)');
      expect(md).toContain('## Open host');
    } finally {
      restore();
    }
  });

  it('the .noir/handoff/ path is gitignored when syncIgnores writes the block', async () => {
    // Dogfood the REAL core syncIgnores into the temp root, then verify the
    // handoff path is covered by the managed gitignore block. This pins the
    // contract: `noir handoff --write` artifacts never pollute commits.
    const { syncIgnores, IGNORE_BLOCK } = await import('@noir-ai/core');
    syncIgnores(root);
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gi).toContain(IGNORE_BLOCK.begin);
    expect(gi).toContain('/.noir/handoff/');
    expect(gi).toContain(IGNORE_BLOCK.end);
    // The scaffold template carries it too (first-init correctness).
    // Resolve from this test file (not process.cwd()) so the path is stable
    // regardless of the directory vitest was invoked from.
    const tmpl = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'packages/create/templates/gitignore.tmpl',
      ),
      'utf8',
    );
    expect(tmpl).toContain('/.noir/handoff/');
  });
});

describe('noir handoff — graceful degradation', () => {
  it('daemon-down: artifact still renders with the "start daemon" note, exit 0', async () => {
    probeHolder.current = { running: false };
    const { capture, restore } = captureStreams();
    try {
      // Does not throw — renders from in-process project info + a note.
      await handoff({ ...base });
      const c = capture();
      expect(c.out).toContain('# Noir handoff — noir-demo (proj-abc)');
      expect(c.out).toContain('daemon not running');
      expect(c.out).toContain('start `noir daemon start`');
      // No task section (workflow_status wasn't fetched — daemon down).
      expect(c.out).toContain('**Phase:** no active task');
      // Exit 0 — the command returned without throwing.
    } finally {
      restore();
    }
  });

  it('missing embedder: context_search throwing degrades to a note (never hard-fails)', async () => {
    // Make context_search throw (simulates a missing embedder / engine not
    // wired). tryTool folds the throw to null → "degraded" note, exit 0.
    currentCaller.callTool = vi.fn(async (name: string) => {
      if (name === 'context_search') throw new Error('embedder not available');
      return PAYLOADS[name];
    });
    callerHolder.current = currentCaller;
    const { capture, restore } = captureStreams();
    try {
      await handoff({ ...base });
      const c = capture();
      // Artifact still renders; the seed degrades to the embedder note.
      expect(c.out).toContain('# Noir handoff — noir-demo (proj-abc)');
      expect(c.out).toContain('Embedder unavailable');
      // Memory seed may still have hits (it doesn't depend on the embedder).
      expect(c.out).toContain('Use JWT for auth sessions.');
    } finally {
      restore();
    }
  });

  it('daemon-down --json: emits the envelope with degraded.daemonDown=true', async () => {
    probeHolder.current = { running: false };
    const { capture, restore } = captureStreams();
    try {
      await handoff({ ...base, json: true });
      const c = capture();
      const env = JSON.parse(c.out);
      expect(env.ok).toBe(true);
      expect(env.data.degraded.daemonDown).toBe(true);
      expect(env.data.task).toBe(null);
      expect(env.data.contextSeed).toBe(null);
    } finally {
      restore();
    }
  });
});
