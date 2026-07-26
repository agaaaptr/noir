// S9 t4 — `noir status` tests. The daemon MCP client is mocked at the module
// boundary (no real daemon, no real HTTP): `withDaemon` is replaced with a fake
// that invokes the passed `fn` against a controllable `callTool` so each tool's
// payload (or failure) is deterministic. These pin the status contract:
//   • --json emits `{ok:true,data}` to STDOUT (and nothing else there);
//   • human mode renders the banner + Field/Value table to STDERR;
//   • optional engines degrade gracefully (store/context/workflow/memory → null
//     when the tool is absent or returns a logical-failure envelope), while
//     host_status is required (its failure propagates as the daemon-client's
//     exit-4 error — covered in daemon-client.test, not re-asserted here).
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories are hoisted above all imports, so they may only reference
// hoisted values. `callerHolder`/`probeHolder` are the mutable bridges between
// per-test setup (beforeEach assigns .current) and the mock factory (reads at
// call time). Same pattern output.test.ts uses for the ora handle.
const { callerHolder, probeHolder } = vi.hoisted(() => ({
  callerHolder: { current: null as unknown },
  probeHolder: {
    current: { running: true, pid: 4242, uptimeSec: 125 } as {
      running: boolean;
      pid?: number;
      port?: number;
      uptimeSec?: number;
    },
  },
}));

vi.mock('../src/daemon-client.js', () => ({
  // status is probe-only (C1): probeDaemon reports liveness WITHOUT starting a
  // daemon; withRunningDaemon reuses the probed daemon (never starts either).
  // Both stubbed → no real daemon / HTTP (NF4).
  probeDaemon: vi.fn(async () => probeHolder.current),
  withRunningDaemon: vi.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn(callerHolder.current),
  ),
}));

// Project info is assembled in-process now (C1): loadProjectInfo + NOIR_VERSION
// are stubbed so status never needs host_status for project identity, and no
// test-cwd coupling to whether the real repo is initialized leaks in.
vi.mock('@noir-ai/core', () => ({
  loadProjectInfo: vi.fn(() => ({
    id: 'proj-abc',
    name: 'noir-demo',
    root: '/tmp/noir-status-test',
    config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
  })),
  NOIR_VERSION: '0.1.0',
}));

import { type StatusOptions, status } from '../src/commands/status.js';
import { probeDaemon, withRunningDaemon } from '../src/daemon-client.js';

// ---------------------------------------------------------------------------
// Fake daemon caller. `callTool(name)` returns PAYLOADS[name]; per-test a test
// can override behaviour (throw, swap a payload) by re-mapping PAYLOADS or by
// reassigning currentCaller (and callerHolder.current).
// ---------------------------------------------------------------------------
type Caller = { callTool: ReturnType<typeof vi.fn> };

const PAYLOADS: Record<string, unknown> = {};
let currentCaller: Caller;

