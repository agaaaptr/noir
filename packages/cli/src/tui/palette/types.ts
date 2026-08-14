// A1 — the palette command shape.
//
// A {@link PaletteCommand} is a PRESENTATION-layer projection of a leaf
// `noir` subcommand: enough for the TUI command palette to filter, rank, and
// dispatch by argv without re-walking the commander tree. The registry
// (`../commands/registry.ts`) derives one entry per leaf command; this module
// owns only the contract those entries must satisfy.
//
// `argv` is the canonical identifier — the exact space-joined token sequence a
// user would type (e.g. `['context', 'search']`), with the program root name
// ('noir') never included. `destructive` is a derived read flag (mutation /
// workflow-advancing commands) so the palette can gate confirmation prompts
// without re-deriving the prefix table at render time.

/**
 * A palette entry projecting a leaf `noir` subcommand for the TUI palette.
 */
export interface PaletteCommand {
  /** Space-joined argv — the stable dispatch key (e.g. `context search`). */
  readonly id: string;
  /** Title-cased argv joined by `: ` for the palette's human label. */
  readonly label: string;
  /**
   * The raw token path, root name excluded. This is what the palette re-dispatches
   * (it is NOT a live reference to commander's parsed argv).
   */
  readonly argv: readonly string[];
  /** One-line summary; falls back to `argv.join(' ')` when the command omits one. */
  readonly description: string;
  /** Top-level group the command belongs to (`argv[0]`), for palette grouping. */
  readonly category: string;
  /** Search keywords — extra tokens the palette matcher scores beyond the label. */
  readonly keywords: readonly string[];
  /**
   * True for commands that mutate the store / workflow / host artifacts (context
   * index/forget, memory save/forget/consolidate, task new/advance, skills sync,
   * daemon start/stop/restart, init, create, sync, install, update). The palette
   * uses this to require confirmation before dispatch.
   */
  readonly destructive: boolean;
}
