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
import { resolveInteractive } from './output.js';

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
}

/**
 * Initialize Noir in `root`. Returns the {@link ScaffoldResult} (with B2's
 * structured `conflicts[]` + any TIER B3 dedup records appended) so `--json`
 * callers can surface conflict detail. `undefined` when the already-initialized
 * guard short-circuited (a no-op).
 */
export async function init(root: string, opts: InitOptions): Promise<ScaffoldResult | undefined> {
  assertTransportUrl(opts);

  const host: HostId = opts.host ?? 'claude';
  // B1: the engine reads ScaffoldOptions.interactive (hermetic — never
  // process.env). The CLI derives it once from the bridge + TTY/CI/NO_COLOR gate.
  const interactive = resolveInteractive();
  const conflictOpts = buildConflictOpts({ force: opts.force, interactive });

  const res = await scaffold({
    root,
    mode: 'init',
    host,
    transport: opts.transport,
    interactive,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    ...(opts.upgrade === true ? { upgrade: true } : {}),
    ...(opts.force === true ? { force: true } : {}),
    ...conflictOpts,
  });
  // SP-A: if the already-initialized guard no-op'd scaffold, stop — don't re-emit
  // skills or print "initialized" (scaffold already printed the no-op message).
  if (res.noop) return res;

  // TIER B3 TASK 1 — thread the SAME conflictOpts into skills emission so the
  // skills-emit conflict flow is LIVE in interactive mode (B2 made the producer
  // ACCEPT conflict opts; this closes the wiring gap). The safe-default
  // `assertNotUserOwned` runs unconditionally inside the producer.
  await emitHostSkills(root, host, conflictOpts, interactive);

  // TIER B3 TASK 2 — write-path semantic dedup. Non-blocking; degrades to a
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
  // B3 TASK 1 — forward conflictPolicy + onConflict + interactive so an
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
