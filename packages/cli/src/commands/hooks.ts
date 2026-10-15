// `noir hooks sync`.
//
// IN-PROCESS (no daemon, no store): the host hook entry is a filesystem
// artifact (claude `.claude/settings.local.json`, gemini `.gemini/settings.json`,
// cursor `.cursor/hooks.json`), so the write runs directly through
// `@noir-ai/create`'s `emitHooksToFile` — the same primitive the scaffold uses.
// This is the explicit restore path for the write-once `mergeJson` hook that
// `noir init --upgrade` and `noir sync` deliberately do NOT re-emit.
//
// Scriptability (hard rule): `--json` emits the `{ok,data}` envelope to stdout
// (the only stdout write); the human messages go to stderr via `log`/`info`.
// No interactive input is ever required — safe on a pipe / CI unconditionally.

import { loadProjectInfo, type ProjectInfo } from '@noir-ai/core';
import { emitHooksToFile } from '@noir-ai/create';
import { type CliOptions, EXIT, fail, info, log } from '../output.js';

/** Options accepted by `noir hooks sync` (the global flags + `--force`). */
export interface HooksOptions extends CliOptions {
  /** Rewrite the existing Noir hook entry to the current command (rather than
   *  only adding a missing one). The user's own non-Noir hooks are preserved. */
  force?: boolean;
}

/**
 * `noir hooks sync`: re-emit the project's host lifecycle-hook entry. A missing
 * hook is restored; an already-present one is a no-op unless `--force` refreshes
 * it to the currently resolved command. The host is read from `.noir/config.yml`
 * (the same source `noir sync` uses), and a host with no hook surface reports
 * nothing to sync and exits 0.
 *
 * Requires the project to be initialized (`loadProjectInfo` throws otherwise →
 * exit 1 with the "Run `noir init` first" hint).
 */
export async function hooksSync(opts: HooksOptions): Promise<void> {
  const root = process.cwd();
  let project: ProjectInfo;
  try {
    project = loadProjectInfo(root);
  } catch {
    fail(EXIT.ERROR, 'Noir is not initialized in this directory. Run `noir init` first.', opts);
  }

  const result = emitHooksToFile(root, project.config.host, {
    ...(opts.force === true ? { force: true } : {}),
  });

  if (result.outcomes.length === 0) {
    const data = { host: project.config.host, outcomes: [], reason: 'no-hook-emitter' };
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
      return;
    }
    info('This host has no hook surface; nothing to sync.', opts);
    return;
  }

  const data = { host: project.config.host, outcomes: result.outcomes };
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }

  for (const o of result.outcomes) {
    if (!o.written) {
      info(`${o.path}: Noir hook already present.`, opts);
    } else if (o.mode === 'regenerate') {
      log(`${o.path}: rewrote the Noir hook entry.`, opts);
    } else if (opts.force === true) {
      log(`${o.path}: refreshed the Noir hook entry.`, opts);
    } else {
      log(`${o.path}: re-installed the Noir hook entry.`, opts);
    }
  }
}
