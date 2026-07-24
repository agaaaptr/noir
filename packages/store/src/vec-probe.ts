// Centralized sqlite-vec native-binary availability probe.
//
// sqlite-vec ships a per-platform native binary that the store loads into every
// connection at open time. When the binary is missing/broken on a host, store
// open and any vec operation throw. Workspace packages that consume the store
// (context, daemon, …) need to gate their vec-backed test suites on this — but
// they MUST NOT import `better-sqlite3` / `sqlite-vec` directly: those are the
// store's own dependencies and are not resolvable from other packages under
// pnpm's strict node_modules. This module is the single place that touches the
// native modules; everyone else asks the store via `vecAvailability()`.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type VecAvailability = { ok: true } | { ok: false; reason: string };

let cached: VecAvailability | undefined;

/**
 * Probe sqlite-vec native availability ONCE (memoized). Returns `{ ok: true }`
 * when the binary loads, else `{ ok: false, reason }`. Use to gate vec-backed
 * test suites (`describe.skip` on absence) so the default suite stays green
 * offline on an unsupported platform.
 */
export function vecAvailability(): VecAvailability {
  if (cached) return cached;
  try {
    const probe = new Database(':memory:');
    sqliteVec.load(probe);
    probe.close();
    cached = { ok: true };
  } catch (e) {
    cached = { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  return cached;
}
