// SP-C — conflict-resolution UX seam. The engine (@noir-ai/create) is UI-free;
// this module builds the scaffold conflict options (policy + a lazy @clack
// resolver) per the S9 interactivity contract:
//   - TTY + interactive → @clack select menu (Replace/Rename/Duplicate/Keep/Cancel,
//     plus a 6th "merge (with conflict markers)" when `mergedWithMarkers` is set)
//   - non-TTY / CI / NO_COLOR → preserve (never silently clobber in a pipe)
//   - --force → overwrite (explicit re-scaffold; no prompt)
//
// Universal contract: this seam now drives EVERY file-producing path. The
// engine's regenerate path consults `onConflict` (apply-to-all keyed by artifact
// CLASS so an N-pointer `noir init --upgrade` → 1 prompt); managedBlock conflicts
// stay PER-FILE. A unified line-diff preview (LCS-based, from
// @noir-ai/create's `lineDiff`) renders to STDERR before the prompt (via the
// A2 theme — `+` green / `-` red / context dim), so `--json`/piped stdout stays
// pristine. The 6th "merge" option writes the engine-provided zdiff3-marked
// bytes when a 3-way merge hit an overlap.
import type { ConflictContext, ConflictResolution, ConflictResolverReturn } from '@noir-ai/create';
import { isInteractive } from './output.js';
import { c } from './theme.js';

export interface ConflictOptsInput {
  /** `--force`: explicit re-scaffold — overwrite differing files, no prompt. */
  force?: boolean;
  /** B1: explicit interactivity signal. When set, wins over the env/TTY
   *  heuristic. `false` ⇒ preserve (never prompt); `true` ⇒ allow the @clack
   *  resolver. The CLI derives this from the `NOIR_NON_INTERACTIVE` bridge
   *  bin.ts owns + the `isInteractive()` TTY/CI/NO_COLOR gate. */
  interactive?: boolean;
}

export type ScaffoldConflictOpts = {
  conflictPolicy: 'overwrite' | 'preserve';
  onConflict?: (ctx: ConflictContext) => Promise<ConflictResolverReturn> | ConflictResolverReturn;
};

/**
 * Build the scaffold conflict options for the current invocation. The engine
 * calls `onConflict` only when a `regenerate` file exists AND differs from the
 * template, so passing this on every init/create/sync is harmless on a first
 * run (no existing files → no conflict).
 *
 * B1 + SP-G: the `interactive` flag (explicit > env bridge > TTY/CI/NO_COLOR
 * gate) drives the prompt decision so the engine never reads `process.env` for
 * interactivity. The `NOIR_NON_INTERACTIVE` bridge (--json/--no-input) and the
 * `isInteractive()` gate both reduce to `preserve` (never prompt).
 *
 * B2 apply-to-all: when the resolver returns `{resolution, applyToAll: true}`
 * the engine stores the choice in its per-run memory keyed by artifact CLASS
 * (regenerate shares one decision; managedBlock/managedBlocks stay per-file).
 */
/** True when the bin's preAction hook flagged this invocation non-interactive
 *  (`--json` / `--no-input`) so the conflict resolver never prompts under those. */
function flaggedNonInteractive(): boolean {
  const v = process.env.NOIR_NON_INTERACTIVE;
  return v !== undefined && v !== '';
}

export function buildConflictOpts(input: ConflictOptsInput = {}): ScaffoldConflictOpts {
  if (input.force === true) {
    return { conflictPolicy: 'overwrite' };
  }
  // Explicit interactive flag wins over the env/TTY heuristic.
  if (input.interactive === false) {
    return { conflictPolicy: 'preserve' };
  }
  if (input.interactive === true) {
    return { conflictPolicy: 'preserve', onConflict: clackConflictResolver };
  }
  // Fallback: NOIR_NON_INTERACTIVE bridge (--json/--no-input) OR the
  // isInteractive() TTY/CI/NO_COLOR gate — either ⇒ preserve, never prompt.
  if (flaggedNonInteractive() || !isInteractive()) {
    return { conflictPolicy: 'preserve' };
  }
  return { conflictPolicy: 'preserve', onConflict: clackConflictResolver };
}

/**
 * B2 — render a colored unified line-diff of `{existing, proposed}` to STDERR
 * before the @clack prompt. Stderr (not stdout) so `--json` / piped stdout
 * stays pristine. The A2 theme colors `+` lines green (`c.ok`), `-` lines red
 * (`c.error`), and dims context lines (`c.dim`); all color is gated through
 * `useColor()` so NO_COLOR / non-TTY / CLICOLOR_FORCE behave consistently.
 * Honored by `theme.test.ts`'s NO_COLOR gate.
 */
