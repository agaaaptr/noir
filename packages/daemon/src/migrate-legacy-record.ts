// One-shot retirement of the pre-1.14 single global record. This is the ONLY
// code that reads `~/.noir/daemon.json`; once it has run the file is gone and
// no code path reads the legacy shape again. Without it, a daemon from the
// previous version keeps a write handle on the project DB while the new version
// opens a second one (spec 4.5).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { noirHome } from '@noir-ai/core';
import { pidAlive } from './lifecycle.js';

const DEFAULT_EXIT_TIMEOUT_MS = 5_000;
const POLL_MS = 50;

function legacyPath(): string {
  return process.env.NOIR_DAEMON_JSON ?? join(noirHome(), 'daemon.json');
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return !pidAlive(pid);
}

export async function retireLegacyDaemonRecord(
  opts: { exitTimeoutMs?: number } = {},
): Promise<void> {
  const path = legacyPath();
  if (!existsSync(path)) return; // no-op forever after the first success

  let rec: { pid?: unknown } | null = null;
  try {
    rec = JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown };
  } catch {
    rec = null;
  }

  const pid = typeof rec?.pid === 'number' ? rec.pid : undefined;
  if (pid !== undefined && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone — fall through */
    }
    const exited = await waitForExit(pid, opts.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS);
    if (!exited) {
      // Do NOT remove the file and do NOT let the caller start a second daemon:
      // the legacy daemon still holds a write handle on this project's store.
      throw new Error(
        `a daemon from a previous Noir version (pid ${pid}) did not exit within ` +
          `${opts.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS}ms and still holds this project's ` +
          `store open — stop it with \`kill ${pid}\` and re-run.`,
      );
    }
  }
  rmSync(path, { force: true });
}
