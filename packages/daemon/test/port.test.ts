// `daemon.port` is a PREFERENCE, not a demand (spec 5.2). This test pins the two
// halves of that contract:
//   - a free configured port is bound verbatim and recorded;
//   - a taken port degrades to ephemeral with a warning, and the record always
//     carries the port ACTUALLY bound (so the record never lies).

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-port-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

const { startHttpServer } = await import('../src/http.js');
const { readProjectDaemonRecord } = await import('../src/project-record.js');
const project = { id: 'port-proj', root: tmpRoot, config: {}, name: 'p' } as never;

const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s().catch(() => {});
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('daemon.port', () => {
  it('binds the configured port when free, and records it', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const free = (blocker.address() as { port: number }).port;
    await new Promise<void>((r) => blocker.close(() => r()));
    const d = await startHttpServer({ project, idleTimeoutSec: 900, port: free });
    stops.push(d.stop);
    expect(d.port).toBe(free);
    expect(readProjectDaemonRecord('port-proj')?.port).toBe(free);
  });

  it('falls back to ephemeral on EADDRINUSE and records the ACTUAL port', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as { port: number }).port;
    try {
      const d = await startHttpServer({ project, idleTimeoutSec: 900, port: taken });
      stops.push(d.stop);
      expect(d.port).not.toBe(taken);
      expect(d.port).toBeGreaterThan(0);
      expect(readProjectDaemonRecord('port-proj')?.port).toBe(d.port); // truthful record
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
