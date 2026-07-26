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
import pc from 'picocolors';
import type { CliOptions } from './output.js';

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

// "noir" aesthetic — a cool, dark gradient (purple → blue → cyan) applied
// smoothly across the wordmark by gradient-string (vertical, top → bottom).
const NOIR_GRADIENT = gradient('#a855f7', '#3b82f6', '#06b6d4');

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
 * wordmark; narrow terminals get a compact `◆ noir` mark. `color:false` emits
 * pure text (zero ANSI) for snapshots / CI / NO_COLOR.
 */
export function renderBanner(opts: BannerOptions = {}): string {
  const width = opts.width ?? process.stdout.columns ?? 80;
  const color = opts.color ?? true;
  if (width < 50) {
    return color ? `${pc.magenta('◆')} noir` : '◆ noir';
  }
  const block = NOIR_BLOCK.join('\n');
  return color ? NOIR_GRADIENT.multiline(block) : block;
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
