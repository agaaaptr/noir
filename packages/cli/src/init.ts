// `noir init` — first-run + `--upgrade`.
//
// Slice S-T2 refactor: the ad-hoc writers (syncIgnores, writeManagedRegion,
// writeFileSync for .mcp.json/project.id/config.yml/NOIR.md/RULES.md) are
// replaced by a single call into `@noir-ai/create`'s `scaffold({mode:'init'})`.
// The manifest + three-mode writer are the source of truth for what init
// emits; this module is now a thin caller that owns ONLY:
//   - the transport/url precondition (the localhost security gate, whose
//     error strings are locked by url-validation.test.ts), and
//   - skills emission (out-of-manifest by design — composed after scaffold()).
//
// S10 multi-host: the 8 direct `claudeAdapter` imports across init/sync/create
// collapsed to `resolveAdapter(host)` where `host` comes from `--host <id>`
// (default `'claude'`). The adapter drives (a) the manifest via
// `scaffold({host})` and (b) skills emission — claude/cursor have a skill dir;
// gemini/agents-md/opencode have no skill concept and the call is skipped.
//
// Deliberate behavior changes vs the predecessor (spec-aligned latent-bug
// fixes; see S-T1 contract notes + CHANGELOG):
//   - `.noir/project.id` → skipIfExists (predecessor overwrote on every init,
//     orphaning the store DB named after the id). Re-init now preserves it.
//   - `.noir/config.yml` → skipIfExists (predecessor overwrote).
//   - `.noir/NOIR.md` → managedBlock with BRIEF_BLOCK markers (predecessor
//     wrote the whole file with no markers). First-run output GAINS markers;
//     user notes outside the markers survive re-runs.
//   - `.noir/scaffold-version` is now stamped on init/create (engine-owned).

import { type HostId, resolveAdapter } from '@noir-ai/adapters';
import { loadProjectInfo, type ProjectInfo } from '@noir-ai/core';
import { type ScaffoldResult, scaffold } from '@noir-ai/create';
import { type CompileTarget, emitSkillsToDir } from '@noir-ai/skills';
import { buildConflictOpts, type ScaffoldConflictOpts } from './conflict.js';
import { checkWritePathDedup } from './dedup-write.js';
import { log, resolveInteractive } from './output.js';

export interface InitOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
  /** `noir init --upgrade`: run scaffold migrations from the on-disk
   *  scaffold-version to current, then re-emit ONLY the runtime subset
   *  (regenerate + managedBlock). skipIfExists seeds are left alone so user
   *  edits survive. */
  upgrade?: boolean;
  /** S10 target host. Defaults to `'claude'` (the regression anchor). Drives
   *  both scaffold emission (the manifest's host-specific half) and skills
   *  emission (skipped for hosts with no `skillsDir`). */
  host?: HostId;
  /** SP-A: re-scaffold even if already initialized (bypasses the
   *  already-initialized no-op guard in scaffold()). */
  force?: boolean;
  /** F1: `--dry-run`/`--preview` — report the planned writes to stderr
   *  (via {@link reportPlannedWrites}) without touching disk. The scaffold
   *  engine already supports this; the CLI just surfaces it. */
  dryRun?: boolean;
  /** F1: alias for `--dry-run`. Kept on the options bag so direct callers can
   *  pass either spelling; the bin collapses both flags before dispatch. */
  preview?: boolean;
}

/**
 * Initialize Noir in `root`. Returns the {@link ScaffoldResult} (with
 * structured `conflicts[]` + any dedup records appended) so `--json`
 * callers can surface conflict detail. `undefined` when the already-initialized
 * guard short-circuited (a no-op).
 */
export async function init(root: string, opts: InitOptions): Promise<ScaffoldResult | undefined> {
  assertTransportUrl(opts);

  const host: HostId = opts.host ?? 'claude';
  // The engine reads ScaffoldOptions.interactive (hermetic — never
  // process.env). The CLI derives it once from the bridge + TTY/CI/NO_COLOR gate.
  const interactive = resolveInteractive();
  const conflictOpts = buildConflictOpts({ force: opts.force, interactive });
  // F1: --dry-run/--preview collapse to a single dryRun boolean. The engine
  // skips every write and returns the PLANNED lists; skills emission + dedup are
  // skipped too (they would touch disk / load the embedder).
  const dryRun = opts.dryRun === true || opts.preview === true;

  const res = await scaffold({
    root,
    mode: 'init',
    host,
    transport: opts.transport,
    interactive,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    ...(opts.upgrade === true ? { upgrade: true } : {}),
    ...(opts.force === true ? { force: true } : {}),
    ...(dryRun ? { dryRun: true } : {}),
    ...conflictOpts,
  });
  // F1: dry-run reports the planned writes (result's written/skipped/identical)
  // and stops BEFORE skills emission + the "initialized" message — nothing was
  // written, so the host skill dir must stay untouched and we must not claim
  // init. Under --json the bin emits the planned list as the `{ok, data}`
  // envelope on stdout (the data channel) instead.
  if (dryRun) {
    reportPlannedWrites(res);
    return res;
  }
  // SP-A: if the already-initialized guard no-op'd scaffold, stop — don't re-emit
  // skills or print "initialized" (scaffold already printed the no-op message).
  if (res.noop) return res;

  // Thread the SAME conflictOpts into skills emission so the
  // skills-emit conflict flow is LIVE in interactive mode (the producer
  // accepts conflict opts; this closes the wiring gap). The safe-default
  // `assertNotUserOwned` runs unconditionally inside the producer.
  await emitHostSkills(root, host, conflictOpts, interactive);

  // Write-path semantic dedup. Non-blocking; degrades to a
  // stderr warn-skip when the embedder is unavailable. Records near-dups on
  // `res.conflicts` so `--json` consumers see them without a prompt.
  // Best-effort project read: first-run init has no .noir/config.yml yet →
  // undefined → resolveEmbedder warn-skips. `init --force` on an existing
  // project reads the config and runs the dedup against existing host files.
  let projectInfo: ProjectInfo | undefined;
  try {
    projectInfo = loadProjectInfo(root);
  } catch {
    projectInfo = undefined;
  }
  const dedup = await checkWritePathDedup(root, res, { interactive, project: projectInfo });
  if (dedup.conflicts.length > 0) res.conflicts.push(...dedup.conflicts);

  process.stderr.write(
    `Noir initialized in ${root} (host: ${host}, transport: ${opts.transport}).\n`,
  );
  process.stderr.write(
    'Next: run `noir` to open the home menu (or `noir status` for a snapshot).\n',
  );
  return res;
}

