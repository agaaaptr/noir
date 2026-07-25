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
import { scaffold } from '@noir-ai/create';
import { type CompileTarget, emitSkillsToDir } from '@noir-ai/skills';
import { assertTransportUrl } from '../init.js';

export interface CreateOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
  /** S10 target host. Defaults to `'claude'`. */
  host?: HostId;
}

/**
 * Bootstrap Noir's AI layer in `dir`.
 *
 * @param dir   Target directory (created if absent). Defaults to `process.cwd()`.
 * @param opts  Transport + URL + host (same semantics as `noir init`).
 */
export async function create(dir: string | undefined, opts: CreateOptions): Promise<void> {
  // M2: call assertTransportUrl directly so the SAME error class yields the SAME
  // exit code as `noir init` (plain Error → exit 1 for both missing-url and
  // non-localhost). The previous NoirCliError(EXIT.USAGE) wrapper made `create`
  // exit 2 where `init` exits 1.
  assertTransportUrl(opts);

  const root = resolve(dir ?? process.cwd());
  const host: HostId = opts.host ?? 'claude';

  await scaffold({
    root,
    mode: 'create',
    host,
    transport: opts.transport,
    ...(opts.url !== undefined ? { url: opts.url } : {}),
  });

  // Skills are out-of-manifest by design — same composition as init.
  const adapter = resolveAdapter(host);
  const skillsDir = adapter.skillsDir?.({ root });
  if (skillsDir === undefined) {
    // N1: standardized wording — same phrase across init/sync/create so logs
    // grep uniformly. (Pre-N1 each command phrased this differently.)
    process.stderr.write(`host '${host}' has no skill emitter; skipping skills\n`);
  } else {
    const target: CompileTarget = host;
    const summary = await emitSkillsToDir(skillsDir, { includeIntegrations: true, target });
    const relDir = skillsDir.replace(`${root}/`, '');
    process.stderr.write(
      `Emitted ${summary.emitted.length} Noir skills to ${relDir}/ (target: ${target}).\n`,
    );
  }

  process.stderr.write(`Noir created in ${root} (host: ${host}, transport: ${opts.transport}).\n`);
}
