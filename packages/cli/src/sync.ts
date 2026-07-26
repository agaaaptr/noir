// `noir sync` — re-emit the runtime subset of the scaffold manifest.
//
// Slice S-T2 refactor: delegates to `@noir-ai/create`'s `scaffold({mode:'sync'})`,
// which emits ONLY the regenerate + managedBlock entries (the always-safe-to-
// rewrite subset). Per the S-T2 contract notes, this ADOPTS THE ENGINE'S
// SEMANTICS and retires the predecessor's ad-hoc behavior:
//
//   - The engine re-emits `.mcp.json` (regenerate) + NOIR.md brief
//     (managedBlock) + CLAUDE.md context/rules blocks + ignore-file blocks.
//     The predecessor's sync re-emitted only CLAUDE.md blocks + ignores and
//     did NOT refresh `.mcp.json`/NOIR.md — the engine is a strict superset
//     here, so a transport/url change is now picked up by `noir sync`.
//   - The engine does NOT seed `.noir/rules/RULES.md` on sync (RULES.md is
//     skipIfExists, owned by init/create). The predecessor seeded it when
//     missing; init now owns all seeds. (Spec-aligned: "sync re-emits
//     generated/managed content; init owns seeds.")
//
// S10 multi-host: sync resolves the host from `.noir/config.yml` (persisted by
// `noir init --host <id>` via the config seed's `host: {{host}}` literal) OR
// from an explicit `--host <id>` override. The resolved adapter drives the
// manifest + skills emission. Skills emission stays a core sync feature for
// hosts with a `skillsDir` (claude → `.claude/skills/`; cursor → `.cursor/rules/`
// as `.mdc`); gemini/agents-md/opencode have no skill concept and the step is
// skipped. `scaffold({mode:'sync'})` throws when the project isn't initialized
// (no .noir/project.id), matching the predecessor's `loadProjectInfo` gate.

import { existsSync } from 'node:fs';
import { type HostId, resolveAdapter } from '@noir-ai/adapters';
import { loadProjectInfo, paths } from '@noir-ai/core';
import { type ScaffoldResult, scaffold } from '@noir-ai/create';
import { type CompileTarget, emitSkillsToDir } from '@noir-ai/skills';
import { buildConflictOpts } from './conflict.js';
import { checkWritePathDedup } from './dedup-write.js';
import { resolveInteractive } from './output.js';

export interface SyncOptions {
  /** S10 `--host <id>` override. When set, takes precedence over the
   *  `.noir/config.yml` `host:` field. Useful for re-emitting under a
   *  different host without re-init (advanced — the canonical host stays
   *  whatever init wrote). */
  host?: HostId;
  /** SP-C: overwrite differing regenerated files without prompting (bypasses
   *  the conflict menu). */
  force?: boolean;
  /** SP-D: three-way merge managed regions (preserve hand-edits inside
   *  `<!-- noir:* -->` markers across a template update). DEFAULT TRUE;
   *  `--merge` is now a no-op (kept for backward compatibility). */
  merge?: boolean;
  /** Opt OUT of managed-region merge (restore strip-replace). Exposed on
   *  the bin as `--no-merge-regions`. When explicitly `false`, hand-edits
   *  inside `<!-- noir:* -->` markers are discarded on a template upgrade. */
  mergeManagedRegions?: boolean;
}

export async function sync(root: string, opts: SyncOptions = {}): Promise<ScaffoldResult> {
  const host = resolveSyncHost(root, opts);
  // The engine reads ScaffoldOptions.interactive (hermetic — never
  // process.env). The CLI derives it once from the bridge + TTY/CI/NO_COLOR gate.
  const interactive = resolveInteractive();
  const conflictOpts = buildConflictOpts({ force: opts.force, interactive });

  // Load project info once for both the dedup hook (embedder config)
  // and the existing config-host fallback. Best-effort: a missing/corrupt file
  // is left to scaffold's "not initialized" gate below.
  let projectInfo: ReturnType<typeof loadProjectInfo> | undefined;
  try {
    projectInfo = loadProjectInfo(root);
  } catch {
    projectInfo = undefined;
  }

  const res = await scaffold({
    root,
    mode: 'sync',
    host,
    interactive,
    ...conflictOpts,
    // Merge defaults TRUE inside scaffold; only forward an explicit opt-out.
    ...(opts.mergeManagedRegions === false ? { mergeManagedRegions: false } : {}),
  });

  // Surface the no-op so users see sync was a true no-op on disk (the
  // scaffold wrote nothing — every runtime file was content-hash identical).
  // Skills emission below still runs (it has its own dedup).
  if (res.written.length === 0 && res.identical.length > 0) {
    process.stderr.write('Nothing to sync (Noir-managed files are up to date).\n');
  }

  const adapter = resolveAdapter(host);
  const skillsDir = adapter.skillsDir?.({ root });
  if (skillsDir === undefined) {
    // N1: standardized wording — same phrase across init/sync/create so logs
    // grep uniformly. (Pre-N1 sync phrased this as "nothing to sync".)
    process.stderr.write(`host '${host}' has no skill emitter; skipping skills\n`);
  } else {
    const target: CompileTarget = host;
    // Forward conflictOpts so the skills-emit conflict flow is
    // live in interactive mode (mirrors init.ts). --json/--no-input stays
    // prompt-free via the `interactive: false` guard.
    type SkillEmitOpts = NonNullable<Parameters<typeof emitSkillsToDir>[1]>;
    const skillOpts: SkillEmitOpts = {
      includeIntegrations: true,
      target,
      conflictPolicy: conflictOpts.conflictPolicy,
      interactive,
    };
    if (conflictOpts.onConflict !== undefined) {
      skillOpts.onConflict = conflictOpts.onConflict as SkillEmitOpts['onConflict'];
    }
    const summary = await emitSkillsToDir(skillsDir, skillOpts);
    const relDir = skillsDir.replace(`${root}/`, '');
    process.stderr.write(
      `Synced ${summary.emitted.length} Noir skills to ${relDir}/ (target: ${target}).\n`,
    );
    // Surface stale-dir pruning so a user can see when a previous Noir
    // version's builtin was removed (the dir was deleted from .claude/skills/).
    // Pure hygiene; never affects correctness of the freshly-emitted pack.
    const pruned = summary.pruned ?? [];
    if (pruned.length > 0) {
      process.stderr.write(
        `Pruned ${pruned.length} stale noir-* skill dir${pruned.length === 1 ? '' : 's'}: ${pruned.join(', ')}\n`,
      );
    }
  }

  // Write-path semantic dedup. Non-blocking; degrades to a
  // stderr warn-skip when the embedder is unavailable. Records near-dups on
  // `res.conflicts` so `--json` consumers see them without a prompt.
  const dedup = await checkWritePathDedup(root, res, { interactive, project: projectInfo });
  if (dedup.conflicts.length > 0) res.conflicts.push(...dedup.conflicts);

  return res;
}

/** Resolve the sync host: explicit `--host` override > `.noir/config.yml`
 *  `host:` field > `'claude'` (default — preserves the v1.1 regression anchor
 *  for projects initialized before S10). The config read is best-effort: if
 *  `.noir/config.yml` is absent OR fails to parse, scaffold's own
 *  "not initialized" gate (no `.noir/project.id`) fires below with the locked
 *  error string. */
function resolveSyncHost(root: string, opts: SyncOptions): HostId {
  if (opts.host !== undefined) return opts.host;
  if (!existsSync(paths.config(root))) return 'claude';
  try {
    return loadProjectInfo(root).config.host;
  } catch {
    return 'claude';
  }
}
