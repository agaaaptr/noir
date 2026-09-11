// Minimal daemon lifecycle helpers that survive the per-project-record
// migration. The legacy global record (`~/.noir/daemon.json`) and its
// read/write/clear helpers were removed with spec 4.3 — the daemon record is
// now keyed by ProjectId in `project-record.ts`, and only
// `migrate-legacy-record.ts` still knows the old path (its `legacyPath()`
// deliberately duplicates it).

/** The env var `spawnDetachedDaemon` sets so the child writes a `detached` record. */
export const DAEMON_MODE_ENV = 'NOIR_DAEMON_MODE';

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
