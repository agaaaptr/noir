// Single owner of the Noir CLI's semantic palette + status badges.
//
// Built on `picocolors` (the SAME lib the rest of the CLI already uses), so the
// decoration strips consistently under NO_COLOR / non-TTY. cli-table3 styles
// via a SECOND lib (@colors/colors) whose NO_COLOR/TTY semantics differ — that
// split is what painted every table header red while the body stripped. Routing
// ALL color through this module (the `c` object + `badge()`) closes that leak:
// there is exactly one color authority, and it honors NO_COLOR / CLICOLOR_FORCE
// / TTY uniformly.
//
// Accessibility:
//   - `badge()` ALWAYS returns SYMBOL + TEXT LABEL (e.g. `⚠ warn`), so NO_COLOR
//     and colorblind users get identical information. Color is decorative.
//   - `NOIR_ACCESSIBLE` disables the banner gradient (→ solid accent) and is the
//     documented opt-in for users who want the most legible form; badges already
//     carry symbol+text unconditionally, so the flag is a no-op for them.

import pc from 'picocolors';

// A private always-on colorizer. The PUBLIC `c` object gates every call through
// `useColor()`, so `useColor()` is the single live authority over whether ANY
// ANSI leaves this module. (The default `picocolors` export captures its
// `isColorSupported` snapshot once at module load and does NOT honor
// CLICOLOR_FORCE; gating a forced instance here fixes both.)
const FORCE = pc.createColors(true);

/** Badge state → semantic color role. */
export type BadgeState = 'ok' | 'warn' | 'error' | 'info';

/**
 * The semantic palette. Each method returns its input unchanged when color is
 * off (NO_COLOR / non-TTY / not forced), so callers can wrap freely without
 * guarding. Compose with `c.bold(c.info(s))` etc.
 */
export const c = {
  /** Green — success / healthy. */
  ok: (s: string): string => (useColor() ? FORCE.green(s) : s),
  /** Yellow — degraded but usable. */
  warn: (s: string): string => (useColor() ? FORCE.yellow(s) : s),
  /** Red — reserved strictly for ERROR. Never a table header. */
  error: (s: string): string => (useColor() ? FORCE.red(s) : s),
  /** Cyan — informational / brand-neutral accent for labels. */
  info: (s: string): string => (useColor() ? FORCE.cyan(s) : s),
  /** Blue — the Midnight Cobalt brand role (banner / accent). */
  accent: (s: string): string => (useColor() ? FORCE.blue(s) : s),
  /** Dim — secondary text, table borders when color is on. */
  dim: (s: string): string => (useColor() ? FORCE.dim(s) : s),
  /** Bold — emphasis (table headers compose this with `info`). */
  bold: (s: string): string => (useColor() ? FORCE.bold(s) : s),
};

// @clack-style status symbols (the vocabulary Noir inherits via @clack/prompts
// + ora). Paired 1:1 with a state name so a screen reader / pipe / colorblind
// user reads the same fact a sighted interactive user sees.
const BADGE_SYMBOL: Readonly<Record<BadgeState, string>> = {
  ok: '✓',
  warn: '⚠',
  error: '✗',
  info: 'ℹ',
};

/**
 * Render a status badge: always `SYMBOL LABEL`, colored by `state` when color
 * is on. The TEXT LABEL is unconditional — this is the accessibility invariant.
 * `label` defaults to the state name, so `badge('ok')` reads `✓ ok`.
 *
 * @example badge('ok')              // → green "✓ ok"
 * @example badge('warn','degraded') // → yellow "⚠ degraded"
 * @example badge('error','down')    // → red "✗ down"
 */
export function badge(state: BadgeState, label: string = state): string {
  const text = `${BADGE_SYMBOL[state]} ${label}`;
  switch (state) {
    case 'ok':
      return c.ok(text);
    case 'warn':
      return c.warn(text);
    case 'error':
      return c.error(text);
    case 'info':
      return c.info(text);
  }
}

// ---------------------------------------------------------------------------
// Environment gates. Evaluated LIVE (not captured at module load) so tests that
// flip NO_COLOR / CLICOLOR_FORCE between cases see the right answer, and so a
// user exporting NO_COLOR mid-session is honored on the next render.
// ---------------------------------------------------------------------------