/**
 * F1 — report a dry-run (--dry-run/--preview) scaffold result. After
 * `scaffold({dryRun:true})` the result's `written`/`skipped`/`identical` carry
 * the PLANNED paths (nothing touched disk): `written` = files that WOULD be
 * written, `skipped` = skipIfExists files already present (left alone),
 * `identical` = files whose bytes would match the template (no rewrite).
 * `conflicts` is always empty under dryRun (no writes → no conflicts).
 *
 * Emitted via the `log()` stderr helper — a HUMAN diagnostic, so under `--json`
 * the bin emits the planned list as the structured `{ok, data}` envelope on
 * stdout (the data channel) instead, matching the S9 stream discipline used by
 * the other init/create/sync diagnostics. Shared by init/create/sync (the same
 * dryRun surface on all three scaffold modes).
 */
export function reportPlannedWrites(res: ScaffoldResult): void {
  log('Dry run — no files were written.');
  if (res.written.length > 0) {
    log('Planned writes:');
    for (const p of res.written) log(`  ${p}`);
  }
  if (res.skipped.length > 0) {
    log('Would leave as-is (already present):');
    for (const p of res.skipped) log(`  ${p}`);
  }
  if (res.identical.length > 0) {
    log('Would rewrite (byte-identical, no-op):');
    for (const p of res.identical) log(`  ${p}`);
  }
}

/**
 * Compose skill emission onto the resolved adapter's `skillsDir` (claude →
 * `.claude/skills/`; cursor → `.cursor/rules/` compiled as `.mdc`; the other
 * three hosts have no skill concept and are skipped with a stderr note).
 *
 * The `CompileTarget` matches the host id (S10 foundation widened the enum to
 * the same union) so cursor skills compile to the `.mdc` rule shape via
 * `compileSkill(_, 'cursor')`; the others keep the verbatim SKILL.md format.
 */
async function emitHostSkills(
  root: string,
  host: HostId,
  conflictOpts: ScaffoldConflictOpts,
  interactive: boolean,
): Promise<void> {
  const adapter = resolveAdapter(host);
  const skillsDir = adapter.skillsDir?.({ root });
  if (skillsDir === undefined) {
    // N1: standardized wording — same phrase across init/sync/create so logs
    // grep uniformly. (Pre-N1 each command phrased this differently.)
    process.stderr.write(`host '${host}' has no skill emitter; skipping skills\n`);
    return;
  }
  const target: CompileTarget = host;
  // Forward conflictPolicy + onConflict + interactive so an
  // interactive `noir init` with a conflicting skill emit consults the
  // resolver (clack menu + diff preview + apply-to-all); --json/--no-input
  // stays prompt-free via the `interactive: false` guard. The resolver shape
  // is structurally compatible with the skill emit seam (see skills/types.ts);
  // the cast isolates the literal-narrowing mismatch on the return type.
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

/**
 * Transport + URL precondition. The error strings here are the SECURITY GATE
 * locked by `url-validation.test.ts` — do not rephrase. Thrown errors are
 * plain `Error`s (bin.ts's `main().catch` maps them to stderr + exitCode 1).
 *
 * Exported so `noir create` (commands/create.ts) reuses the SAME gate instead
 * of duplicating the localhost allowlist.
 */
export function assertTransportUrl(opts: {
  transport: 'stdio' | 'streamable-http';
  url?: string;
}): void {
  if (opts.transport === 'streamable-http' && opts.url === undefined) {
    throw new Error('--transport streamable-http requires --url');
  }
  if (opts.url !== undefined) {
    assertLocalhostUrl(opts.url);
  }
}

// Validate a streamable-http --url is http(s) and localhost-only. Gate 2's
// daemon binds 127.0.0.1, so persisting a non-localhost URL is a footgun.
// Not exported: the single external surface is assertTransportUrl(); thrown
// errors propagate to bin.ts's main().catch (stderr + exitCode 1).
function assertLocalhostUrl(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error(`Only localhost URLs are supported (got ${url.hostname})`);
  }
}
