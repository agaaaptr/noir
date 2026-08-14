// B1 — the dashboard input-buffer hook. Extracted from `App.tsx` so the
// command-history + recall-cursor state can live with the keybindings that use
// it instead of dangling inside the App's single `useInput` closure. Owns:
//   - `buffer` — the current text being composed at the prompt.
//   - `history` — in-memory command history (newest first), with move-to-front
//     dedup (matches the persisted recents store).
//   - `recall` — Up/Down history walk via an index cursor (`-1` = not
//     recalling).
//   - `seed` — replace the session history with the persisted recents.
//
// Deliberately tiny + framework-shaped like the rest of the TUI state: `buffer`
// is a React state string so keystrokes rerender the CommandInput, while
// `history` + the cursor are refs (they are recalled on demand, never painted).
//
// IMPORTANT: every returned function is wrapped in `useCallback` so its identity
// is STABLE across renders. The App passes `seed` into a `useEffect` dependency
// array (`[deps.loadRecent, seed]`); a plain function re-created each render
// would make that effect re-run every render — an infinite setState loop that
// leaks memory and OOMs the TUI after ~a minute of idle. All these functions
// only touch refs (+ the stable `setBuffer`), so `useCallback(…, [])` is safe.

import { useCallback, useRef, useState } from 'react';

/** Cap on the in-memory session history (mirrors the persisted recents cap). */
const MAX_HISTORY = 50;

/** The input-buffer + command-history surface the App's keybindings consume. */
export interface InputBuffer {
  /** The text currently being composed (never `undefined`). */
  readonly buffer: string;
  /** Apply an updater to the current buffer (React `useState` setter shape). */
  setBuffer: (updater: (prev: string) => string) => void;
  /** Record a submitted command into history (newest first, move-to-front dedup). */
  pushHistory: (text: string) => void;
  /**
   * Walk the command history from the recall cursor. `up` returns the next
   * older entry (or the newest when not recalling); `down` returns the next
   * newer entry. Either direction clamps at its boundary — past the newest it
   * returns `null` (back on the edit line).
   */
  recall: (dir: 'up' | 'down') => string | null;
  /** Empty the buffer and reset the recall cursor to "not recalling". */
  clear: () => void;
  /**
   * Replace the session history with the persisted recents (the source of
   * truth). Called once after `loadRecent` resolves so shell recall and the
   * palette recents read the same list instead of diverging.
   */
  seed: (entries: readonly string[]) => void;
}

/**
 * Mount the dashboard's input buffer + in-memory history. `clear` is what a
 * successful submit / an Escape-back invokes: it empties the buffer AND parks
 * the recall cursor so the next Up starts over from the newest entry, while
 * leaving `history` intact for the session.
 */
export function useInputBuffer(): InputBuffer {
  const [buffer, setBuffer] = useState('');
  // Newest command first. Refs, never state: history is only read on demand
  // by `recall`, so storing it in state would rerender the App for no benefit.
  const historyRef = useRef<string[]>([]);
  // Index into `historyRef.current`; -1 = not recalling (editing fresh text).
  const cursorRef = useRef(-1);

  const pushHistory = useCallback((text: string): void => {
    if (text.length === 0) return;
    // Move-to-front dedup (matches `recordRecent` in palette/history.ts): an
    // exact re-run moves the entry to the head instead of duplicating, so the
    // shell-recall overlay and the persisted recents apply one dedup rule.
    const history = historyRef.current.filter((e) => e !== text);
    // Cap at MAX_HISTORY so a long session running many distinct commands does
    // not grow the in-memory overlay without bound (the persisted store is
    // already capped at 50).
    historyRef.current = [text, ...history].slice(0, MAX_HISTORY);
  }, []);

  const recall = useCallback((dir: 'up' | 'down'): string | null => {
    const history = historyRef.current;
    if (history.length === 0) return null;
    let cursor = cursorRef.current;
    if (dir === 'up') {
      // -1 (edit line) steps to the newest; otherwise walk one older, clamped
      // at the oldest entry so Up can never walk off the front of the list.
      cursor = cursor === -1 ? 0 : Math.min(cursor + 1, history.length - 1);
    } else {
      // Walk newer; stepping past the newest returns to the edit line.
      cursor = cursor === -1 ? -1 : cursor - 1;
    }
    cursorRef.current = cursor;
    return cursor === -1 ? null : (history[cursor] ?? null);
  }, []);

  const clear = useCallback((): void => {
    setBuffer(() => '');
    cursorRef.current = -1;
  }, []);

  const seed = useCallback((entries: readonly string[]): void => {
    historyRef.current = [...entries];
    cursorRef.current = -1;
  }, []);

  return { buffer, setBuffer, pushHistory, recall, clear, seed };
}
