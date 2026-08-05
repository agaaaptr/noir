// S9 — `noir context {search,index,status}` tests. daemon-client is mocked
// at the module boundary (no real daemon / HTTP — NF4): `callDaemonTool` returns
// a per-test payload. These pin the contract:
//   • --json emits `{ok:true,data}` to STDOUT only (stderr pristine);
//   • human mode renders tables/snippets to STDERR;
//   • a tool logical-failure envelope (`{ok:false,degraded,error}`) → exit 1
//     (ERROR) with the daemon's message (NOT exit 4 daemon-down);
//   • invalid `--limit` → exit 2 (USAGE) before any daemon call.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { payloads } = vi.hoisted(() => ({ payloads: { current: {} as Record<string, unknown> } }));

// The daemon-down fallback adds two new exports to daemon-client that the
// existing tests must mock explicitly (otherwise the real `probeDaemon` is
// undefined in the mock factory and the `try/catch` in contextSearch silently
// treats every probe as "daemon up" — masking the probe entirely). Default the
// probe to `{running:true}` so the EXISTING tests keep exercising the daemon
// path; a probe-down test overrides `probeResult.current`.
const { probeResult } = vi.hoisted(() => ({
  probeResult: { current: { running: true } as { running: boolean } },
}));

vi.mock('../src/daemon-client.js', () => ({
  callDaemonTool: vi.fn(
    async (_opts: unknown, name: string, _args?: Record<string, unknown>) => payloads.current[name],
  ),
  withDaemon: vi.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ listTools: async () => Object.keys(payloads.current) }),
  ),
  probeDaemon: vi.fn(async () => probeResult.current),
  withInProcessRead: vi.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({
      context: {
        search: vi.fn(async () => ({
          results: [],
          consumedTokens: 0,
          truncated: false,
          degraded: false,
          mode: 'bm25',
        })),
      },
      memory: {},
      workflow: {},
    }),
  ),
}));

import {
  type ContextOptions,
  contextIndex,
  contextSearch,
  contextStatus,
} from '../src/commands/context.js';
import { callDaemonTool } from '../src/daemon-client.js';

