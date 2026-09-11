// Regression anchor for spec 4.3 — the bug the per-project record makes
// unrepresentable.
//
// With the pre-1.14 single global record, `ensureDaemonRunning` for project B
// READ project A's record, saw `rec.projectId !== B`, and CLEARED it (plus, in
// the worst case, started a second writer on A's store). The record is now
// keyed by ProjectId, so B can only ever see `proj-b.json` — A's record is a
// different file that no code path from B can reach. This test fails loudly on
// the old global-record behaviour.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectInfo } from '@noir-ai/core';
import { afterAll, describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-isolation-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;
// Keep the legacy retirer (ensure's first step) off the real ~/.noir.
process.env.NOIR_DAEMON_JSON = join(tmpRoot, 'legacy-daemon.json');

const { writeProjectDaemonRecord, readProjectDaemonRecord } = await import(
  '../src/project-record.js'
);
const { ensureDaemonRunning } = await import('../src/ensure.js');

const rootA = mkdtempSync(join(tmpdir(), 'noir-isolation-a-'));
const rootB = mkdtempSync(join(tmpdir(), 'noir-isolation-b-'));
const config = { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } } as const;

const projB: ProjectInfo = { id: 'proj-b', name: 'proj-b', root: rootB, config };

afterAll(() => {
  for (const d of [tmpRoot, rootA, rootB]) rmSync(d, { recursive: true, force: true });
});

describe('cross-project daemon isolation', () => {
  it("project B activity never deletes project A's recorded daemon", async () => {
    // A has a live-looking record that is deliberately NOT healthy (dead pid),
    // so ensureDaemonRunning for B must not clear A's record on its behalf.
    writeProjectDaemonRecord('proj-a', {
      pid: 2 ** 30,
      port: 1,
      startedAt: 1,
      projectId: 'proj-a',
    });
    // B's ensure may start a real in-process server; tear it down so the test
    // never strands a listener. A start failure is fine (CI hosts vary) — the
    // assertion below is about A's record, not about B's daemon.
    let stop: (() => Promise<void>) | undefined;
    try {
      const ensured = await ensureDaemonRunning({ project: projB, idleTimeoutSec: 900 });
      if (ensured.started) stop = ensured.stop;
    } catch {
      /* start may fail in CI */
    }
    await stop?.().catch(() => undefined);

    // THE REGRESSION: the old global-record code cleared a foreign record here.
    expect(readProjectDaemonRecord('proj-a')).not.toBeNull();
  }, 20000);
});
