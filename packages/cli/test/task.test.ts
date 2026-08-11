// S9 — `noir task {new,status,advance,next}` tests. daemon-client is mocked
// at the module boundary. These pin the contract:
//   • `status`/`next` read `workflow_status`; a logical-failure envelope
//     (`{ok:false,error:'no active task'}` / `'unknown task'`) → exit 3
//     (NOT_FOUND) — a focused task read's "absent" is not-found, not an error;
//   • `new`/`advance` are wired to `workflow_start`/`workflow_advance` (I1):
//     they forward args, render the resulting task, and map a logical-failure
//     envelope (incl. read-only store) to exit 1; an invalid mode/phase is
//     exit 2 (USAGE); daemon-unreachable would be exit 4 from callDaemonTool
//     (covered by daemon-client.test).
//   • `next` suggests the grounded phase→skill (plan → noir-planning).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { payloads } = vi.hoisted(() => ({ payloads: { current: {} as Record<string, unknown> } }));
// `probeDaemon`/`withInProcessRead` back the daemon-down read fallback (DS-5).
// Mocking them explicitly keeps the existing daemon-path tests green (probe
// defaulting to `{running:true}`) and lets a fallback test flip the probe.
const { probeResult } = vi.hoisted(() => ({
  probeResult: { current: { running: true } as { running: boolean } },
}));

vi.mock('../src/daemon-client.js', () => ({
  callDaemonTool: vi.fn(async (_opts: unknown, name: string, args?: Record<string, unknown>) => {
    // `workflow_status` defaults to the active task when no taskId given.
    if (name === 'workflow_status' && args && args.taskId) {
      return payloads.current[`workflow_status:${String(args.taskId)}`];
    }
    return payloads.current[name];
  }),
  probeDaemon: vi.fn(async () => probeResult.current),
  withInProcessRead: vi.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({
      workflow: {
        activeTaskId: vi.fn(() => 't-inproc'),
        status: vi.fn(() => ({
          taskId: 't-inproc',
          phase: 'plan',
          state: 'in_progress',
          mode: 'full',
          history: [],
          updatedAt: 0,
        })),
      },
      context: {},
      memory: {},
    }),
  ),
}));

import {
  type TaskOptions,
  taskAbandon,
  taskAdvance,
  taskBlock,
  taskNew,
  taskNext,
  taskResume,
  taskStatus,
} from '../src/commands/task.js';
import { callDaemonTool } from '../src/daemon-client.js';

function reset(): void {
  probeResult.current = { running: true };
  payloads.current = {
    workflow_status: {
      ok: true,
      taskId: 't-9',
      phase: 'plan',
      state: 'in_progress',
      mode: 'full',
      nextGate: 'plan',
      history: [],
      updatedAt: 1700000000000,
      degraded: false,
    },
    workflow_start: {
      ok: true,
      taskId: 'auth',
      slug: 'auth',
      phase: 'intake',
      state: 'draft',
      mode: 'full',
      nextGate: 'spec',
      history: [],
      updatedAt: 1700000000000,
      degraded: false,
    },
    workflow_advance: {
      ok: true,
      taskId: 'auth',
      phase: 'clarify',
      state: 'clarifying',
      mode: 'full',
      nextGate: 'spec',
      history: [],
      updatedAt: 1700000000001,
      degraded: false,
    },
    workflow_resume: {
      ok: true,
      resumable: true,
      taskId: 'auth',
      phase: 'clarify',
      state: 'clarifying',
      mode: 'full',
      nextGate: 'spec',
      history: [],
      updatedAt: 1700000000001,
      degraded: false,
    },
    workflow_block: {
      ok: true,
      taskId: 'auth',
      phase: 'clarify',
      state: 'blocked',
      mode: 'full',
      nextGate: null,
      blockReason: 'CI is red',
      history: [],
      updatedAt: 1700000000002,
      degraded: false,
    },
    workflow_abandon: {
      ok: true,
      taskId: 'auth',
      phase: 'clarify',
      state: 'abandoned',
      mode: 'full',
      nextGate: null,
      history: [],
      updatedAt: 1700000000003,
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

const base: TaskOptions = {};

describe('task status', () => {
  it('--json emits the WorkflowStatus on STDOUT', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskStatus({ ...base, json: true });
      const c = capture();
      expect(c.err).toBe('');
      const env = JSON.parse(c.out);
      expect(env.data.taskId).toBe('t-9');
      expect(env.data.phase).toBe('plan');
    } finally {
      restore();
    }
  });

  it('forwards a positional task id', async () => {
    payloads.current['workflow_status:t-42'] = {
      ok: true,
      taskId: 't-42',
      phase: 'spec',
      state: 'specified',
      mode: 'full',
      nextGate: 'plan',
    };
    await taskStatus({ ...base, id: 't-42' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_status', {
      taskId: 't-42',
    });
  });

  it('human renders a Field/Value table to STDERR', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskStatus({ ...base });
      const c = capture();
      expect(c.out).toBe('');
      expect(c.err).toContain('t-9');
      expect(c.err).toContain('Phase');
      expect(c.err).toContain('plan');
    } finally {
      restore();
    }
  });

  it('"no active task" envelope → exit 3 (NOT_FOUND)', async () => {
    payloads.current.workflow_status = { ok: false, error: 'no active task' };
    await expect(taskStatus({ ...base })).rejects.toMatchObject({ exitCode: 3 });
  });

  it('"unknown task" envelope → exit 3 (NOT_FOUND)', async () => {
    payloads.current['workflow_status:t-99'] = { ok: false, taskId: 't-99', error: 'unknown task' };
    await expect(taskStatus({ ...base, id: 't-99' })).rejects.toMatchObject({ exitCode: 3 });
  });

  it('daemon probe down → in-process read fallback (no daemon call)', async () => {
    probeResult.current = { running: false };
    const { capture, restore } = captureStreams();
    try {
      await taskStatus({ ...base, json: true });
      expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
      const env = JSON.parse(capture().out);
      expect(env.ok).toBe(true);
      expect(env.data.taskId).toBe('t-inproc');
    } finally {
      restore();
    }
  });
});

