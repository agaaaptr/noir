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
import { scaffold } from '@noir-ai/create';
import { type CompileTarget, emitSkillsToDir } from '@noir-ai/skills';

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
}

export async function init(root: string, opts: InitOptions): Promise<void> {
  assertTransportUrl(opts);

  const host: HostId = opts.host ?? 'claude';

  await scaffold({
    root,
    mode: 'init',
    host,
    transport: opts.transport,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    ...(opts.upgrade === true ? { upgrade: true } : {}),
  });

  await emitHostSkills(root, host);

  process.stderr.write(
    `Noir initialized in ${root} (host: ${host}, transport: ${opts.transport}).\n`,
  );
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
async function emitHostSkills(root: string, host: HostId): Promise<void> {
  const adapter = resolveAdapter(host);
  const skillsDir = adapter.skillsDir?.({ root });
  if (skillsDir === undefined) {
    // N1: standardized wording — same phrase across init/sync/create so logs
    // grep uniformly. (Pre-N1 each command phrased this differently.)
    process.stderr.write(`host '${host}' has no skill emitter; skipping skills\n`);
    return;
  }
  const target: CompileTarget = host;
  const summary = await emitSkillsToDir(skillsDir, { includeIntegrations: true, target });
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
