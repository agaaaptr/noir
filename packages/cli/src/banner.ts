// SP-B — Noir banner.
//
// Pre-rendered ASCII wordmark ("noir" in a chunky block font, generated OFFLINE
// so startup pays zero font-engine cost) with a faux gradient via picocolors.
// Guardrails: the ONLY caller is the interactive home arm (so CI / non-TTY /
// NO_COLOR / --json / --no-input never reach it — `isInteractive` gates that);
// `shouldShowBanner` additionally skips under `--quiet` and `NOIR_NO_BANNER`.
// No animation by default (accessibility — animations are opt-in later).
import pc from 'picocolors';
import type { CliOptions } from './output.js';

// "noir" in an ANSI-Shadow-style block face. Pre-rendered (not figlet at
// runtime) so output is deterministic + startup is free. Unicode block glyphs
// degrade to a readable wordmark even when ANSI color is stripped.
const NOIR_BLOCK = [
  '███╗   ██╗ ██████╗ ██╗  ██╗ █████╗ ',
  '████╗  ██║██╔═══██╗██║  ██║██╔══██╗',
  '██╔██╗ ██║██║   ██║███████║███████║',
  '██║╚██╗██║██║   ██║██╔══██║██╔══██║',
  '██║ ╚████║╚██████╔╝██║  ██║██║  ██║',
  '╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝',
];

// Faux gradient (magenta → blue → cyan) using only picocolors' built-in shades
// (no gradient-string dep). Row-by-row so the wordmark reads top→bottom as a
// cooling gradient — the "noir" aesthetic.
const ROW_COLORS = [pc.magenta, pc.magentaBright, pc.blue, pc.blueBright, pc.cyan, pc.cyanBright];

/** One-line product tagline (shown under the wordmark). */
export const NOIR_TAGLINE = 'discipline, context, and memory layer for agentic CLIs';

export interface BannerOptions {
  /** Terminal width in columns (defaults to process.stdout.columns, else 80). */
  width?: number;
  /** Apply the picocolors faux-gradient. Default true. */
  color?: boolean;
}

/**
 * Render the Noir banner. Wide terminals (≥50 cols) get the full block
 * wordmark; narrow terminals get a compact `◆ noir` mark. `color:false` emits
 * pure text (zero ANSI) for snapshots / CI / NO_COLOR — picocolors itself also
 * auto-strips under NO_COLOR, but the explicit flag keeps this deterministic
 * for tests.
 */
export function renderBanner(opts: BannerOptions = {}): string {
  const width = opts.width ?? process.stdout.columns ?? 80;
  const color = opts.color ?? true;
  if (width < 50) {
    return color ? `${pc.magenta('◆')} noir` : '◆ noir';
  }
  return NOIR_BLOCK.map((line, i) => (color ? (ROW_COLORS[i] ?? pc.cyan)(line) : line)).join('\n');
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
