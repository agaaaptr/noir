import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type HostId, resolveAdapter } from '@noir-ai/adapters';
import { resolveNoirCommand } from '@noir-ai/core';
import { mergeJson, regenerate } from './writers.js';

/**
 * Emit a host's lifecycle-hook config on demand: the write-once `mergeJson`
 * hook the scaffold deliberately does NOT re-emit on `noir init --upgrade` or
 * `noir sync`. This is the explicit restore path (`noir hooks sync`): it runs
 * the same `adapter.emitHooks` seam the scaffold uses and dispatches each entry
 * to the writer its mode names (`regenerate` for cursor, `mergeJson` for
 * claude/gemini). With `force`, an existing Noir-owned hook entry (one whose
 * command carries the dedup marker) is refreshed to the currently resolved
 * command instead of being left as-is; the user's other keys and non-Noir hooks
 * are never touched.
 *
 * Pure filesystem work: no daemon, no store, no prompt. A host with no hook
 * surface (agents-md, opencode) returns an empty outcome list.
 */

/** One host hook-config write performed by {@link emitHooksToFile}. */
export interface HookEmitOutcome {
  /** Repo-relative path of the host's hook config file. */
  path: string;
  /** `mergeJson` = merged into a user-owned file; `regenerate` = rewritten. */
  mode: 'mergeJson' | 'regenerate';
  /** True when the bytes on disk changed (a write happened). */
  written: boolean;
}

export interface EmitHooksResult {
  host: HostId;
  outcomes: HookEmitOutcome[];
}

export function emitHooksToFile(
  root: string,
  host: HostId,
  opts?: { force?: boolean },
): EmitHooksResult {
  const adapter = resolveAdapter(host);
  const emissions = adapter.emitHooks?.({ command: resolveNoirCommand() }) ?? null;
  if (emissions === null) return { host, outcomes: [] };

  const outcomes: HookEmitOutcome[] = emissions.map((e) => {
    const abs = join(root, e.path);
    // The writers create a temp sibling in the target's directory and rename it
    // in; the directory must exist first (mirrors the scaffold's mkdir -p).
    mkdirSync(dirname(abs), { recursive: true });
    if (e.mode === 'regenerate') {
      const content = `${JSON.stringify(e.content, null, 2)}\n`;
      // `regenerate` always rewrites; skip a byte-identical file so `written`
      // stays honest and a repeat run is a true no-op (the scaffold tracks this
      // as "identical" at the orchestrator level, which this path bypasses).
      if (existsSync(abs) && readFileSync(abs, 'utf8') === content) {
        return { path: e.path, mode: 'regenerate', written: false };
      }
      const out = regenerate(abs, content);
      return { path: e.path, mode: 'regenerate', written: out.written };
    }
    const out = mergeJson(abs, e.content, e.dedupSubstring, opts?.force === true);
    return { path: e.path, mode: 'mergeJson', written: out.written };
  });

  return { host, outcomes };
}
