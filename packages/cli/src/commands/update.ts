import {
  detectActiveMethod,
  fetchLatestVersion,
  readInstallRecord,
  readUpdateCache,
  runManagerCmd,
  shouldCheckForUpdate,
  type UpdateConfigLike,
  writeUpdateCache,
} from '@noir-ai/core';
import { type CliOptions, EXIT, fail, info, success } from '../output.js';
import { installManagedNode } from './install.js';

export const DEFAULT_UPDATE_CONFIG: UpdateConfigLike = {
  checkEnabled: true,
  checkIntervalHours: 24,
  channel: 'latest',
  minVersion: '1.6.0',
  display: 'notice',
};

export interface UpdateOptions extends CliOptions {
  check?: boolean;
  spec?: string;
}

export interface UpdateTarget {
  method: string;
  targetSpec: string;
  currentVersion: string | null;
  latestKnown: string | null;
  isUpgrade: boolean;
}

export function buildUpdateTarget(opts: {
  method: string;
  channel: string;
  spec?: string;
  currentVersion: string | null;
  latestKnown: string | null;
}): UpdateTarget {
  const targetSpec = opts.spec ?? opts.channel;
  // Semver downgrade guard (T6 hardening): only treat the latest-known version
  // as an upgrade when it is STRICTLY NEWER than the current one. The prior
  // inequality check (`latestKnown !== currentVersion`) would treat a registry
  // that returned an OLDER version (e.g. beta/prerelease channel lag, or a
  // pinned `--spec` older than installed) as an "upgrade" and silently
  // downgrade the install.
  const isUpgrade =
    opts.latestKnown != null &&
    opts.currentVersion != null &&
    semverGt(opts.latestKnown, opts.currentVersion);
  return {
    method: opts.method,
    targetSpec,
    currentVersion: opts.currentVersion,
    latestKnown: opts.latestKnown,
    isUpgrade,
  };
}

/**
 * Per-segment numeric semver comparison (major.minor.patch). Returns true when
 * `a` is strictly greater than `b`. Pre-release suffixes are ignored — Noir
 * versioning is `MAJOR.MINOR.PATCH` only, and the registry's dist-tag is the
 * source of truth for "latest". Non-numeric segments coerce to 0. Used here
 * instead of a full semver library to keep the CLI's dependency surface
 * unchanged (the same helper lives in install.ts for the downgrade guard).
 */
function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => Number(s) || 0);
  const pb = b.split('.').map((s) => Number(s) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export async function update(opts: UpdateOptions = {}): Promise<void> {
  // NOIR_DISABLE_UPDATES is the hard kill-switch for the SELF-UPDATE surface
  // (distinct from NOIR_DISABLE_UPDATE_CHECK, which only gags the background
  // version check). When set, `noir update` refuses to run at all — enterprises
  // can pin this in the environment to enforce "updates flow only through the
  // package manager / image rebuild, never from inside the CLI". `fail` is
  // `: never` (always throws) — the explicit `return` is defensive.
  if (process.env.NOIR_DISABLE_UPDATES !== undefined) {
    fail(
      EXIT.USAGE,
      'self-update is disabled (NOIR_DISABLE_UPDATES is set); update via your package manager or image rebuild.',
      opts,
    );
    return;
  }

  const method = detectActiveMethod();
  const rec = readInstallRecord();
  const currentVersion = rec?.version ?? null;

  if (opts.check === true) {
    const latest = await fetchLatestVersion('latest');
    info(
      latest
        ? `Latest: ${latest} (you have ${currentVersion ?? 'unknown'})`
        : 'Could not reach the registry.',
      opts,
    );
    return;
  }

  // Fetch latest (network; timeout-bound).
  const latest = await fetchLatestVersion('latest');
  // T6 hardening: when the registry was unreachable (fetch returned null), say
  // so explicitly — mirroring `--check` — instead of falling through to the
  // "up to date" branch (which the old inequality-based isUpgrade would print
  // because `null != currentVersion`).
  if (latest === null) {
    info('Could not reach the registry.', opts);
    return;
  }
  const target = buildUpdateTarget({
    method,
    channel: 'latest',
    spec: opts.spec,
    currentVersion,
    latestKnown: latest,
  });

  if (!target.isUpgrade) {
    info(`noir ${currentVersion} is up to date.`, opts);
    return;
  }

  if (method === 'native') {
    const res = await installManagedNode({
      version: target.targetSpec === 'latest' ? undefined : target.targetSpec,
      env: process.env,
    });
    if (!res.ok) fail(EXIT.ERROR, res.error ?? 'update failed', opts);
    success(`Updated to ${res.version}.`);
    return;
  }

  // npm/pnpm/yarn/bun/homebrew/scoop -> reinstall via the same manager.
  const cmd = updateCmdFor(method, target.targetSpec);
  if (!cmd)
    fail(EXIT.USAGE, `cannot auto-update a ${method} install; use the manager directly`, opts);
  const { code, stderr } = await runManagerCmd(cmd, { env: process.env });
  if (code !== 0) fail(EXIT.ERROR, `update failed: ${stderr.slice(0, 300)}`, opts);
  success('Updated.');
}

function updateCmdFor(method: string, spec: string): string[] | null {
  switch (method) {
    case 'npm':
      return ['npm', 'install', '-g', `@noir-ai/cli@${spec}`];
    case 'pnpm':
      return ['pnpm', 'add', '-g', `@noir-ai/cli@${spec}`];
    case 'yarn':
      return ['yarn', 'global', 'add', `@noir-ai/cli@${spec}`];
    case 'bun':
      return ['bun', 'add', '-g', `@noir-ai/cli@${spec}`];
    case 'homebrew':
      return ['brew', 'upgrade', 'noir'];
    case 'scoop':
      return ['scoop', 'update', 'noir'];
    default:
      return null;
  }
}

/** Non-blocking, time-boxed startup check. Writes the cache on success; silent on any failure. */
export async function runAsyncUpdateCheck(opts: {
  env: NodeJS.ProcessEnv;
  configUpdate: UpdateConfigLike;
  quiet: boolean;
}): Promise<void> {
  try {
    const cache = readUpdateCache();
    if (!shouldCheckForUpdate({ env: opts.env, configUpdate: opts.configUpdate, cache })) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const latest = await fetchLatestVersion(opts.configUpdate.channel, controller.signal);
    clearTimeout(timer);
    if (latest != null) {
      writeUpdateCache({
        lastCheckAt: new Date().toISOString(),
        latestVersion: latest,
        channel: opts.configUpdate.channel,
      });
    }
    // Non-blocking: never print in quiet/CI/non-TTY; a mismatch only nudges.
  } catch {
    // silent on any failure — this is a non-blocking background check
  }
}