function reset(): void {
  probeResult.current = { running: true };
  payloads.current = {
    context_search: {
      ok: true,
      results: [
        {
          id: 'c1',
          source: 'codebase',
          score: 0.0312,
          snippet: 'the <<ContextEngine>> entry',
          path: 'src/context.ts',
          parentDocId: 'h1',
        },
        {
          id: 'c2',
          source: 'docs',
          score: 0.0198,
          snippet: 'window around term',
          path: 'docs/context.md',
          parentDocId: 'h2',
        },
      ],
      consumedTokens: 512,
      truncated: false,
      degraded: false,
      mode: 'hybrid',
    },
    context_index: {
      ok: true,
      indexed: 7,
      skipped: 3,
      deleted: 1,
      failed: 0,
      totalChunks: 10,
      degraded: false,
    },
    context_status: {
      ok: true,
      projectId: 'proj-abc',
      docCount: 12,
      vecCount: 7,
      indexedFiles: 3,
      embedder: { kind: 'local', model: 'all-MiniLM-L6-v2', dim: 384 },
      degraded: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
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

const base: ContextOptions = {};

describe('context search --json', () => {
  it('emits {ok:true,data} to STDOUT only', async () => {
    const { capture, restore } = captureStreams();
    try {
      await contextSearch({ ...base, json: true, query: 'ContextEngine', limit: '5' });
      const c = capture();
      expect(c.err).toBe('');
      const env = JSON.parse(c.out);
      expect(env.ok).toBe(true);
      expect(env.data.query).toBe('ContextEngine');
      expect(env.data.hits).toHaveLength(2);
      expect(env.data.hits[0]).toMatchObject({ path: 'src/context.ts', score: 0.0312 });
      expect(env.data.mode).toBe('hybrid');
    } finally {
      restore();
    }
  });

  it('forwards limit as a number and query to context_search', async () => {
    await contextSearch({ ...base, query: 'auth', limit: '3' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'context_search', {
      query: 'auth',
      limit: 3,
    });
  });

  it('omits limit when not provided', async () => {
    await contextSearch({ ...base, query: 'auth' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'context_search', {
      query: 'auth',
    });
  });

  it('invalid --limit → exit 2 (USAGE) with no daemon call', async () => {
    const { capture, restore } = captureStreams();
    try {
      await expect(
        contextSearch({ ...base, json: true, query: 'x', limit: 'nope' }),
      ).rejects.toMatchObject({ exitCode: 2 });
      expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
      // --json: structured envelope on stdout.
      expect(JSON.parse(capture().out)).toEqual({
        ok: false,
        error: { code: 2, message: expect.stringContaining('--limit') },
      });
    } finally {
      restore();
    }
  });

  it('tool logical-failure envelope → exit 1 (ERROR), daemon message surfaced', async () => {
    payloads.current.context_search = { ok: false, degraded: true, error: 'embedder blew up' };
    const { capture, restore } = captureStreams();
    try {
      await expect(contextSearch({ ...base, json: true, query: 'x' })).rejects.toMatchObject({
        exitCode: 1,
      });
      const env = JSON.parse(capture().out);
      expect(env.ok).toBe(false);
      expect(env.error.message).toContain('embedder blew up');
    } finally {
      restore();
    }
  });

  it('daemon probe down → falls back to the in-process read engine (no daemon call)', async () => {
    probeResult.current = { running: false };
    const { capture, restore } = captureStreams();
    try {
      await contextSearch({ ...base, json: true, query: 'x', limit: '5' });
      // The daemon path is NOT taken when the probe confirms the daemon is down.
      expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
      const env = JSON.parse(capture().out);
      expect(env.ok).toBe(true);
      expect(env.data.query).toBe('x');
      expect(env.data.hits).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe('context search — human table on stderr', () => {
  it('renders hit count + a table to STDERR, nothing to STDOUT', async () => {
    const { capture, restore } = captureStreams();
    try {
      await contextSearch({ ...base, query: 'ContextEngine' });
      const c = capture();
      expect(c.out).toBe('');
      expect(c.err).toMatch(/context search — 2 hits/);
      expect(c.err).toContain('src/context.ts');
      expect(c.err).toContain('0.0312');
    } finally {
      restore();
    }
  });

  it('annotates degraded + truncated runs', async () => {
    payloads.current.context_search = {
      ok: true,
      results: [],
      consumedTokens: 4096,
      truncated: true,
      degraded: true,
      mode: 'bm25',
    };
    const { capture, restore } = captureStreams();
    try {
      await contextSearch({ ...base, query: 'x' });
      const err = capture().err;
      // the ad-hoc `[degraded: BM25-only]` marker is now a status badge
      // (`⚠ degraded: BM25-only`) — symbol + text label, colorblind/NO_COLOR-safe.
      expect(err).toContain('degraded: BM25-only');
      expect(err).toContain('⚠');
      expect(err).toContain('budget hit — results truncated');
    } finally {
      restore();
    }
  });
});

describe('context index', () => {
  it('--json emits the IndexResult on STDOUT', async () => {
    const { capture, restore } = captureStreams();
    try {
      await contextIndex({ ...base, json: true, paths: ['src', 'docs'] });
      const c = capture();
      expect(c.err).toBe('');
      const env = JSON.parse(c.out);
      expect(env.data).toEqual({
        indexed: 7,
        skipped: 3,
        deleted: 1,
        failed: 0,
        totalChunks: 10,
        degraded: false,
      });
    } finally {
      restore();
    }
  });

  it('forwards paths; omits paths arg when none given (daemon indexes root)', async () => {
    await contextIndex({ ...base });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'context_index', {});
  });

  it('read-only fence envelope → exit 1 with the daemon message', async () => {
    payloads.current.context_index = {
      ok: false,
      degraded: true,
      error: 'store is read-only (daemon down) — context_index is unavailable',
    };
    await expect(contextIndex({ ...base })).rejects.toMatchObject({ exitCode: 1 });
  });

  it('--force threads {force:true} to the daemon (full reindex)', async () => {
    await contextIndex({ ...base, force: true });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'context_index', {
      force: true,
    });
  });
});

describe('context status', () => {
  it('--json emits the ContextStatus on STDOUT', async () => {
    const { capture, restore } = captureStreams();
    try {
      await contextStatus({ ...base, json: true });
      const c = capture();
      expect(c.err).toBe('');
      expect(JSON.parse(c.out).data.docCount).toBe(12);
    } finally {
      restore();
    }
  });

  it('human renders embedder as "kind · model (dim-dim)"', async () => {
    const { capture, restore } = captureStreams();
    try {
      await contextStatus({ ...base });
      expect(capture().err).toContain('local · all-MiniLM-L6-v2 (384-dim)');
    } finally {
      restore();
    }
  });
});
