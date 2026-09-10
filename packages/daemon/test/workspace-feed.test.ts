import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendFeed,
  changesSince,
  clearFeedState,
  summarize,
  waitForFeedChange,
  wakeFeedWaiters,
} from '../src/feed.js';

let root: string;
let store: Awaited<ReturnType<typeof openStore>>;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'noir-wsfeed-'));
  store = await openStore({ projectId: 'demo', root });
});
afterEach(async () => {
  await store.close();
  rmSync(root, { recursive: true, force: true });
});

describe('workspace feed', () => {
  it('assigns monotonic cursors and reports changes since a cursor', () => {
    clearFeedState(store);
    const e1 = appendFeed(store, {
      kind: 'save',
      id: 'a',
      repo: 'be',
      type: 'decision',
      summary: 'one',
      ts: 1,
    });
    const e2 = appendFeed(store, {
      kind: 'supersede',
      id: 'b',
      repo: 'fe',
      type: 'fact',
      summary: 'two',
      ts: 2,
    });
    expect(e2.cursor).toBeGreaterThan(e1.cursor);
    const since0 = changesSince(store, 0);
    expect(since0.changes).toHaveLength(2);
    const since1 = changesSince(store, e1.cursor);
    expect(since1.changes.map((c) => c.id)).toEqual(['b']);
  });

  it('summarize bounds to the first line at the max length', () => {
    expect(summarize('one line')).toBe('one line');
    expect(summarize('a'.repeat(300))).toHaveLength(120);
  });

  it('waitForFeedChange wakes when the cursor advances (in-process)', async () => {
    clearFeedState(store);
    const pending = waitForFeedChange(store, 0, 5000);
    // a write advances the cursor and wakes waiters
    appendFeed(store, { kind: 'save', id: 'x', repo: 'be', type: 'fact', summary: 'wake', ts: 1 });
    wakeFeedWaiters(store);
    const woken = await pending;
    expect(woken).toBe(true);
  });

  it('waitForFeedChange times out when nothing advances', async () => {
    clearFeedState(store);
    const woken = await waitForFeedChange(store, 0, 50);
    expect(woken).toBe(false);
  });

  it('signals a gap when the ring evicted entries older than the caller cursor', () => {
    clearFeedState(store);
    // Fill past the 500-entry ring so the earliest entries are evicted.
    for (let i = 0; i < 510; i++) {
      appendFeed(store, { kind: 'save', id: `e${i}`, repo: 'be', type: 'fact', summary: `s${i}`, ts: i });
    }
    // A client at cursor 0 predates the oldest surviving entry → gapped.
    const stale = changesSince(store, 0);
    expect(stale.gapped).toBe(true);
    // A client past the oldest surviving entry is NOT gapped.
    const fresh = changesSince(store, stale.cursor);
    expect(fresh.gapped).toBe(false);
    expect(fresh.changes).toHaveLength(0);
  });
});