function envFlagSet(name: string): boolean {
  // NO_COLOR spec: present AND non-empty disables color (any value).
  const v = process.env[name];
  return v !== undefined && v !== '';
}

/**
 * True when running under a CI runner (GitHub Actions / GitLab / CircleCI /
 * Drone set `CI=true` at the conventional value). Treats the explicit opt-outs
 * `0` / `false` as "not CI" so a user can force-disable the guard. Owned here
 * (the color authority) and re-exported so output.ts doesn't duplicate it.
 */
export function isCiEnv(): boolean {
  const v = process.env.CI;
  if (v === undefined || v === '') return false;
  return v !== '0' && v !== 'false';
}

/**
 * The single authority on whether decoration should emit ANSI. Honors:
 *   - `NO_COLOR`           → always off (spec: present + non-empty).
 *   - `CLICOLOR_FORCE=1`   → always on (forces color on a redirected stream).
 *   - `CI=true` (alone)    → always OFF. picocolors' `isColorSupported`
 *                            snapshot turns color ON under `!!env.CI` (it
 *                            assumes a CI viewer that renders ANSI). But ANSI
 *                            escapes inflate the raw byte length of rendered
 *                            lines, which breaks the responsive-width
 *                            guarantee `max(line.length) <= terminalWidth()`
 *                            that `table()` exists to uphold — and the
 *                            regression test that locks it (fits 60/80/120 in
 *                            theme.test.ts). The CLI's own top-of-file
 *                            contract states decoration auto-disables under
 *                            CI / non-TTY; this honors that. A CI viewer that
 *                            wants color sets `CLICOLOR_FORCE=1` (above).
 *   - otherwise            → picocolors' detection (TTY / FORCE_COLOR).
 */
export function useColor(): boolean {
  if (envFlagSet('NO_COLOR')) return false;
  if (process.env.CLICOLOR_FORCE === '1') return true;
  if (isCiEnv()) return false;
  return pc.isColorSupported;
}

/**
 * `NOIR_ACCESSIBLE`: opt-in maximum legibility. Badges already carry symbol+
 * text unconditionally (so the flag is a no-op for them); the material effect
 * is disabling the banner gradient (→ solid accent) and is reserved here for
 * future accessible-display tweaks.
 */
export function accessibleMode(): boolean {
  return envFlagSet('NOIR_ACCESSIBLE');
}

/**
 * Terminal width in columns. Honors `COLUMNS` (the conventional override) then
 * `process.stdout.columns`, defaulting to 80 when neither is set (the same
 * default `picocolors` / `cli-table3` assume). Floored at a small minimum so a
 * misconfigured shell never produces a degenerate zero/negative-width table.
 */
export function terminalWidth(): number {
  const fromEnv = process.env.COLUMNS;
  if (fromEnv !== undefined && fromEnv !== '') {
    const n = Number(fromEnv);
    if (Number.isInteger(n) && n > 0) return Math.max(n, 20);
  }
  const cols = process.stdout.columns;
  if (typeof cols === 'number' && cols > 0) return Math.max(cols, 20);
  return 80;
}

/**
 * Usable content width inside a bordered TUI panel. Ink's `borderStyle` adds a
 * 1-char border on each side, and `paddingX={1}` adds 1 char inside that — so a
 * full-width rounded panel has `terminalWidth - 4` columns of usable text.
 * Components that truncate long lines (OutputPane) MUST use this, not
 * {@link terminalWidth}, or content overflows the border.
 *
 * @param border chars consumed by the border (default 2 = left + right).
 * @param padding chars consumed by inner padding (default 2 = left + right).
 */
export function contentWidth(border = 2, padding = 2): number {
  return Math.max(20, terminalWidth() - border - padding);
}

/**
 * A horizontal divider line of `─` sized for the current content width. Used
 * inside bordered panels to separate regions (e.g. status bar ↔ output ↔ input)
 * without nesting Ink borders. Always dim so it reads as structure, not content.
 */
export function divider(): string {
  return c.dim('─'.repeat(Math.max(1, contentWidth())));
}
