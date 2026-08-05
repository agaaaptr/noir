// C3 — palette command-history persistence.
//
// The palette shows the user's recently-run commands above the full list on an
// empty query. That recency data lives on disk (`~/.noir/tui-history.json`,
// user-scoped like the daemon record) so it survives sessions. The file is a
// simple newest-first JSON array of `{ argv, id }` (id is the space-joined argv
// — the same stable dispatch key the registry uses), which keeps it easy to
// diff and prune.
//
// Bounds: `MAX_ENTRIES` (50) caps the file so it never grows without bound, and
// every write is a truncating atomic replace (`writeFileSync` + rename) so a
// crash mid-write never leaves a half-written JSON blob. A corrupt file (manual
// edit, truncated write from an older build) degrades to `[]` rather than
// throwing — recency is a nice-to-have, never a crash.
//
// Test seam: `__setNoirHome` overrides the home dir so the offline suite can
// point at a tmpdir instead of the real `~/.noir` (mirrors `NOIR_RUNTIME_DIR` /
// `NOIR_DAEMON_JSON`). `isHistoryEnabled` is always true today — the gate exists
// so a future `--no-history` / config flag can disable persistence without
// touching the callers.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A single entry in the persisted recent-commands list. */
export interface RecentEntry {
  /** The raw argv the user selected (e.g. `['context','search','foo']`). */
  readonly argv: readonly string[];
  /** Space-joined argv — the stable dispatch key (e.g. `context search foo`). */
  readonly id: string;
}

/** Bounded history size — the palette only needs a handful of recents. */
const MAX_ENTRIES = 50;

let testHome: string | null = null;

/**
 * Test override for the Noir home dir. Pass `null` to restore the real
 * `~/.noir` resolution. Never called from production code.
 */
export function __setNoirHome(home: string | null): void {
  testHome = home;
}

/** The user-global Noir home (test override wins when set). */
function homeDir(): string {
  return testHome ?? join(homedir(), '.noir');
}

/** Path of the palette history file: `<home>/tui-history.json`. */
function historyFile(): string {
  return join(homeDir(), 'tui-history.json');
}

/**
 * Whether palette history persistence is enabled. Always true today; the gate is
 * the seam for a future opt-out (config flag, `--no-history`).
 */
export function isHistoryEnabled(): boolean {
  return true;
}

/**
 * Load the persisted recent commands, newest first. Returns `[]` when the file
 * is missing, empty, or corrupt — recency is best-effort and must never throw.
 */
export function loadRecent(): RecentEntry[] {
  const file = historyFile();
  try {
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const entries: RecentEntry[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const argv = (item as { argv?: unknown }).argv;
      const id = (item as { id?: unknown }).id;
      if (!Array.isArray(argv) || typeof id !== 'string') continue;
      if (!argv.every((tok): tok is string => typeof tok === 'string')) continue;
      entries.push({ argv, id });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Record a dispatched command as the newest recent entry. Adjacent duplicates
 * are dropped (re-running the same command once is one entry); re-running a
 * command from deeper in the list moves it to the front. The persisted list is
 * capped at {@link MAX_ENTRIES}. Best-effort: a failed write is swallowed.
 */
export function recordRecent(argv: readonly string[]): void {
  if (argv.length === 0) return;
  const entry: RecentEntry = { argv, id: argv.join(' ') };
  const current = loadRecent().filter((e) => e.id !== entry.id);
  const next = [entry, ...current].slice(0, MAX_ENTRIES);
  try {
    const dir = homeDir();
    mkdirSync(dir, { recursive: true });
    const file = historyFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // Recency is a nice-to-have — a read-only home (or a full disk) must not
    // break command dispatch.
  }
}