function resetPayloads(): void {
  for (const k of Object.keys(PAYLOADS)) delete PAYLOADS[k];
  // C1: project id/name/host/version come from in-process loadProjectInfo +
  // NOIR_VERSION (mocked above), and daemon running/pid/uptime come from the
  // probe. host_status is now OPTIONAL and only enriches daemon.transport.
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
    taskId: 't-9',
    phase: 'plan',
    state: 'in_progress',
    mode: 'full',
    nextGate: 'plan',
    degraded: false,
  };
  PAYLOADS.memory_sessions = {
    ok: true,
    sessions: [
      { id: 's1', count: 2, lastTs: 1 },
      { id: 's2', count: 3, lastTs: 2 },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPayloads();
  currentCaller = { callTool: vi.fn(async (name: string) => PAYLOADS[name]) };
  callerHolder.current = currentCaller;
  // Default: a healthy running daemon (probe truth). Daemon-down tests override
  // this to {running:false}.
  probeHolder.current = { running: true, pid: 4242, uptimeSec: 125 };
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

/** Run status(--json) and return the parsed envelope; asserts stdout-only. */
async function runJson(opts: StatusOptions): Promise<{
  ok: boolean;
  data: {
    noir: string;
    project: { id: string; name: string };
    host: string;
    daemon: { running: boolean; pid?: number; uptimeSec?: number };
    store: { docCount: number; vecCount: number; degraded: boolean } | null;
    context: { indexedFiles: number; embedder: string } | null;
    workflow: { taskId: string; phase: string } | null;
    memory: { sessions: number; observations: number } | null;
  };
}> {
  const { capture, restore } = captureStreams();
  let raw = '';
  try {
    await status({ ...opts, json: true });
    const c = capture();
    expect(c.err).toBe(''); // --json keeps stderr pristine
    raw = c.out;
  } finally {
    restore();
  }
  return JSON.parse(raw);
}

const baseOpts: StatusOptions = {};

describe('status --json — success envelope on stdout', () => {
  it('emits {ok:true,data} to STDOUT only (stderr empty)', async () => {
    const env = await runJson(baseOpts);
    expect(env.ok).toBe(true);
    expect(env.data.project).toEqual({ id: 'proj-abc', name: 'noir-demo' });
    expect(env.data.host).toBe('claude');
    expect(env.data.noir).toBe('0.1.0');
  });

  it('aggregates the full snapshot (all engines present)', async () => {
    const env = await runJson(baseOpts);
    expect(env.data.daemon).toEqual({
      running: true,
      transport: 'streamable-http',
      pid: 4242,
      uptimeSec: 125,
    });
    expect(env.data.store).toEqual({
      docCount: 12,
      vecCount: 7,
      dbPath: '/tmp/x.db',
      degraded: false,
    });
    expect(env.data.context?.indexedFiles).toBe(3);
    expect(env.data.context?.embedder).toBe('local · all-MiniLM-L6-v2 (384-dim)');
    expect(env.data.workflow).toMatchObject({ taskId: 't-9', phase: 'plan' });
  });

  it('sums per-session counts into observations (2+3=5)', async () => {
    const env = await runJson(baseOpts);
    expect(env.data.memory).toEqual({ sessions: 2, observations: 5 });
  });

  it('calls the five tools once each, host_status first', async () => {
    await runJson(baseOpts);
    const names = vi.mocked(currentCaller.callTool).mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      'host_status',
      'store_status',
      'context_status',
      'workflow_status',
      'memory_sessions',
    ]);
  });

  it('forwards verbose/json to probeDaemon + withRunningDaemon', async () => {
    await runJson({ verbose: true });
    expect(vi.mocked(probeDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ json: true, verbose: true }),
    );
    // status passes the probe it already computed as the 3rd arg so
    // withRunningDaemon doesn't GET /health a second time.
    expect(vi.mocked(withRunningDaemon)).toHaveBeenCalledWith(
      expect.objectContaining({ json: true, verbose: true }),
      expect.any(Function),
      expect.objectContaining({ running: true }),
    );
  });
});

describe('status — graceful degradation (optional engines)', () => {
  it('store_status throwing → data.store null, others still present', async () => {
    currentCaller.callTool = vi.fn(async (name: string) => {
      if (name === 'store_status') throw new Error('tool not registered');
      return PAYLOADS[name];
    });
    const env = await runJson(baseOpts);
    expect(env.data.store).toBeNull();
    expect(env.data.context).not.toBeNull();
    expect(env.data.memory).not.toBeNull();
  });

  it('workflow_status logical-failure envelope → data.workflow null (not a crash)', async () => {
    // The daemon returns {ok:false,error:'no active task'} as DATA when no task
    // is active — status normalizes it to null rather than propagating.
    PAYLOADS.workflow_status = { ok: false, error: 'no active task' };
    const env = await runJson(baseOpts);
    expect(env.data.workflow).toBeNull();
  });

  it('all optional engines absent → only host+daemon survive, ok:true', async () => {
    currentCaller.callTool = vi.fn(async (name: string) => {
      if (name === 'host_status') return PAYLOADS.host_status;
      throw new Error('not registered');
    });
    const env = await runJson(baseOpts);
    expect(env.ok).toBe(true);
    expect(env.data.store).toBeNull();
    expect(env.data.context).toBeNull();
    expect(env.data.workflow).toBeNull();
    expect(env.data.memory).toBeNull();
  });
});

