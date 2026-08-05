// C3 — palette command-history persistence. Pure fs tests over a temp NOIR_HOME;
// no TTY, no daemon, no network. Exercises `loadRecent` / `recordRecent` /
// `isHistoryEnabled` and the `__setNoirHome` test override.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __setNoirHome,
  isHistoryEnabled,
  loadRecent,
  recordRecent,
} from '../../src/tui/palette/history.js';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noir-tui-history-'));
  __setNoirHome(home);
});

afterEach(() => {
  __setNoirHome(null);
  rmSync(home, { recursive: true, force: true });
});

describe('history file location + enablement', () => {
  it('writes the history file under the Noir home dir', () => {
    recordRecent(['status']);
    const file = join(home, 'tui-history.json');
    expect(readFileSync(file, 'utf8')).toContain('status');
  });

  it('isHistoryEnabled is true by default (file under home)', () => {
    expect(isHistoryEnabled()).toBe(true);
  });
});

describe('loadRecent / recordRecent round-trip', () => {
  it('loadRecent returns [] when no history file exists yet', () => {
    expect(loadRecent()).toEqual([]);
  });

  it('recordRecent appends + loadRecent returns newest-first', () => {
    recordRecent(['status']);
    recordRecent(['sync']);
    recordRecent(['context', 'search', 'foo']);
    expect(loadRecent()).toEqual([
      { argv: ['context', 'search', 'foo'], id: 'context search foo' },
      { argv: ['sync'], id: 'sync' },
      { argv: ['status'], id: 'status' },
    ]);
  });

  it('dedupes adjacent duplicates (re-running the same command once is one entry)', () => {
    recordRecent(['status']);
    recordRecent(['status']);
    const recent = loadRecent();
    expect(recent).toEqual([{ argv: ['status'], id: 'status' }]);
  });

  it('re-running a command moves it to the front (not duplicated)', () => {
    recordRecent(['status']);
    recordRecent(['sync']);
    recordRecent(['status']);
    const recent = loadRecent();
    expect(recent).toEqual([
      { argv: ['status'], id: 'status' },
      { argv: ['sync'], id: 'sync' },
    ]);
  });

  it('caps the stored history at a bounded number of entries', () => {
    for (let i = 0; i < 60; i++) recordRecent([`cmd-${i}`]);
    const recent = loadRecent();
    expect(recent.length).toBeLessThanOrEqual(50);
    // newest (highest index) entries win; the oldest are evicted
    expect(recent[0]?.id).toBe('cmd-59');
  });

  it('a corrupted history file degrades to [] instead of throwing', () => {
    const file = join(home, 'tui-history.json');
    mkdirSync(home, { recursive: true });
    writeFileSync(file, '{not-json');
    expect(loadRecent()).toEqual([]);
  });
});
