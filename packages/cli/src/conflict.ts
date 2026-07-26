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
 * NOTE: interactivity is decided via `isInteractive()` (TTY + CI + NO_COLOR).
 * `--no-input`/`--json` are global flags the init/create/sync modules don't
 * currently receive; closing that edge (so `noir sync --no-input` in a TTY
 * never prompts) is a documented follow-up — the common CI/pipe case is already
 * correct because non-TTY ⇒ preserve.
 */
export function buildConflictOpts(input: ConflictOptsInput = {}): ScaffoldConflictOpts {
  if (input.force === true) {
    return { conflictPolicy: 'overwrite' };
  }
  if (!isInteractive()) {
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