describe('status — daemon down (probe-only, NEVER auto-starts)', () => {
  beforeEach(() => {
    probeHolder.current = { running: false };
  });

  it('--json: daemon:{running:false}, all sections null, ok:true, exit 0', async () => {
    const env = await runJson(baseOpts);
    expect(env.ok).toBe(true);
    expect(env.data.daemon).toEqual({ running: false });
    expect(env.data.store).toBeNull();
    expect(env.data.context).toBeNull();
    expect(env.data.workflow).toBeNull();
    expect(env.data.memory).toBeNull();
    // Probe-only: withRunningDaemon must NOT run when the daemon is down.
    expect(vi.mocked(withRunningDaemon)).not.toHaveBeenCalled();
  });

  it('human: "not running" row + banner, nothing to STDOUT, no throw', async () => {
    const { capture, restore } = captureStreams();
    try {
      await status({ ...baseOpts });
      const c = capture();
      expect(c.out).toBe('');
      expect(c.err).toMatch(/noir status — noir-demo \(proj-abc\)/);
      expect(c.err).toContain('not running');
      expect(c.err).toContain('noir daemon start');
    } finally {
      restore();
    }
  });

  it('does NOT call withRunningDaemon or any count tool (no auto-start)', async () => {
    await runJson(baseOpts);
    expect(vi.mocked(withRunningDaemon)).not.toHaveBeenCalled();
    expect(currentCaller.callTool).not.toHaveBeenCalled();
  });
});

describe('status — human table on stderr', () => {
  it('renders banner + Field/Value table to STDERR, nothing to STDOUT', async () => {
    const { capture, restore } = captureStreams();
    try {
      await status({ ...baseOpts }); // human mode
      const c = capture();
      expect(c.out).toBe('');
      const err = c.err;
      expect(err).toMatch(/noir status — noir-demo \(proj-abc\)/);
      expect(err).toContain('Project');
      expect(err).toContain('Daemon');
      expect(err).toContain('running');
      expect(err).toContain('pid 4242');
      expect(err).toContain('Store');
      expect(err).toContain('12 docs');
      expect(err).toContain('5 observations');
    } finally {
      restore();
    }
  });

  it('embedder described as "kind · model (dim-dim)"', async () => {
    const { capture, restore } = captureStreams();
    try {
      await status({ ...baseOpts });
      // TIER A2: the responsive Value column word-wraps the embedder string at a
      // space boundary, so assert the two semantic pieces separately.
      const err = capture().err;
      expect(err).toContain('local · all-MiniLM-L6-v2');
      expect(err).toContain('(384-dim)');
    } finally {
      restore();
    }
  });

  it('kind:none embedder renders "none (BM25-only)"', async () => {
    PAYLOADS.context_status = {
      ok: true,
      projectId: 'proj-abc',
      docCount: 0,
      vecCount: 0,
      indexedFiles: 0,
      embedder: { kind: 'none', dim: 0 },
      degraded: true,
    };
    const { capture, restore } = captureStreams();
    try {
      await status({ ...baseOpts });
      expect(capture().err).toContain('none (BM25-only)');
    } finally {
      restore();
    }
  });

  it('marks a degraded store with a degraded: read-only badge', async () => {
    PAYLOADS.store_status = {
      ok: true,
      projectId: 'proj-abc',
      docCount: 1,
      vecCount: 0,
      dbPath: null,
      degraded: true,
    };
    const { capture, restore } = captureStreams();
    try {
      await status({ ...baseOpts });
      // TIER A2: the ad-hoc `[degraded: read-only]` marker is now a status badge
      // (`⚠ degraded: read-only`) — symbol + text label, colorblind/NO_COLOR-safe.
      const err = capture().err;
      expect(err).toContain('degraded: read-only');
      expect(err).toContain('⚠');
    } finally {
      restore();
    }
  });

  it('no active task → "no active task" row', async () => {
    PAYLOADS.workflow_status = { ok: false, error: 'no active task' };
    const { capture, restore } = captureStreams();
    try {
      await status({ ...baseOpts });
      expect(capture().err).toContain('no active task');
    } finally {
      restore();
    }
  });
});

describe('status — quiet suppression', () => {
  it('human banner suppressed under --quiet; table still renders', async () => {
    const { capture, restore } = captureStreams();
    try {
      await status({ ...baseOpts, quiet: true });
      const c = capture();
      // log() (the banner) is silenced under --quiet; table() still writes
      // because the table IS the data, not a non-essential diagnostic.
      expect(c.err).not.toMatch(/noir status —/);
      expect(c.err).toContain('Daemon');
    } finally {
      restore();
    }
  });
});
