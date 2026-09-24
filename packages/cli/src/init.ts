// `noir init` — first-run + `--upgrade`.
//
// Refactor: the ad-hoc writers (syncIgnores, writeManagedRegion,
// writeFileSync for .mcp.json/project.id/config.yml/NOIR.md/RULES.md) are
// replaced by a single call into `@noir-ai/create`'s `scaffold({mode:'init'})`.
// The manifest + three-mode writer are the source of truth for what init
// emits; this module is now a thin caller that owns ONLY:
//   - the transport/url precondition (the localhost security gate, whose
//     error strings are locked by url-validation.test.ts), and
//   - skills emission (out-of-manifest by design — composed after scaffold()).
//
// Multi-host: the 8 direct `claudeAdapter` imports across init/sync/create
// collapsed to `resolveAdapter(host)` where `host` comes from `--host <id>`
// (default `'claude'`). The adapter drives (a) the manifest via
// `scaffold({host})` and (b) skills emission — claude/cursor have a skill dir;
// gemini/agents-md/opencode have no skill concept and the call is skipped.
//
// Deliberate behavior changes vs the predecessor (latent-bug fixes; see the
// CHANGELOG):
//   - `.noir/project.id` → skipIfExists (predecessor overwrote on every init,
//     orphaning the store DB named after the id). Re-init now preserves it.
//   - `.noir/config.yml` → skipIfExists (predecessor overwrote).
//   - `.noir/NOIR.md` → managedBlock with BRIEF_BLOCK markers (predecessor
//     wrote the whole file with no markers). First-run output GAINS markers;
//     user notes outside the markers survive re-runs.
//   - `.noir/scaffold-version` is now stamped on init/create (engine-owned).

import { existsSync } from 'node:fs';
import { type HostId, resolveAdapter } from '@noir-ai/adapters';
import { loadProjectInfo, type ProjectInfo, paths } from '@noir-ai/core';
import { type ScaffoldResult, scaffold } from '@noir-ai/create';
import {
  type CompileTarget,
  type EmitSummary,
  emitSkillsToDir,
  type SkillConflict,
} from '@noir-ai/skills';
import { buildConflictOpts, type ScaffoldConflictOpts } from './conflict.js';
import { checkWritePathDedup } from './dedup-write.js';
import { log, resolveInteractive } from './output.js';

export interface InitOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
  /** `noir init --upgrade`: run scaffold migrations from the on-disk
   *  scaffold-version to current, then re-emit every manifest mode except
   *  `mergeJson` — including `skipIfExists`, which creates only when the file is
   *  absent. That backfills seeds added to the manifest after this project was
   *  initialized without ever touching a user-owned file. */
  upgrade?: boolean;
  /** Target host. Resolution order: this explicit `--host <id>` value > the
   *  `host:` field of an existing `.noir/config.yml` > `'claude'` (the default,
   *  and the regression anchor for a project that has no config yet). Reading
   *  the configured host matters for `--upgrade`/`--force`, which re-emit into
   *  a project that already chose a host: emitting under the default instead
   *  would write a spurious claude surface and refresh none of the artifacts
   *  the project actually uses. An absent or unreadable config degrades to the
   *  default rather than failing the run.
   *  Drives both scaffold emission (the manifest's host-specific half) and
   *  skills emission (skipped for hosts with no `skillsDir`). */
  host?: HostId;
  /** Re-scaffold even if already initialized (bypasses the
   *  already-initialized no-op guard in scaffold()). */
  force?: boolean;
  /** `--dry-run`/`--preview` — report the planned writes to stderr
   *  (via {@link reportPlannedWrites}) without touching disk. The scaffold
   *  engine already supports this; the CLI just surfaces it. */
  dryRun?: boolean;
  /** Alias for `--dry-run`. Kept on the options bag so direct callers can
   *  pass either spelling; the bin collapses both flags before dispatch. */
  preview?: boolean;
}

/**
 * The {@link ScaffoldResult} plus the skill pack's own report. The scaffold's
 * `conflicts[]` covers the files the manifest owns; skills are emitted outside
 * the manifest, so their conflicts and their stale leftovers would otherwise
 * be invisible to a `--json` consumer.
 */
export interface InitResult extends ScaffoldResult {
  /** One record per skill file that existed AND differed from the compiled
   *  bytes, with the resolution that was applied — including the files a
   *  non-interactive run left alone. Always an array once skills emission has
   *  run; absent on the `--dry-run` and already-initialized paths, which stop
   *  before emission. */
  skillConflicts?: SkillConflict[];
  /** Names of the skills left with the user's own bytes because a differing
   *  file was preserved. Empty when every skill is current — the `--json`
   *  counterpart of the stderr line that warns about stale skills. */
  preservedSkills?: string[];
}