describe('task next', () => {
  it('--json emits phase + nextGate + grounded skill suggestion', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskNext({ ...base, json: true });
      const c = capture();
      const env = JSON.parse(c.out);
      expect(env.data.phase).toBe('plan');
      expect(env.data.nextGate).toBe('plan');
      expect(env.data.suggestion).toBe('noir-planning');
    } finally {
      restore();
    }
  });

  it('human surfaces next gate + skill on STDERR', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskNext({ ...base });
      const err = capture().err;
      expect(err).toContain('next gate: plan');
      expect(err).toContain('noir-planning');
    } finally {
      restore();
    }
  });

  it('no active task → exit 3', async () => {
    payloads.current.workflow_status = { ok: false, error: 'no active task' };
    await expect(taskNext({ ...base })).rejects.toMatchObject({ exitCode: 3 });
  });
});

describe('task new — wired to workflow_start', () => {
  it('--json emits the started task on STDOUT + calls workflow_start', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskNew({ ...base, slug: 'auth', mode: 'full', json: true });
      const c = capture();
      expect(c.err).toBe('');
      const env = JSON.parse(c.out);
      expect(env.data.taskId).toBe('auth');
      expect(env.data.phase).toBe('intake');
      expect(env.data.state).toBe('draft');
      expect(env.data.mode).toBe('full');
    } finally {
      restore();
    }
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_start', {
      taskId: 'auth',
      slug: 'auth',
      mode: 'full',
    });
  });

  it('derives taskId from the slug and omits mode when not given (server defaults to full)', async () => {
    await taskNew({ ...base, slug: 'feat-x' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_start', {
      taskId: 'feat-x',
      slug: 'feat-x',
    });
  });

  it('invalid mode → exit 2 (USAGE), no daemon call', async () => {
    await expect(taskNew({ ...base, slug: 'x', mode: 'bogus' })).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
  });

  it('logical-failure envelope (read-only store) → exit 1 with detail', async () => {
    payloads.current.workflow_start = {
      ok: false,
      degraded: true,
      error: 'store is read-only (daemon down) — workflow_start is unavailable',
    };
    await expect(taskNew({ ...base, slug: 'x' })).rejects.toMatchObject({ exitCode: 1 });
  });

  it('human renders the started task row to STDERR (slug surfaces)', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskNew({ ...base, slug: 'auth' });
      const c = capture();
      expect(c.out).toBe('');
      expect(c.err).toContain('auth');
      expect(c.err).toContain('Phase');
    } finally {
      restore();
    }
  });
});

