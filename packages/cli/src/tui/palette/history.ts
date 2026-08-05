// C3 — palette command-history persistence.
//
// The palette shows the user's recently-run commands above the full list on an
// empty query. That recency data lives on disk so it survives sessions. The file
// is keyed by canonical ProjectId — `~/.noir/<projectId>/tui-history.json` (NOT a
// filesystem path) — so it respects the `.noir/` single-source-of-truth invariant
// (CLAUDE.md): a project's recents are isolated from every other project. The
// file is a simple newest-first JSON array of `{ argv, id }` (id is the
// space-joined argv — the same stable dispatch key the registry uses).
//
// Opt-out: set `NOIR_DISABLE_TUI_HISTORY=1` to make persistence in-memory only
// (loadRecent/recordRecent become no-ops). Useful for ephemeral/CI shells.
//
// Bounds: `MAX_ENTRIES` (50) caps the file so it never grows without bound, and
// every write is atomic via the shared `atomicWriteFile` (@noir-ai/core — the
// same helper daemon/lifecycle.ts and update-check.ts use) so a crash mid-write
// never leaves a half-written JSON blob. A corrupt file (manual edit, truncated
// write from an older build) degrades to `[]` rather than throwing — recency is
// a nice-to-have, never a crash.
//
// Test seam: `__setNoirHome` overrides the home dir so the offline suite can
// point at a tmpdir instead of the real `~/.noir` (mirrors `NOIR_DAEMON_JSON`).

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '@noir-ai/core';

/** A single entry in the persisted recent-commands list. */
export interface RecentEntry {
  /** The raw argv the user selected (e.g. `['context','search','foo']`). */
  readonly argv: readonly string[];
  /** Space-joined argv — the stable dispatch key (e.g. `context search foo`). */
  readonly id: string;
}

/** Bounded history size — the palette only needs a handful of recents. */
const MAX_ENTRIES = 50;

/** The env var that disables palette-history persistence (in-memory only). */
export const TUI_HISTORY_DISABLE_ENV = 'NOIR_DISABLE_TUI_HISTORY';

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

/**
 * Path of the palette history file for a project:
 * `<home>/<projectId>/tui-history.json`. ProjectId-keyed so recents are isolated
 * per project (respects the `.noir/` single-source-of-truth invariant).
 */
function historyFile(projectId: string): string {
  return join(homeDir(), projectId, 'tui-history.json');
}

/**
 * Whether palette history persistence is enabled. Honors
 * `NOIR_DISABLE_TUI_HISTORY` (any non-empty value disables it → in-memory only).
 */
export function isHistoryEnabled(): boolean {
  const v = process.env[TUI_HISTORY_DISABLE_ENV];
  return v === undefined || v === '';
}

/**
 * Load the persisted recent commands for `projectId`, newest first. Returns `[]`
 * when persistence is disabled, the file is missing/empty/corrupt — recency is
 * best-effort and must never throw.
 */
export function loadRecent(projectId: string): RecentEntry[] {
  if (!isHistoryEnabled()) return [];
  const file = historyFile(projectId);
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
 * Record a dispatched command as the newest recent entry for `projectId`.
 * Adjacent duplicates are dropped (re-running the same command once is one
 * entry); re-running a command from deeper in the list moves it to the front.
 * The persisted list is capped at {@link MAX_ENTRIES}. No-op when persistence is
 * disabled. Best-effort: a failed write is swallowed (recency is a nice-to-have
 * — a read-only home or a full disk must not break command dispatch).
 */
export function recordRecent(projectId: string, argv: readonly string[]): void {
  if (argv.length === 0) return;
  if (!isHistoryEnabled()) return;
  const entry: RecentEntry = { argv, id: argv.join(' ') };
  const current = loadRecent(projectId).filter((e) => e.id !== entry.id);
  const next = [entry, ...current].slice(0, MAX_ENTRIES);
  try {
    const dir = join(homeDir(), projectId);
    mkdirSync(dir, { recursive: true });
    atomicWriteFile(historyFile(projectId), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // Recency is a nice-to-have — a read-only home (or a full disk) must not
    // break command dispatch.
  }
}
