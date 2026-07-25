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
// Deliberate behavior changes vs the predecessor (spec-aligned latent-bug
// fixes; see S-T1 contract notes + CHANGELOG):
//   - `.noir/project.id` → skipIfExists (predecessor overwrote on every init,
//     orphaning the store DB named after the id). Re-init now preserves it.
//   - `.noir/config.yml` → skipIfExists (predecessor overwrote).
//   - `.noir/NOIR.md` → managedBlock with BRIEF_BLOCK markers (predecessor
//     wrote the whole file with no markers). First-run output GAINS markers;
//     user notes outside the markers survive re-runs.
//   - `.noir/scaffold-version` is now stamped on init/create (engine-owned).

import { claudeAdapter } from '@noir-ai/adapters';
import { scaffold } from '@noir-ai/create';
import { emitSkillsToDir } from '@noir-ai/skills';

export interface InitOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
  /** `noir init --upgrade`: run scaffold migrations from the on-disk
   *  scaffold-version to current, then re-emit ONLY the runtime subset
   *  (regenerate + managedBlock). skipIfExists seeds are left alone so user
   *  edits survive. */
  upgrade?: boolean;
}

export async function init(root: string, opts: InitOptions): Promise<void> {
  assertTransportUrl(opts);

  await scaffold({
    root,
    mode: 'init',
    transport: opts.transport,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
    ...(opts.upgrade === true ? { upgrade: true } : {}),
  });

  // Skills are out-of-manifest by design: the host skill dir is a pure
  // pointer derived from the adapter, so compose the call after scaffold().
  if (claudeAdapter.skillsDir) {
    const summary = await emitSkillsToDir(claudeAdapter.skillsDir({ root }));
    process.stderr.write(`Emitted ${summary.emitted.length} Noir skills to .claude/skills/.\n`);
  }

  process.stderr.write(`Noir initialized in ${root} (transport: ${opts.transport}).\n`);
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
