// SP-B — Noir banner.
//
// Pre-rendered "noir" ASCII wordmark (figlet "ANSI Shadow", generated offline
// and VERIFIED letter-by-letter to read N-O-I-R — an earlier hand-rolled
// version had a malformed R that rendered as "NOHA") with a SMOOTH gradient via
// gradient-string. (A per-row rainbow was garish; a smooth vertical gradient is
// the modern look — cf. the GitHub Copilot CLI banner engineering post.)
//
// Guardrails: only the interactive home arm calls this (isInteractive already
// gates TTY/CI/NO_COLOR/--json/--no-input); shouldShowBanner additionally
// skips --quiet and NOIR_NO_BANNER. color:false → zero ANSI for snapshots/CI.
// Responsive: ≥50 cols → block wordmark; <50 → compact `◆ noir` mark.
import gradient from 'gradient-string';
import type { CliOptions } from './output.js';
import { accessibleMode, c, useColor } from './theme.js';

// figlet "ANSI Shadow" — regenerated 2026-07-26 from the standard per-letter
// glyphs and verified (N, O, I, R) to read "NOIR". Do NOT hand-edit — regenerate
// via `figlet -f "ANSI Shadow" NOIR` if a glyph changes.
const NOIR_BLOCK = [
  '███╗   ██╗  ██████╗  ██╗ ██████╗ ',
  '████╗  ██║ ██╔═══██╗ ██║ ██╔══██╗',
  '██╔██╗ ██║ ██║   ██║ ██║ ██████╔╝',
  '██║╚██╗██║ ██║   ██║ ██║ ██╔══██║',
  '██║ ╚████║ ╚██████╔╝ ██║ ██║  ██║',
  '╚═╝  ╚═══╝  ╚═════╝  ╚═╝ ╚═╝  ╚═╝',
];

// "noir" aesthetic — Midnight Cobalt: a smooth gradient-string gradient (dark
// cobalt → bright blue → sky) applied per-character across the wordmark
// (vertical, top → bottom). All stops are bright enough to read on a dark
// terminal; the deep-blue start evokes "midnight" without disappearing.
const NOIR_GRADIENT = gradient('#2c5282', '#3b82f6', '#7dd3fc');

/** One-line product tagline (shown under the wordmark). */
export const NOIR_TAGLINE = 'discipline, context, and memory layer for agentic CLIs';

export interface BannerOptions {
  /** Terminal width in columns (defaults to process.stdout.columns, else 80). */
  width?: number;
  /** Apply the gradient. Default true. */
  color?: boolean;
}

/**
 * Render the Noir banner. Wide terminals (≥50 cols) get the full block
 * wordmark; narrow terminals get a compact `◆ noir` mark.
 *
 * Color gating (TIER A2): decoration is on only when the caller did not pass
 * `color:false` AND `useColor()` agrees (honoring NO_COLOR / CLICOLOR_FORCE /
 * TTY uniformly via the theme — the single color authority). Under
 * `NOIR_ACCESSIBLE` the gradient is replaced with a solid accent render
 * (maximum legibility); the wordmark stays recognizable either way.
 */
export function renderBanner(opts: BannerOptions = {}): string {
  const width = opts.width ?? process.stdout.columns ?? 80;
  const colorOn = opts.color !== false && useColor();
  if (width < 50) {
    return colorOn ? `${c.accent('◆')} noir` : '◆ noir';
  }
  const block = NOIR_BLOCK.join('\n');
  if (!colorOn) return block;
  // Accessible mode: skip the multi-stop gradient in favor of a single solid
  // accent color (still the Midnight Cobalt blue role, just without the
  // per-character hue drift that can be harder to read).
  if (accessibleMode()) {
    return block
      .split('\n')
      .map((line) => c.accent(line))
      .join('\n');
  }
  return NOIR_GRADIENT.multiline(block);
}

/**
 * Gate: skip the banner under `--quiet` / `--json` or `NOIR_NO_BANNER`. The TTY
 * / CI / NO_COLOR guards are already handled by `isInteractive` (the only path
 * that calls the banner is the interactive home arm); this adds the
 * banner-specific opt-outs a user can set even inside an interactive session.
 */
export function shouldShowBanner(opts: CliOptions): boolean {
  if (opts.quiet === true || opts.json === true) return false;
  const v = process.env.NOIR_NO_BANNER;
  if (v !== undefined && v !== '') return false;
  return true;
}
