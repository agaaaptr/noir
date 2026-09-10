// Workspace change feed — a monotonic cursor + a bounded ring of change entries,
// stored in the workspace store's KV, plus in-process long-poll waiters.
//
// The cursor is the workspace's single ordering authority (spec §7.2): every
// mutation (save / supersede / forget) bumps it, and each feed entry carries the
// cursor it was assigned. Because the workspace daemon is ONE process, `await_changes`
// long-polling needs no cross-process signalling — waiters are registered here
// and woken synchronously after a write (`wakeFeedWaiters`). This is the
// cross-host-reliable "notification" (content push is an anti-pattern — spec §2).
import type { Store } from '@noir-ai/store';

const WORKSPACE_CURSOR_KEY = 'workspace:cursor';
const WORKSPACE_FEED_KEY = 'workspace:feed';
const FEED_RING_LIMIT = 500;

export type FeedKind = 'save' | 'supersede' | 'forget';

/** A change-feed entry: minimal denormalized projection (id + summary — never full content). */
export interface FeedEntry {
  cursor: number;
  kind: FeedKind;
  id: string;
  repo: string;
  type: string;
  summary: string;
  ts: number;
}

function currentCursor(store: Store): number {
  return store.getState<number>(WORKSPACE_CURSOR_KEY) ?? 0;
}

function bumpCursor(store: Store): number {
  const next = currentCursor(store) + 1;
  store.setState(WORKSPACE_CURSOR_KEY, next);
  return next;
}

/** Append a feed entry (stamping its cursor) into a bounded ring. */
export function appendFeed(store: Store, entry: Omit<FeedEntry, 'cursor'>): FeedEntry {
  const full: FeedEntry = { ...entry, cursor: bumpCursor(store) };
  const feed = store.getState<FeedEntry[]>(WORKSPACE_FEED_KEY) ?? [];
  feed.push(full);
  if (feed.length > FEED_RING_LIMIT) feed.splice(0, feed.length - FEED_RING_LIMIT);
  store.setState(WORKSPACE_FEED_KEY, feed);
  return full;
}

export function changesSince(
  store: Store,
  cursor: number,
): { cursor: number; changes: FeedEntry[] } {
  const feed = store.getState<FeedEntry[]>(WORKSPACE_FEED_KEY) ?? [];
  return { cursor: currentCursor(store), changes: feed.filter((e) => e.cursor > cursor) };
}

/** One-line, bounded summary for a feed entry (never full content — token-efficient). */
export function summarize(content: string, max = 120): string {
  const first = content.split('\n')[0] ?? '';
  if (first.length <= max) return first;
  return `${first.slice(0, max - 1)}…`;
}

export function clearFeedState(store: Store): void {
  store.setState(WORKSPACE_CURSOR_KEY, 0);
  store.setState(WORKSPACE_FEED_KEY, []);
}

// --- long-poll waiters (single-daemon process only) ---
interface Waiter {
  cursor: number;
  resolve: (woken: boolean) => void;
}

const waiters: Waiter[] = [];

/** Wake every waiter whose cursor is behind the current cursor. Called after a write. */
export function wakeFeedWaiters(store: Store): void {
  const cursor = currentCursor(store);
  // Snapshot — `resolve` mutates `waiters` (removes the waiter).
  for (const w of [...waiters]) {
    if (w.cursor < cursor) w.resolve(true);
  }
}

/** Resolve true as soon as the cursor advances past `cursor`, false on timeout. */
export function waitForFeedChange(
  store: Store,
  cursor: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (currentCursor(store) > cursor) {
      resolve(true);
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter: Waiter = {
      cursor,
      resolve: (woken: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        resolve(woken);
      },
    };
    waiters.push(waiter);
    timer = setTimeout(() => waiter.resolve(false), timeoutMs);
  });
}