function renderDiffPreview(ctx: ConflictContext): void {
  // Lazy-import the engine's line diff so this module stays import-side-effect
  // free for callers that never hit a conflict.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { lineDiff: ld } = require('@noir-ai/create') as typeof import('@noir-ai/create');
  const lines = ld(ctx.existing, ctx.proposed);
  if (lines.length === 0) return;
  const out: string[] = [`noir: conflict in ${ctx.relPath}`];
  for (const dl of lines) {
    if (dl.type === 'add') out.push(c.ok(`+ ${dl.line}`));
    else if (dl.type === 'del') out.push(c.error(`- ${dl.line}`));
    else out.push(c.dim(`  ${dl.line}`));
  }
  process.stderr.write(`${out.join('\n')}\n`);
}

/**
 * SP-C + B2 — @clack-based conflict resolver. Renders a unified diff to stderr
 * (via {@link renderDiffPreview}) BEFORE the select prompt, then offers the
 * usual Replace/Rename/Duplicate/Keep/Cancel set PLUS a 6th "merge (with
 * conflict markers)" option when `ctx.mergedWithMarkers` is set (a 3-way merge
 * hit an overlap and the engine has the marked bytes ready).
 *
 * Apply-to-all: when the user picks an option, @clack asks whether to reuse the
 * choice for the rest of the run; if yes, the resolver returns the rich
 * `{resolution, applyToAll: true}` shape and the engine stores it in per-class
 * memory. `managedBlock`/`managedBlocks` modes bypass apply-to-all (per-file).
 */
async function clackConflictResolver(ctx: ConflictContext): Promise<ConflictResolverReturn> {
  renderDiffPreview(ctx);
  const clack = await import('@clack/prompts');
  const options: Array<{ value: ConflictResolution; label: string; hint: string }> = [
    {
      value: 'replace',
      label: 'Replace',
      hint: 'overwrite with the template (discard your edits)',
    },
    { value: 'rename', label: 'Rename', hint: 'keep yours as <file>.local; write the template' },
    {
      value: 'duplicate',
      label: 'Create duplicate',
      hint: 'write template to <file>.noir; keep yours',
    },
    { value: 'preserve', label: 'Keep mine', hint: 'skip; leave your file unchanged' },
    { value: 'cancel', label: 'Cancel', hint: 'abort the scaffold' },
  ];
  // 6th "merge" option only when the engine has marked bytes ready.
  if (ctx.mergedWithMarkers !== undefined) {
    options.splice(4, 0, {
      value: 'merge',
      label: 'Merge (with conflict markers)',
      hint: 'write the 3-way merge with <<<<<<< / ||||||| / ======= / >>>>>>> markers',
    });
  }
  const choice = await clack.select({
    message: `${ctx.relPath} was edited and differs from the Noir template.`,
    initialValue: 'preserve',
    options,
  });
  if (clack.isCancel(choice)) return 'cancel';
  const resolution = choice as ConflictResolution;
  // Apply-to-all. Only meaningful for `regenerate` (one decision
  // shared across the run); managedBlock/managedBlocks stay per-file (the
  // engine keys memory by path::block there, not by class — so even if the
  // user picks "all", the engine won't reuse it across files).
  const mode = ctx.mode ?? 'regenerate';
  if (mode === 'regenerate') {
    const remember = await clack.select({
      message: `Apply "${labelFor(resolution)}" to all remaining conflicts this run?`,
      initialValue: 'no',
      options: [
        { value: 'yes', label: 'Yes', hint: 'reuse this choice for the rest of this run' },
        { value: 'no', label: 'No', hint: 'prompt again for each conflict' },
      ],
    });
    if (!clack.isCancel(remember) && remember === 'yes') {
      return { resolution, applyToAll: true };
    }
  }
  return resolution;
}

function labelFor(resolution: ConflictResolution): string {
  switch (resolution) {
    case 'replace':
      return 'Replace';
    case 'rename':
      return 'Rename';
    case 'duplicate':
      return 'Create duplicate';
    case 'preserve':
      return 'Keep mine';
    case 'merge':
      return 'Merge (with conflict markers)';
    case 'cancel':
      return 'Cancel';
  }
}
