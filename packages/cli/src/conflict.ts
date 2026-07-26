// SP-C — conflict-resolution UX seam. The engine (@noir-ai/create) is UI-free;
// this module builds the scaffold conflict options (policy + a lazy @clack
// resolver) per the S9 interactivity contract:
//   - TTY + interactive → @clack select menu (Replace/Rename/Duplicate/Keep/Cancel)
//   - non-TTY / CI / NO_COLOR → preserve (never silently clobber in a pipe)
//   - --force → overwrite (explicit re-scaffold; no prompt)
import type { ConflictContext, ConflictResolution } from '@noir-ai/create';
import { isInteractive } from './output.js';

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
  onConflict?: (ctx: ConflictContext) => Promise<ConflictResolution>;
};

/**
 * Build the scaffold conflict options for the current invocation. The engine
 * calls `onConflict` only when a `regenerate` file exists AND differs from the
 * template, so passing this on every init/create/sync is harmless on a first
 * run (no existing files → no conflict).
 *
 * B1: an explicit `interactive` flag (preferred) drives the prompt decision so
 * the CLI's choice is hermetic — the engine itself never reads `process.env`
 * for interactivity. The `NOIR_NON_INTERACTIVE` bridge + `isInteractive()`
 * TTY/CI/NO_COLOR gate remain as the fallback when `interactive` is unset (kept
 * so bin.ts's existing wiring stays intact).
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
  // B1: explicit interactive flag wins over the env/TTY heuristic.
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

async function clackConflictResolver(ctx: ConflictContext): Promise<ConflictResolution> {
  const clack = await import('@clack/prompts');
  const choice = await clack.select({
    message: `${ctx.relPath} was edited and differs from the Noir template.`,
    initialValue: 'preserve',
    options: [
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
      { value: 'cancel', label: 'Cancel' },
    ],
  });
  if (clack.isCancel(choice)) return 'cancel';
  return choice as ConflictResolution;
}
