// C3 — palette command-history persistence. Pure fs tests over a temp NOIR_HOME;
// no TTY, no daemon, no network. Exercises `loadRecent` / `recordRecent` /
// `isHistoryEnabled` and the `__setNoirHome` test override. Verifies the
// projectId-keyed path, the NOIR_DISABLE_TUI_HISTORY opt-out, and the cap.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setNoirHome,
  isHistoryEnabled,
  loadRecent,
  recordRecent,
  TUI_HISTORY_DISABLE_ENV,
} from '../../src/tui/palette/history.js';

const PID = 'proj-test';
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noir-tui-history-'));
  __setNoirHome(home);
});

afterEach(() => {
  __setNoirHome(null);
  delete process.env[TUI_HISTORY_DISABLE_ENV];
  rmSync(home, { recursive: true, force: true });
});

describe('history file location + enablement', () => {
  it('writes the history file projectId-keyed under the Noir home', () => {
    recordRecent(PID, ['status']);
    // projectId-keyed path: <home>/<projectId>/tui-history.json (NOT user-global).
    const file = join(home, PID, 'tui-history.json');
    expect(readFileSync(file, 'utf8')).toContain('status');
  });

  it('isHistoryEnabled is true by default', () => {
    expect(isHistoryEnabled()).toBe(true);
  });

  it('isHistoryEnabled is false under NOIR_DISABLE_TUI_HISTORY', () => {
    process.env[TUI_HISTORY_DISABLE_ENV] = '1';
    expect(isHistoryEnabled()).toBe(false);
  });
});

describe('loadRecent / recordRecent round-trip', () => {
  it('loadRecent returns [] when no history file exists yet', () => {
    expect(loadRecent(PID)).toEqual([]);
  });

  it('recordRecent appends + loadRecent returns newest-first', () => {
    recordRecent(PID, ['status']);
    recordRecent(PID, ['sync']);
    recordRecent(PID, ['context', 'search', 'foo']);
    expect(loadRecent(PID)).toEqual([
      { argv: ['context', 'search', 'foo'], id: 'context search foo' },
      { argv: ['sync'], id: 'sync' },
      { argv: ['status'], id: 'status' },
    ]);
  });

  it('dedupes adjacent duplicates (re-running the same command once is one entry)', () => {
    recordRecent(PID, ['status']);
    recordRecent(PID, ['status']);
    const recent = loadRecent(PID);
    expect(recent).toEqual([{ argv: ['status'], id: 'status' }]);
  });

  it('re-running a command moves it to the front (not duplicated)', () => {
    recordRecent(PID, ['status']);
    recordRecent(PID, ['sync']);
    recordRecent(PID, ['status']);
    const recent = loadRecent(PID);
    expect(recent).toEqual([
      { argv: ['status'], id: 'status' },
      { argv: ['sync'], id: 'sync' },
    ]);
  });

  it('caps the stored history at a bounded number of entries', () => {
    for (let i = 0; i < 60; i++) recordRecent(PID, [`cmd-${i}`]);
    const recent = loadRecent(PID);
    expect(recent.length).toBeLessThanOrEqual(50);
    // newest (highest index) entries win; the oldest are evicted
    expect(recent[0]?.id).toBe('cmd-59');
  });

  it('a corrupted history file degrades to [] instead of throwing', () => {
    const file = join(home, PID, 'tui-history.json');
    mkdirSync(join(home, PID), { recursive: true });
    writeFileSync(file, '{not-json');
    expect(loadRecent(PID)).toEqual([]);
  });

  it('recents are isolated per projectId (not shared across projects)', () => {
    recordRecent('proj-a', ['status']);
    recordRecent('proj-b', ['sync']);
    expect(loadRecent('proj-a').map((e) => e.id)).toEqual(['status']);
    expect(loadRecent('proj-b').map((e) => e.id)).toEqual(['sync']);
    // Different projects write to different dirs — no cross-contamination.
    expect(existsSync(join(home, 'proj-a', 'tui-history.json'))).toBe(true);
    expect(existsSync(join(home, 'proj-b', 'tui-history.json'))).toBe(true);
  });
});

describe('NOIR_DISABLE_TUI_HISTORY opt-out', () => {
  it('recordRecent is a no-op (nothing written) when disabled', () => {
    process.env[TUI_HISTORY_DISABLE_ENV] = '1';
    recordRecent(PID, ['status']);
    expect(loadRecent(PID)).toEqual([]);
    expect(existsSync(join(home, PID, 'tui-history.json'))).toBe(false);
  });

  it('loadRecent returns [] when disabled', () => {
    recordRecent(PID, ['status']);
    process.env[TUI_HISTORY_DISABLE_ENV] = '1';
    expect(loadRecent(PID)).toEqual([]);
  });
});
