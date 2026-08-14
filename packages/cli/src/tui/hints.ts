// Shared hint strings + the keybinding manifest (single source of truth).
//
// Before v2, the same "navigate / run / close" hint was copy-pasted into the
// (now-retired) home menu and palette, and the `?` help screen re-listed every
// binding as a second encoding. This module owns the hint copy once so the
// footer, the palette footer line, and the `help` corpus all render the same
// text and cannot drift from the actual bindings (which live in App.tsx).

/** The dashboard's idle footer hint (the App's keybinding manifest as text). */
export const FOOTER_HINT =
  '?/h/Ctrl+K palette · Ctrl+F find · ↑/↓ scroll · Enter run · q/Esc quit · Ctrl+C exit';

/** The hint shown while a dispatched command is in flight. */
export const RUNNING_HINT = 'running… (Ctrl+C to force exit)';

/** The palette/home list footer hint (navigate · run · close). */
export const LIST_NAV_HINT = '↑/↓ navigate · Enter run · Esc close · Tab corpus';

/** A single keybinding row for the `help` corpus. */
export interface HelpEntry {
  readonly keys: string;
  readonly desc: string;
}

/**
 * The keybinding manifest, rendered by the palette's `help` corpus. Keep this in
 * sync with the App's single `useInput` dispatcher (the same file that owns the
 * bindings) — a drift here is a doc bug, not a behavior bug.
 */
export const HELP_ENTRIES: readonly HelpEntry[] = [
  { keys: '/command', desc: 'run a Noir sub-command (e.g. /status, /sync, /task next)' },
  { keys: 'Enter', desc: 'run the typed /command' },
  { keys: 'Esc', desc: 'back: clear input → dismiss output → quit' },
  { keys: 'q', desc: 'quit (when the input is empty)' },
  { keys: '↑ / ↓', desc: 'scroll the output pane (dashboard) · navigate the list (palette)' },
  { keys: '?', desc: 'palette — help & keybindings (this list)' },
  { keys: 'h', desc: 'palette — commands (quick actions + all commands)' },
  { keys: 'Ctrl+K', desc: 'palette — all commands (fuzzy search)' },
  { keys: 'Ctrl+F', desc: 'palette — find in the dispatched output' },
  { keys: 'Tab', desc: 'switch the palette corpus' },
  { keys: 'y / n', desc: 'approve / decline a destructive command prompt' },
  { keys: 'Ctrl+C', desc: 'force exit' },
];
