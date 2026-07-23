import type { ProjectInfo } from '@noir-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDaemonRunning } from '../src/ensure.js';
import { clearDaemonRecord, writeDaemonRecord } from '../src/lifecycle.js';

// Node 20+ provides a global fetch (typed via @types/node); no import needed.

const project: ProjectInfo = {
  id: 'ensure',
  name: 'ensure-demo',
  root: '/tmp/ensure',
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

afterEach(() => {
  clearDaemonRecord();
});

describe('ensureDaemonRunning', () => {
  it('starts a daemon, reports started=true, and /health is reachable', async () => {
    const { url, started, stop } = await ensureDaemonRunning({ project, idleTimeoutSec: 900 });
    try {
      expect(started).toBe(true);
      const res = await fetch(`${url.replace(/\/mcp$/, '')}/health`);
      expect(res.status).toBe(200);
    } finally {
      // Closes the in-process http server, clears daemon.json, clears the idle timer.
      await stop();
    }
  }, 20000);

  it('reuses an already-running healthy daemon within the same process', async () => {
    // Start once — owns the in-process server; its `stop` is the real teardown.
    const first = await ensureDaemonRunning({ project, idleTimeoutSec: 900 });
    try {
      // Second call must observe the first's healthy daemon and reuse it.
      const second = await ensureDaemonRunning({ project, idleTimeoutSec: 900 });
      expect(second.started).toBe(false);
      expect(second.url).toBe(first.url);
      // A reused daemon's `stop` is a no-op (owned elsewhere); must never throw
      // or kill the current process (pid would equal process.pid here).
      await second.stop();
    } finally {
      await first.stop();
    }
  }, 20000);

  it('reclaims a stale record (pid dead) and starts fresh', async () => {
    // Bogus record pointing at a dead pid + unreachable port.
    writeDaemonRecord({ pid: 2_000_000, port: 1, startedAt: 1 });
    const { started, stop } = await ensureDaemonRunning({ project, idleTimeoutSec: 900 });
    try {
      expect(started).toBe(true);
    } finally {
      await stop();
    }
  }, 20000);
});
