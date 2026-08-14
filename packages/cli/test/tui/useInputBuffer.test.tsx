// TDD-B1 — the dashboard input-buffer hook. Tests run the hook inside a tiny
// Ink component that captures the live values into a mutable holder (no TTY,
// no daemon, no network). The hook owns the text buffer + in-memory command
// history + recall cursor that the refactored `App` keybindings use, and must
// expose exactly the surface the plan's `A useInputBuffer` defines: setBuffer,
// pushHistory, recall, clear.
//
// Contract under test:
// - `buffer` defaults to `''`; `setBuffer` applies a `(prev) => string` updater.
// - `pushHistory` records non-empty text newest-first; adjacent duplicates are
//   dropped (re-submitting the same command does not grow the history).
// - `recall` walks the history with cursor `-1` = not recalling: `up` returns
//   the newest entry then walks older (clamped at the oldest); `down` walks
//   back toward the edit line and returns `null` past the newest boundary.
// - `clear` resets the buffer AND the recall cursor (history persists).

import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { useInputBuffer } from '../../src/tui/hooks/useInputBuffer.js';

/** The hook surface, captured live from a mounted harness. */
interface Capture {
  setBuffer: (updater: (prev: string) => string) => void;
  pushHistory: (text: string) => void;
  recall: (dir: 'up' | 'down') => string | null;
  clear: () => void;
  seed: (entries: readonly string[]) => void;
  buffer: string;
}

/** Resolve after a macrotask so React's async state flushes land. */
function flush(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mount a harness that reflects the hook's current values into `capture`. */
function mount(): { capture: Capture; unmount: () => void } {
  const capture = {} as Capture;
  function Harness(): ReactElement {
    const ib = useInputBuffer();
    capture.setBuffer = ib.setBuffer;
    capture.pushHistory = ib.pushHistory;
    capture.recall = ib.recall;
    capture.clear = ib.clear;
    capture.seed = ib.seed;
    capture.buffer = ib.buffer;
    return <Text> </Text>;
  }
  const instance = render(<Harness />);
  return { capture, unmount: () => instance.unmount() };
}

describe('useInputBuffer — buffer', () => {
  it('mounts with an empty buffer', () => {
    const { capture, unmount } = mount();
    expect(capture.buffer).toBe('');
    unmount();
  });

  it('setBuffer applies an updater to the current buffer', async () => {
    const { capture, unmount } = mount();
    capture.setBuffer(() => '/sync');
    await flush();
    expect(capture.buffer).toBe('/sync');
    capture.setBuffer((prev) => `${prev} now`);
    await flush();
    expect(capture.buffer).toBe('/sync now');
    unmount();
  });
});

describe('useInputBuffer — history + recall cursor', () => {
  it('pushHistory records commands newest-first; up recalls them newest → oldest', () => {
    const { capture, unmount } = mount();
    capture.pushHistory('/one');
    capture.pushHistory('/two');
    capture.pushHistory('/three');
    // First up returns the most recent entry (cursor -1 → newest).
    expect(capture.recall('up')).toBe('/three');
    expect(capture.recall('up')).toBe('/two');
    expect(capture.recall('up')).toBe('/one');
    unmount();
  });

  it('recall clamps at the oldest entry instead of walking off the end', () => {
    const { capture, unmount } = mount();
    capture.pushHistory('/one');
    capture.pushHistory('/two');
    expect(capture.recall('up')).toBe('/two');
    expect(capture.recall('up')).toBe('/one');
    expect(capture.recall('up')).toBe('/one'); // clamped at the oldest
    unmount();
  });

  it('down walks newer and returns null past the newest (back to the edit line)', () => {
    const { capture, unmount } = mount();
    capture.pushHistory('/one');
    capture.pushHistory('/two');
    capture.pushHistory('/three');
    expect(capture.recall('up')).toBe('/three');
    expect(capture.recall('up')).toBe('/two');
    expect(capture.recall('down')).toBe('/three');
    expect(capture.recall('down')).toBeNull(); // past the newest → edit line
    unmount();
  });

  it('down at the not-recalling cursor is a no-op (null)', () => {
    const { capture, unmount } = mount();
    capture.pushHistory('/sync');
    expect(capture.recall('down')).toBeNull();
    unmount();
  });

  it('empty history cannot be recalled', () => {
    const { capture, unmount } = mount();
    expect(capture.recall('up')).toBeNull();
    expect(capture.recall('down')).toBeNull();
    unmount();
  });

  it('pushHistory ignores empty text', () => {
    const { capture, unmount } = mount();
    capture.pushHistory('');
    expect(capture.recall('up')).toBeNull();
    unmount();
  });

  it('adjacent duplicates are dropped — re-submitting the same command does not grow the history', () => {
    const { capture, unmount } = mount();
    capture.pushHistory('/sync');
    capture.pushHistory('/sync'); // adjacent dup → no-op
    capture.pushHistory('/status');
    capture.pushHistory('/status'); // adjacent dup → no-op
    expect(capture.recall('up')).toBe('/status');
    expect(capture.recall('up')).toBe('/sync');
    expect(capture.recall('up')).toBe('/sync'); // clamped at the oldest, only one /sync entry
    unmount();
  });

  it('clear resets the buffer and the recall cursor (history persists)', async () => {
    const { capture, unmount } = mount();
    capture.pushHistory('/sync');
    capture.setBuffer(() => '/partial');
    await flush();
    expect(capture.buffer).toBe('/partial');
    expect(capture.recall('up')).toBe('/sync');
    capture.clear();
    await flush();
    expect(capture.buffer).toBe('');
    // Cursor reset to -1: the next up starts over from the newest entry.
    expect(capture.recall('up')).toBe('/sync');
    unmount();
  });

  it('seed replaces the session history with the persisted recents (source of truth)', () => {
    const { capture, unmount } = mount();
    capture.pushHistory('/stale');
    capture.seed(['/context search foo', '/sync']);
    // Seeded list is walked newest-first; the stale in-memory entry is gone.
    expect(capture.recall('up')).toBe('/context search foo');
    expect(capture.recall('up')).toBe('/sync');
    expect(capture.recall('up')).toBe('/sync'); // clamped at the oldest
    unmount();
  });

  it('pushHistory moves a re-run to the front instead of duplicating', () => {
    const { capture, unmount } = mount();
    capture.pushHistory('/a');
    capture.pushHistory('/b');
    capture.pushHistory('/a'); // re-run → move-to-front, not duplicate
    expect(capture.recall('up')).toBe('/a');
    expect(capture.recall('up')).toBe('/b');
    expect(capture.recall('up')).toBe('/b'); // clamped; only one /a entry
    unmount();
  });
});

describe('useInputBuffer — stable identities (regression: OOM)', () => {
  it('returned functions keep their identity across renders (seed is used in a useEffect dep)', async () => {
    const { capture, unmount } = mount();
    const seed = capture.seed;
    const push = capture.pushHistory;
    const recall = capture.recall;
    const clear = capture.clear;
    // Force a re-render; the hook must return the SAME function objects, else a
    // `useEffect` that depends on `seed` re-runs every render → infinite
    // setState loop → memory leak → OOM (the 1.11.0 idle-crash bug).
    capture.setBuffer(() => '/re-render');
    await flush();
    expect(capture.seed).toBe(seed);
    expect(capture.pushHistory).toBe(push);
    expect(capture.recall).toBe(recall);
    expect(capture.clear).toBe(clear);
    unmount();
  });
});
