// `noir create [dir]` — greenfield first-run for the AI layer only.
//
// Slice S — new command. Bootstraps Noir's AI layer (.noir/ store, host
// pointers, skills) into `dir` (created if absent), with NO external
// scaffolder chaining (S-OQ1 = AI-layer only; no `pnpm create` wrapping).
//
// Reuses init's transport/url handling (including the localhost security
// gate) by calling into the same engine: `scaffold({mode:'create', root})`.
// The only difference from `noir init` is the mode tag (which selects the
// manifest's first-run subset + generates a fresh project id unconditionally)
// and that the target dir is `resolve(dir ?? cwd)` rather than `process.cwd()`.
//
// S10 multi-host: gains `--host <id>` (default `'claude'`); the host drives
// both scaffold emission + skills emission via `resolveAdapter(host)` —
// shared with init through `emitHostSkills`. See `init.ts` for the matrix.
//
// Stream discipline matches init: diagnostics → stderr, nothing on stdout
// (so `noir create --json` is safe by construction — there is no data payload).
//
// Exit codes: `assertTransportUrl` is called DIRECTLY (M2) so transport/url
// errors propagate as plain `Error` → bin.ts's handleError → exit 1, EXACTLY
// matching `noir init` for the same error class. (The S9 spec lists usage=2 for
// a missing `--url`; neither `init` nor `create` implements that split today —
// both report it as a plain error=1 — and the review asked for consistency
// over a one-sided fix. Changing them together is a separate, contract-level
// change.) The target dir is created by the engine's `create` mode (N1: the
// duplicate mkdir that used to live here is gone — one attributable failure
// point, in scaffold.ts).

import { resolve } from 'node:path';
import { type HostId, resolveAdapter } from '@noir-ai/adapters';
import { loadProjectInfo, type ProjectInfo } from '@noir-ai/core';
import { type ScaffoldResult, scaffold } from '@noir-ai/create';
import { type CompileTarget, emitSkillsToDir } from '@noir-ai/skills';
import { buildConflictOpts } from '../conflict.js';
import { checkWritePathDedup } from '../dedup-write.js';
import { assertTransportUrl, reportPlannedWrites } from '../init.js';
import { resolveInteractive } from '../output.js';

export interface CreateOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
  /** S10 target host. Defaults to `'claude'`. */
  host?: HostId;
  /** SP-A: re-scaffold even if already initialized. */
  force?: boolean;
  /** F1: `--dry-run`/`--preview` — report the planned writes to stderr
   *  without touching disk (incl. NOT creating the target dir). */
  dryRun?: boolean;
  /** F1: alias for `--dry-run`. Kept on the options bag so direct callers can
   *  pass either spelling; the bin collapses both flags before dispatch. */
  preview?: boolean;
}

/**
 * Bootstrap Noir's AI layer in `dir`. Returns the {@link ScaffoldResult} (with
 * structured `conflicts[]` + any dedup records appended); the bin
 * emits it under `--json`. `undefined` when the already-initialized guard
 * short-circuited (a no-op).
 *
 * @param dir   Target directory (created if absent). Defaults to `process.cwd()`.
 * @param opts  Transport + URL + host (same semantics as `noir init`).
 */
export async function create(
  dir: string | undefined,
  opts: CreateOptions,
): Promise<ScaffoldResult | undefined> {
  // M2: call assertTransportUrl directly so the SAME error class yields the SAME
  // exit code as `noir init` (plain Error → exit 1 for both missing-url and
  // non-localhost). The previous NoirCliError(EXIT.USAGE) wrapper made `create`
  // exit 2 where `init` exits 1.
  assertTransportUrl(opts);

  const root = resolve(dir ?? process.cwd());
  const host: HostId = opts.host ?? 'claude';
  // Derive interactive once (consistency with init/sync) so both scaffold
  // and skills emission see the same hermetic flag.
  const interactive = resolveInteractive();
  const conflictOpts = buildConflictOpts({ force: opts.force, interactive });
  // F1: --dry-run/--preview collapse to a single dryRun boolean. The engine
  // skips the target-dir mkdir + every write; skills emission + dedup are
  // skipped too (they would touch disk / load the embedder).
  const dryRun = opts.dryRun === true || opts.preview === true;

  const res = await scaffold({
    root,
    mode: 'create',
    host,
    transport: opts.transport,
    interactive,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    ...(opts.force === true ? { force: true } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...conflictOpts,
  });
  // F1: dry-run reports the planned writes and stops BEFORE skills emission +
  // the "created" message — the target dir was NOT created, so nothing may
  // touch disk. (The engine's create-mode mkdir is gated on !dryRun.)
  if (dryRun) {
    reportPlannedWrites(res);
    return res;
  }
  // SP-A: a no-op (already-initialized guard) must not re-emit skills.
  if (res.noop) return res;

  // Skills are out-of-manifest by design — same composition as init.
  const adapter = resolveAdapter(host);
  const skillsDir = adapter.skillsDir?.({ root });
  if (skillsDir === undefined) {
    // N1: standardized wording — same phrase across init/sync/create so logs
    // grep uniformly. (Pre-N1 each command phrased this differently.)
    process.stderr.write(`host '${host}' has no skill emitter; skipping skills\n`);
  } else {
    const target: CompileTarget = host;
    // Forward conflictOpts so an interactive `noir create` with a
    // conflicting skill emit consults the resolver (mirrors init/sync).
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
      `Emitted ${summary.emitted.length} Noir skills to ${relDir}/ (target: ${target}).\n`,
    );
  }

  // Write-path semantic dedup. Greenfield create rarely has
  // existing host-context candidates (the target dir is fresh), so the fast
  // path fires; `--force` on a pre-existing Noir project reads the config and
  // runs the full dedup. Best-effort: a missing/corrupt config warn-skips.
  let projectInfo: ProjectInfo | undefined;
  try {
    projectInfo = loadProjectInfo(root);
  } catch {
    projectInfo = undefined;
  }
  const dedup = await checkWritePathDedup(root, res, { interactive, project: projectInfo });
  if (dedup.conflicts.length > 0) res.conflicts.push(...dedup.conflicts);

  process.stderr.write(`Noir created in ${root} (host: ${host}, transport: ${opts.transport}).\n`);
  process.stderr.write('Next: cd into the new directory, then run `noir` to open the home menu.\n');
  return res;
}
