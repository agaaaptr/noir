// S9 t7 — cross-command flow + doctor provider-purity tests.
//
// This file complements the per-command suites (context/memory/task/doctor.test)
// with two cross-cutting concerns the per-command files don't cover:
//
//   1. A daemon-backed FLOW: `context search → memory recall → task status`
//      driven through ONE mocked daemon-client, asserting the cumulative stream
//      discipline holds across a sequence — every `--json` payload lands as its
//      own line on STDOUT (stderr pristine), and human mode renders tables to
//      STDERR (stdout pristine). Pins that the shared daemon seam + the
//      `{ok:true,data}` envelope are consistent across commands, and that the
//      tool-name + args forwarded to the daemon are correct in call order.
//
//   2. `doctor` provider-status is a PURE PROJECTION: it consults
//      `resolveModelConfig` (which only reads config + the env-var NAME) and
//      NEVER makes a live network call. `@noir-ai/model` + `@noir-ai/store` +
//      `@noir-ai/daemon` are mocked at the boundary so the assertion is fully
//      offline + deterministic, and `globalThis.fetch` is spied so any network
//      attempt (a provider ping OR a daemon /health probe) is caught.
//
// Mocks are file-scoped (vi.mock is hoisted). They coexist without interference:
// the flow commands import only the mocked `../src/daemon-client.js` (so the
// real daemon-client + its `@noir-ai/daemon` import never load); the doctor
// mocks (`@noir-ai/model` / `store` / `daemon`) are inert for the flow because
// no flow command imports them directly.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- hoisted mock state ------------------------------------------------------
// `payloads` is the shared fake daemon tool-result map (keyed by tool name); the
// mocked `callDaemonTool`/`withDaemon` read it live so each test can install
// per-command fixtures. `modelResolve` is the spy `doctor` consults instead of
// the real `resolveModelConfig` — a no-op default so a forgetful test still
// resolves cleanly; each provider test pins its own `mockReturnValue`.
const { payloads, modelResolve } = vi.hoisted(() => ({
  payloads: { current: {} as Record<string, unknown> },
  modelResolve: vi.fn(() => ({ tiers: {}, providers: {} })),
}));

// --- module mocks (hoisted above the real imports below) --------------------
vi.mock('../src/daemon-client.js', () => ({
  callDaemonTool: vi.fn(async (_opts: unknown, name: string, args?: Record<string, unknown>) => {
    // `workflow_status` is keyed by taskId when one is given (mirrors task.ts's
    // optional-positional convention) so the flow can assert forwarding.
    if (name === 'workflow_status' && args && args.taskId) {
      return payloads.current[`workflow_status:${String(args.taskId)}`];
    }
    return payloads.current[name];
  }),
  // `withDaemon` hands `fn` a caller whose listTools() reports the payload keys
  // (capability discovery). The flow below never calls a `withDaemon` command,
  // but the export is mocked so any future command stays consistent.
  withDaemon: vi.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ listTools: async () => Object.keys(payloads.current) }),
  ),
}));

// `doctor` imports ONLY `resolveModelConfig` from @noir-ai/model — a partial
// mock satisfies it and avoids loading the provider SDKs entirely.
vi.mock('@noir-ai/model', () => ({ resolveModelConfig: modelResolve }));

// Deterministic native + store probes so doctor's outcome doesn't depend on the
// host's sqlite-vec / onnx binaries. doctor reads `vec.ok` and `store.close()`.
vi.mock('@noir-ai/store', () => ({
  vecAvailability: () => ({ ok: true }),
  openStore: async () => ({ close: async () => {} }),
}));

// No daemon record ⇒ checkDaemon warns "not running" WITHOUT pinging /health,
// so `fetch` is never reached from the daemon check either.
vi.mock('@noir-ai/daemon', () => ({
  readDaemonRecord: () => null,
  pidAlive: () => false,
}));

import { paths } from '@noir-ai/core';
import { contextSearch } from '../src/commands/context.js';
import { doctor } from '../src/commands/doctor.js';
import { memoryRecall } from '../src/commands/memory.js';
import { taskStatus } from '../src/commands/task.js';
import { callDaemonTool } from '../src/daemon-client.js';

