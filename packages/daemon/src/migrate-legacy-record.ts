// One-shot retirement of the pre-1.14 single global record. After the
// per-project-record migration lands, this will be the ONLY code that reads
// `~/.noir/daemon.json`; once it has run the file is gone and no code path
// reads the legacy shape again. Without it, a daemon from the previous version
// keeps a write handle on the project DB while the new version opens a second
// one (spec 4.5).
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { uptime } from 'node:os';
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

  const timeoutMs = opts.exitTimeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;

  // Read the raw bytes FIRST, separately from parsing: a file that exists but
  // cannot be read (root-owned from a `sudo noir` run, EMFILE, …) is NOT the
  // same as a corrupt record. A live legacy daemon may still hold the project
  // DB, so refusing is the only safe move — never delete a guard file we could
  // not read.
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    throw new Error(
      `cannot read the legacy daemon record (${code}) — fix the file's ` +
        `readability or remove it manually, then re-run.`,
    );
  }

  // Bytes were read; an unparseable or pid-less record is genuinely unknowable,
  // so retiring the file is safe and correct.
  let rec: { pid?: unknown; startedAt?: unknown } | null = null;
  try {
    rec = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
  } catch {
    rec = null;
  }

  const pid = typeof rec?.pid === 'number' ? rec.pid : undefined;
  const startedAt = typeof rec?.startedAt === 'number' ? rec.startedAt : undefined;

  // Only signal a pid that plausibly belongs to THIS boot. After a reboot the
  // OS reallocates pids from a low counter, so a record left by a force-reboot
  // may name an unrelated process that happens to be alive right now — and
  // signalling it would kill the user's editor or browser. A `startedAt` that
  // predates the current boot proves the daemon is long gone.
  const bootBoundary = Date.now() - uptime() * 1000;
  const stale = startedAt !== undefined && startedAt < bootBoundary;

  if (!stale && pid !== undefined && pidAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone — fall through */
    }
    const exited = await waitForExit(pid, timeoutMs);
    if (!exited) {
      // Do NOT remove the file and do NOT let the caller start a second daemon:
      // the legacy daemon still holds a write handle on this project's store.
      throw new Error(
        `a daemon from a previous Noir version (pid ${pid}) did not exit within ` +
          `${timeoutMs}ms and still holds this project's ` +
          `store open — stop it with \`kill ${pid}\` and re-run.`,
      );
    }
  }
  rmSync(path, { force: true });
}