describe('task advance — wired to workflow_advance', () => {
  it('forwards --to <phase> as {to} and emits the advanced task', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskAdvance({ ...base, to: 'spec', json: true });
      const c = capture();
      expect(JSON.parse(c.out).ok).toBe(true);
    } finally {
      restore();
    }
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_advance', {
      to: 'spec',
    });
  });

  it('forwards --force <reason> as {force:{reason}}', async () => {
    await taskAdvance({ ...base, force: 'waiting on design' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_advance', {
      force: { reason: 'waiting on design' },
    });
  });

  it('omits to/force when neither is given (active-task default advance)', async () => {
    await taskAdvance({ ...base });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(
      expect.anything(),
      'workflow_advance',
      {},
    );
  });

  it('invalid phase → exit 2 (USAGE), no daemon call', async () => {
    await expect(taskAdvance({ ...base, to: 'bogus' })).rejects.toMatchObject({ exitCode: 2 });
    expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
  });

  it('logical-failure envelope → exit 1', async () => {
    payloads.current.workflow_advance = { ok: false, error: 'no active task' };
    await expect(taskAdvance({ ...base })).rejects.toMatchObject({ exitCode: 1 });
  });

  // Transition surfacing: `--to verify` prints the handoff hint to STDERR.
  // `--no-tips` silences it (CI / log-friendly). `--json` silences it too (a CI
  // consumer's stdout envelope must stay pristine). The hint is advisory only —
  // it never blocks or changes the exit code.
  it('--to verify prints the handoff hint to STDERR', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskAdvance({ ...base, to: 'verify' });
      const c = capture();
      expect(c.err).toContain('noir handoff');
      expect(c.err).toContain('ready-to-paste host prompt');
    } finally {
      restore();
    }
  });

  it('--no-tips silences the handoff hint', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskAdvance({ ...base, to: 'verify', noTips: true });
      const c = capture();
      expect(c.err).not.toContain('noir handoff');
    } finally {
      restore();
    }
  });

  it('--to verify with --json: hint suppressed (stdout envelope stays pristine)', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskAdvance({ ...base, to: 'verify', json: true });
      const c = capture();
      // stdout is the JSON envelope only; stderr carries no hint under --json.
      expect(c.err).not.toContain('noir handoff');
      expect(JSON.parse(c.out).ok).toBe(true);
    } finally {
      restore();
    }
  });

  it('--to spec (not verify) does NOT print the handoff hint', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskAdvance({ ...base, to: 'spec' });
      const c = capture();
      expect(c.err).not.toContain('noir handoff');
    } finally {
      restore();
    }
  });
});

describe('task new --class (c4-surface-wiring S1)', () => {
  it('forwards a valid taskClass as {taskClass}', async () => {
    await taskNew({ ...base, slug: 'feat', taskClass: 'feature' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_start', {
      taskId: 'feat',
      slug: 'feat',
      taskClass: 'feature',
    });
  });

  it('invalid taskClass → exit 2 (USAGE), no daemon call', async () => {
    await expect(taskNew({ ...base, slug: 'x', taskClass: 'bogus' })).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
  });

  it('omits taskClass when not given (legacy shape)', async () => {
    await taskNew({ ...base, slug: 'y' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_start', {
      taskId: 'y',
      slug: 'y',
    });
  });
});

describe('task resume (c4-surface-wiring S2)', () => {
  it('--json emits the resume briefing on STDOUT + calls workflow_resume', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskResume({ ...base, json: true });
      const c = capture();
      const env = JSON.parse(c.out);
      expect(env.ok).toBe(true);
      expect(env.data.resumable).toBe(true);
      expect(env.data.taskId).toBe('auth');
    } finally {
      restore();
    }
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(
      expect.anything(),
      'workflow_resume',
      {},
    );
  });

  it('forwards a positional task id', async () => {
    await taskResume({ ...base, id: 't-42' });
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_resume', {
      taskId: 't-42',
    });
  });

  it('"nothing to resume" envelope → exit 1', async () => {
    payloads.current.workflow_resume = { ok: true, resumable: false, error: 'no resumable task' };
    await expect(taskResume({ ...base })).rejects.toMatchObject({ exitCode: 1 });
  });

  it('human renders the resume briefing on STDERR', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskResume({ ...base });
      const c = capture();
      expect(c.err).toContain('resume');
      expect(c.err).toContain('auth');
    } finally {
      restore();
    }
  });
});

describe('task block / abandon (c4-surface-wiring S4)', () => {
  it('block forwards the reason and renders the blocked row', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskBlock({ ...base, reason: 'CI is red' });
      const c = capture();
      expect(c.err).toContain('blocked');
      expect(c.err).toContain('CI is red');
    } finally {
      restore();
    }
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(expect.anything(), 'workflow_block', {
      reason: 'CI is red',
    });
  });

  it('block with empty reason → exit 2 (USAGE), no daemon call', async () => {
    await expect(taskBlock({ ...base, reason: '   ' })).rejects.toMatchObject({ exitCode: 2 });
    expect(vi.mocked(callDaemonTool)).not.toHaveBeenCalled();
  });

  it('abandon forwards to workflow_abandon and renders the abandoned row (--no-input skips confirm)', async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskAbandon({ ...base, noInput: true });
      const c = capture();
      expect(c.err).toContain('abandoned');
    } finally {
      restore();
    }
    expect(vi.mocked(callDaemonTool)).toHaveBeenCalledWith(
      expect.anything(),
      'workflow_abandon',
      {},
    );
  });
});