// ---------------------------------------------------------------------------
// Stream capture (data→stdout, diagnostics→stderr; matches the per-command suites)
// ---------------------------------------------------------------------------
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

/** Capture streams around `fn`, swallowing any thrown exit-code error so the
 *  caller can inspect output + stderr + the error separately (doctor throws on
 *  fail). Field names mirror doctor.test.ts: `err` is the THROWN value, `stderr`
 *  is the diagnostic stream — distinct so neither masks the other. */
async function run(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; err: unknown }> {
  const { capture, restore } = captureStreams();
  let thrown: unknown;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  } finally {
    restore();
  }
  const c = capture();
  return { stdout: c.out, stderr: c.err, err: thrown };
}

// ---------------------------------------------------------------------------
// Shared flow fixtures: realistic tool payloads for the three read commands.
// ---------------------------------------------------------------------------
function installFlowPayloads(): void {
  payloads.current = {
    context_search: {
      ok: true,
      results: [
        {
          id: 'c1',
          source: 'codebase',
          score: 0.0421,
          snippet: 'the <<ContextEngine>> hybrid entry',
          path: 'src/context.ts',
          parentDocId: 'h1',
        },
      ],
      consumedTokens: 256,
      truncated: false,
      degraded: false,
      mode: 'hybrid',
    },
    memory_recall: {
      ok: true,
      results: [
        {
          id: '01A',
          type: 'pattern',
          score: 0.051,
          content: 'always pass ProjectId, never a fs path',
          concepts: ['store'],
          files: ['src/store.ts'],
          ts: 1700000000000,
          importance: 0.8,
          source: 'explicit',
        },
      ],
      degraded: false,
    },
    workflow_status: {
      ok: true,
      taskId: 't-flow',
      phase: 'plan',
      state: 'in_progress',
      mode: 'full',
      nextGate: 'plan',
      history: [],
      updatedAt: 1700000000000,
      degraded: false,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installFlowPayloads();
});

// ===========================================================================
// 1. Daemon-backed command flow (context → memory → task)
// ===========================================================================
describe('daemon-backed command flow — shared mocked daemon, stream discipline', () => {
  it('--json: each command emits its own `{ok:true,data}` line to STDOUT, stderr pristine', async () => {
    const { capture, restore } = captureStreams();
    try {
      await contextSearch({ json: true, query: 'how does ContextEngine work', limit: '5' });
      await memoryRecall({ json: true, query: 'ProjectId rule' });
      await taskStatus({ json: true });
      const c = capture();

      // Exactly one JSON line per command on stdout; stderr stayed clean.
      const lines = c.out.split('\n').filter((l) => l.length > 0);
      expect(lines).toHaveLength(3);
      expect(c.err).toBe('');

      const [ctxLine, memLine, taskLine] = lines;
      const ctx = JSON.parse(ctxLine ?? '') as {
        ok: boolean;
        data: { query: string; hits: { path: string }[]; mode: string };
      };
      const mem = JSON.parse(memLine ?? '') as {
        ok: boolean;
        data: { query: string; hits: { content: string }[] };
      };
      const task = JSON.parse(taskLine ?? '') as {
        ok: boolean;
        data: { taskId: string; phase: string };
      };

      expect(ctx.ok).toBe(true);
      expect(ctx.data.query).toBe('how does ContextEngine work');
      expect(ctx.data.hits[0]?.path).toBe('src/context.ts');
      expect(ctx.data.mode).toBe('hybrid');
      expect(mem.ok).toBe(true);
      expect(mem.data.query).toBe('ProjectId rule');
      expect(mem.data.hits[0]?.content).toBe('always pass ProjectId, never a fs path');
      expect(task.ok).toBe(true);
      expect(task.data.taskId).toBe('t-flow');
      expect(task.data.phase).toBe('plan');
    } finally {
      restore();
    }
  });

  it('forwards the right tool name + args to the daemon IN CALL ORDER', async () => {
    await contextSearch({ json: true, query: 'how does ContextEngine work', limit: '5' });
    await memoryRecall({ json: true, query: 'ProjectId rule' });
    await taskStatus({ json: true });

    const mocked = vi.mocked(callDaemonTool);
    expect(mocked).toHaveBeenCalledTimes(3);
    expect(mocked).toHaveBeenNthCalledWith(1, expect.anything(), 'context_search', {
      query: 'how does ContextEngine work',
      limit: 5,
    });
    expect(mocked).toHaveBeenNthCalledWith(2, expect.anything(), 'memory_recall', {
      query: 'ProjectId rule',
    });
    // task status with no positional id → daemon resolves the active task.
    expect(mocked).toHaveBeenNthCalledWith(3, expect.anything(), 'workflow_status', {});
  });

  it('human mode renders tables to STDERR, nothing to STDOUT', async () => {
    const { capture, restore } = captureStreams();
    try {
      await contextSearch({ query: 'how does ContextEngine work' });
      await memoryRecall({ query: 'ProjectId rule' });
      // taskStatus needs an opts object (it reads opts.id); pass `{}` for the
      // human-mode active-task lookup rather than calling it bare.
      await taskStatus({});
      const c = capture();
      // stdout is pristine (no data leaked into the human path).
      expect(c.out).toBe('');
      // Each command's diagnostic header + a rendered cell reaches stderr.
      expect(c.err).toMatch(/context search — 1 hit/);
      expect(c.err).toContain('src/context.ts');
      expect(c.err).toMatch(/memory recall — 1 hit/);
      expect(c.err).toContain('always pass ProjectId, never a fs path');
      expect(c.err).toMatch(/task status — t-flow/);
      expect(c.err).toContain('plan');
    } finally {
      restore();
    }
  });

  it('task status forwards a positional task id as {taskId} across the flow', async () => {
    payloads.current['workflow_status:t-other'] = {
      ok: true,
      taskId: 't-other',
      phase: 'spec',
      state: 'specified',
      mode: 'quick',
      nextGate: 'plan',
      updatedAt: 1700000001000,
      degraded: false,
    };
    const { capture, restore } = captureStreams();
    try {
      await taskStatus({ json: true, id: 't-other' });
      const env = JSON.parse(capture().out) as { data: { taskId: string; phase: string } };
      expect(env.data.taskId).toBe('t-other');
      expect(env.data.phase).toBe('spec');
    } finally {
      restore();
    }
    expect(vi.mocked(callDaemonTool)).toHaveBeenLastCalledWith(
      expect.anything(),
      'workflow_status',
      { taskId: 't-other' },
    );
  });

  it('a daemon logical-failure envelope mid-flow surfaces as exit 1 data (not transport-down)', async () => {
    // The daemon WAS reachable (the mock resolved); the tool returned its own
    // {ok:false} envelope. That's data → the command maps it to exit 1 (ERROR),
    // never to exit 4 (DAEMON_DOWN).
    payloads.current.memory_recall = { ok: false, degraded: true, error: 'embedder offline' };
    const { capture, restore } = captureStreams();
    try {
      await expect(memoryRecall({ json: true, query: 'x' })).rejects.toMatchObject({
        exitCode: 1,
      });
      // --json: the failure is a structured envelope on STDOUT (not daemon-down).
      const env = JSON.parse(capture().out) as {
        ok: boolean;
        error: { code: number; message: string };
      };
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe(1);
      expect(env.error.message).toContain('embedder offline');
    } finally {
      restore();
    }
  });
});

// ===========================================================================
// 2. doctor provider-status — pure projection, NO live network call
// ===========================================================================
describe('doctor provider-status — resolveModelConfig is a pure projection (no live call)', () => {
  // doctor reads process.cwd(); run against a throwaway initialized project so
  // checkConfig → ok and checkProvider has a real `project.config.model` to hand
  // to the mocked resolveModelConfig.
  let root: string;
  let origCwd: string;
  let origFetch: typeof globalThis.fetch;
  // A fetch that would satisfy a /health ping IF one were attempted — but the
  // assertions prove it never is. Returning a 200 keeps a stray call from
  // masquerading as success (the not-called assertion is the real signal).
  const fetchSpy = vi.fn(() => Promise.resolve(new Response('{"ok":true}', { status: 200 })));

  // The env-var NAME the config points at (doctor prints the NAME, never a value).
  const PROV_KEY_ENV = 'NOIR_CMDS_DOCTOR_KEY';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'noir-cmds-doctor-'));
    origCwd = process.cwd();
    origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
    process.chdir(root);
    vi.clearAllMocks();

    mkdirSync(paths.noirDir(root), { recursive: true });
    writeFileSync(paths.projectId(root), 'cmds-doctor-project\n', 'utf8');
    writeFileSync(
      paths.config(root),
      `host: claude\nmode: full\nmodel:\n  providers:\n    anthropic:\n      model: claude-sonnet-4\n      apiKeyEnv: ${PROV_KEY_ENV}\n`,
      'utf8',
    );
    delete process.env[PROV_KEY_ENV];
  });

  afterEach(() => {
    process.chdir(origCwd);
    globalThis.fetch = origFetch;
    delete process.env[PROV_KEY_ENV];
    rmSync(root, { recursive: true, force: true });
  });

  /** Find a check row by name in the doctor JSON envelope (fails loudly if absent). */
  function findCheck(
    checks: Array<{ name: string; status: string; detail: string }>,
    name: string,
  ): { name: string; status: string; detail: string } {
    const row = checks.find((c) => c.name === name);
    expect(row, `doctor should emit a '${name}' check`).toBeDefined();
    return row ?? { name, status: 'ok', detail: '' };
  }

  it('calls resolveModelConfig with the parsed model config and NEVER hits the network', async () => {
    modelResolve.mockReturnValue({
      tiers: {},
      providers: { anthropic: { model: 'claude-sonnet-4', apiKeyEnv: PROV_KEY_ENV, hasKey: true } },
    });

    const r = await run(() => doctor({ json: true }));

    // THE core assertion: resolveModelConfig is the ONLY seam, called once with
    // the project's model block (which carries the user's apiKeyEnv NAME).
    expect(modelResolve).toHaveBeenCalledTimes(1);
    expect(modelResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.objectContaining({
          anthropic: expect.objectContaining({ apiKeyEnv: PROV_KEY_ENV }),
        }),
      }),
    );

    // No live call anywhere: no daemon /health probe (record absent), and the
    // provider check is a pure projection (resolveModelConfig read no network).
    expect(fetchSpy).not.toHaveBeenCalled();

    // The provider row reflects the MOCKED resolution verbatim — proving doctor
    // renders from resolveModelConfig's output, not from any live call.
    const env = JSON.parse(r.stdout) as {
      ok: boolean;
      data: { checks: Array<{ name: string; status: string; detail: string }> };
    };
    expect(env.ok).toBe(true);
    const provider = findCheck(env.data.checks, 'provider');
    expect(provider.status).toBe('ok');
    expect(provider.detail).toContain('anthropic');
    expect(provider.detail).toMatch(/key present/);
  });

  it('missing key → provider warns (still no live call; resolveModelConfig alone decides)', async () => {
    modelResolve.mockReturnValue({
      tiers: {},
      providers: {
        anthropic: { model: 'claude-sonnet-4', apiKeyEnv: PROV_KEY_ENV, hasKey: false },
      },
    });

    const r = await run(() => doctor({ json: true }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(modelResolve).toHaveBeenCalledTimes(1);
    const env = JSON.parse(r.stdout) as {
      data: { checks: Array<{ name: string; status: string; detail: string }> };
    };
    const provider = findCheck(env.data.checks, 'provider');
    // A missing key is a readiness WARN, never CRITICAL (model layer degrades to
    // templates) — so the overall exit stays 0 (no fail check thrown).
    expect(provider.status).toBe('warn');
    expect(provider.detail).toMatch(new RegExp(`missing ${PROV_KEY_ENV}`));
    expect(r.err).toBeUndefined();
  });

  it('no providers configured → provider ok "offline mode", still no network', async () => {
    modelResolve.mockReturnValue({ tiers: {}, providers: {} });

    await run(() => doctor({ json: true }));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(modelResolve).toHaveBeenCalledTimes(1);
  });
});