/**
 * Initialize Noir in `root`. Returns the {@link InitResult} (the
 * {@link ScaffoldResult} with structured `conflicts[]`, any dedup records, and
 * the skill pack's conflicts/stale names) so `--json` callers can surface
 * conflict detail. `undefined` when the already-initialized guard
 * short-circuited (a no-op).
 */
export async function init(root: string, opts: InitOptions): Promise<InitResult | undefined> {
  assertTransportUrl(opts);

  const host: HostId = resolveInitHost(root, opts);
  // The engine reads ScaffoldOptions.interactive (hermetic — never
  // process.env). The CLI derives it once from the bridge + TTY/CI/NO_COLOR gate.
  const interactive = resolveInteractive();
  const conflictOpts = buildConflictOpts({ force: opts.force, interactive });
  // --dry-run/--preview collapse to a single dryRun boolean. The engine
  // skips every write and returns the PLANNED lists; skills emission + dedup are
  // skipped too (they would touch disk / load the embedder).
  const dryRun = opts.dryRun === true || opts.preview === true;

  const res: InitResult = await scaffold({
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
  // dry-run reports the planned writes (result's written/skipped/identical)
  // and stops BEFORE skills emission + the "initialized" message — nothing was
  // written, so the host skill dir must stay untouched and we must not claim
  // init. Under --json the bin emits the planned list as the `{ok, data}`
  // envelope on stdout (the data channel) instead.
  if (dryRun) {
    reportPlannedWrites(res);
    return res;
  }
  // Report the permission heal BEFORE the already-initialized check. A bare
  // `noir init` on an existing project re-emits nothing, but it still
  // re-asserts the 0600 mode on `.noir/.env` — and a file fixed without a word
  // is exactly the silent drift this re-assert exists to end.
  reportEnvHeal(res);
  // If the already-initialized guard no-op'd scaffold, stop — don't re-emit
  // skills or print "initialized" (scaffold already printed the no-op message).
  if (res.noop) return res;

  // Thread the SAME conflictOpts into skills emission so the
  // skills-emit conflict flow is LIVE in interactive mode (the producer
  // accepts conflict opts; this closes the wiring gap). The safe-default
  // `assertNotUserOwned` runs unconditionally inside the producer.
  const skillSummary = await emitHostSkills(root, host, conflictOpts, interactive);
  // Skills live outside the manifest, so their report is folded onto the
  // scaffold result by hand. Both keys are always present once emission has
  // run (empty arrays when nothing conflicted) so a machine consumer can read
  // them without an existence check.
  res.skillConflicts = skillSummary?.conflicts ?? [];
  res.preservedSkills = skillSummary?.preserved ?? [];

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

  // Doc-only seeds an upgrade replaced because the user never edited them. Worth
  // a line of its own: the user's next `git diff` shows these files changing,
  // and the reason should already be on screen.
  if (res.refreshed.length > 0) {
    process.stderr.write(
      `Refreshed ${res.refreshed.length} unedited doc seed(s): ${res.refreshed.join(', ')}\n`,
    );
  }
  // Migration-transformed files (e.g. `.noir/config.yml` gaining the env
  // pointer) are surfaced on their own — distinct from `refreshed` (doc seeds),
  // because a migrated file is a config change the next `git diff` will show.
  if (res.migrationChanged.length > 0) {
    process.stderr.write(
      `Migrated ${res.migrationChanged.length} file(s): ${res.migrationChanged.join(', ')}\n`,
    );
  }
  process.stderr.write(
    `Noir initialized in ${root} (host: ${host}, transport: ${opts.transport}).\n`,
  );
  process.stderr.write(
    'Next: run `noir` to open the home menu (or `noir status` for a snapshot).\n',
  );
  return res;
}

/**
 * Resolve which host this run emits for: an explicit `--host <id>` > the
 * `host:` field of an existing `.noir/config.yml` > `'claude'`.
 *
 * A fresh project has no config, so the default is what a bare `noir init` has
 * always produced. A project that already chose a host must keep it when
 * re-emitting (`--upgrade`/`--force`); emitting under the default instead would
 * write artifacts for the wrong host and leave the ones the project actually
 * uses stale.
 *
 * The config read is best-effort — an absent, unreadable, or invalid config
 * must not fail the run, so each degrades to the default. Only the unreadable
 * case is reported, because that is the one where a host the user configured
 * cannot be determined. A config that parses but omits `host:` is not an error:
 * the schema supplies the default.
 */
function resolveInitHost(root: string, opts: InitOptions): HostId {
  if (opts.host !== undefined) return opts.host;
  if (!existsSync(paths.config(root))) return 'claude';
  try {
    return loadProjectInfo(root).config.host;
  } catch {
    // Also reached when the config is readable but the project id is missing or
    // invalid — either way the configured host is unknowable from here.
    process.stderr.write(
      `Could not read the configured host from ${paths.config(root)}; using 'claude'.\n`,
    );
    return 'claude';
  }
}

/**
 * Report a dry-run (--dry-run/--preview) scaffold result. After
 * `scaffold({dryRun:true})` the result's `written`/`skipped`/`identical`/
 * `refreshed` carry the PLANNED paths (nothing touched disk): `written` = files
 * that WOULD be written, `skipped` = skipIfExists files already present (left
 * alone), `identical` = files whose bytes would match the template (no
 * rewrite), `refreshed` = doc-only seeds an upgrade would replace because they
 * are still an unedited copy of an older version's text.
 * `conflicts` is always empty under dryRun (no writes → no conflicts).
 * `fileModes` carries the planned permission for entries that would CREATE at a
 * non-default mode — annotated onto the planned line (`… (mode 600)`).
 *
 * Emitted via the `log()` stderr helper — a HUMAN diagnostic, so under `--json`
 * the bin emits the planned list as the structured `{ok, data}` envelope on
 * stdout (the data channel) instead, matching the CLI stream discipline used by
 * the other init/create/sync diagnostics. Shared by init/create/sync (the same
 * dryRun surface on all three scaffold modes).
 */
export function reportPlannedWrites(res: ScaffoldResult): void {
  log('Dry run — no files were written.');
  if (res.written.length > 0) {
    log('Planned writes:');
    for (const p of res.written) {
      // A planned creation at a non-default mode is reported
      // here so `noir init --dry-run` shows the 0600 `.noir/.env` seed without
      // writing it. `fileModes` is absent/empty for every other entry.
      const mode = res.fileModes?.[p];
      log(mode === undefined ? `  ${p}` : `  ${p} (mode ${mode.toString(8).padStart(3, '0')})`);
    }
  }
  if (res.refreshed.length > 0) {
    // Doc-only seeds still carrying the text an older Noir shipped: an upgrade
    // replaces them because the user never edited them. Reported apart from the
    // planned writes so the preview does not read as "Noir will overwrite your
    // files".
    log('Would refresh (unedited older copy):');
    for (const p of res.refreshed) log(`  ${p}`);
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
 * Say that `.noir/.env` had its permissions tightened, once per run.
 *
 * The seed writer applies the file's 0600 mode only when it CREATES it, so the
 * scaffold re-asserts the mode on every run and records what it did on
 * `ScaffoldResult.envMode`. Only a real heal is worth a line — a file that was
 * already owner-only, or a platform with no POSIX mode bits, has nothing to
 * report, and the announcement must not repeat on runs that changed nothing.
 * Shared by every command whose run can find the file already there — `init`,
 * `sync` and `create` (whose `--force`/re-run over an existing tree reaches the
 * same file `init` would).
 */
export function reportEnvHeal(res: ScaffoldResult): void {
  if (res.envMode === 'healed') {
    process.stderr.write('Tightened .noir/.env to 0600 (it was readable by group or others).\n');
  }
}

/**
 * Compose skill emission onto the resolved adapter's `skillsDir` (claude →
 * `.claude/skills/`; cursor → `.cursor/rules/` compiled as `.mdc`; the other
 * three hosts have no skill concept and are skipped with a stderr note).
 *
 * The `CompileTarget` matches the host id (a later foundation widening made the
 * enum the same union) so cursor skills compile to the `.mdc` rule shape via
 * `compileSkill(_, 'cursor')`; the others keep the verbatim SKILL.md format.
 *
 * Returns the emit summary for the caller to carry into `--json`, or
 * `undefined` when the host has no skill emitter to report on.
 */
async function emitHostSkills(
  root: string,
  host: HostId,
  conflictOpts: ScaffoldConflictOpts,
  interactive: boolean,
): Promise<EmitSummary | undefined> {
  const adapter = resolveAdapter(host);
  const skillsDir = adapter.skillsDir?.({ root });
  if (skillsDir === undefined) {
    // Standardized wording — same phrase across init/sync/create so logs
    // grep uniformly. (Each command used to phrase this differently.)
    process.stderr.write(`host '${host}' has no skill emitter; skipping skills\n`);
    return undefined;
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
  // The count above is skills that are fully current. Anything left behind is
  // named on its own line: a run that kept stale files and reported only a
  // success count is how a CI upgrade silently stops refreshing skills.
  const stale = preservedStaleLine(summary.preserved ?? []);
  if (stale !== undefined) process.stderr.write(`${stale}\n`);
  return summary;
}

/**
 * The line that names the skills an emit left behind as stale, or undefined when
 * there are none. ONE wording across `init`, `sync`, `create` and `skills`, so
 * `preserved as stale` in a CI log greps to every command that emits the pack —
 * a run that kept stale files and reported only a success count is how an
 * upgrade silently stops refreshing skills.
 */
export function preservedStaleLine(preserved: readonly string[]): string | undefined {
  if (preserved.length === 0) return undefined;
  return `${preserved.length} skill(s) preserved as stale (interactive TTY required to refresh): ${preserved.join(', ')}`;
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
