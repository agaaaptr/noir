import {
  detectActiveMethod,
  fetchLatestVersion,
  loadProjectInfo,
  readInstallRecord,
  readUpdateCache,
  runManagerCmd,
  shouldCheckForUpdate,
  type UpdateConfigLike,
  writeUpdateCache,
} from '@noir-ai/core';
import { type CliOptions, EXIT, fail, info, success, warn } from '../output.js';
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
  /**
   * I2 — `update.minVersion` floor (config.ts:238). True when the latest-known
   * version the registry returned is below the configured floor (e.g. a
   * beta/prerelease channel lag, or a yanked dist-tag). Enforced in
   * {@link update} with the same warn/refuse pattern as the downgrade guard.
   */
  belowMinVersion: boolean;
}

export function buildUpdateTarget(opts: {
  method: string;
  channel: string;
  spec?: string;
  currentVersion: string | null;
  latestKnown: string | null;
  /**
   * The `update.minVersion` floor from config (default `'1.6.0'`). When
   * omitted, the config default applies. See I2.
   */
  minVersion?: string;
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
  // I2 — minVersion floor: refuse a registry-offered version below the floor.
  // null latestKnown is handled separately (registry-unreachable branch).
  const floor = opts.minVersion ?? '1.6.0';
  const belowMinVersion = opts.latestKnown != null && semverLt(opts.latestKnown, floor);
  return {
    method: opts.method,
    targetSpec,
    currentVersion: opts.currentVersion,
    latestKnown: opts.latestKnown,
    isUpgrade,
    belowMinVersion,
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

/**
 * Per-segment numeric semver `<` (I2 — minVersion floor). Same comparison
 * discipline as {@link semverGt} / install.ts's downgrade guard: numeric per
 * segment, non-numeric → 0. Returns true when `a` is strictly less than `b`.
 */
function semverLt(a: string, b: string): boolean {
  const pa = a.split('.').map((s) => Number(s) || 0);
  const pb = b.split('.').map((s) => Number(s) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
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
  // I2 — read the `update.minVersion` floor from the project config (falls
  // back to the config default '1.6.0' when the project isn't initialized or
  // the block is absent). Same try/catch pattern as home.ts's update-config read.
  let minVersion = DEFAULT_UPDATE_CONFIG.minVersion;
  try {
    minVersion = loadProjectInfo(process.cwd()).config.update.minVersion;
  } catch {
    // Not initialized yet — the config default applies.
  }
  const target = buildUpdateTarget({
    method,
    channel: 'latest',
    spec: opts.spec,
    currentVersion,
    latestKnown: latest,
    minVersion,
  });

  // I2 — refuse to install a registry-offered version below the configured
  // minVersion floor (same warn/refuse pattern as install.ts's downgrade guard).
  // Checked before the isUpgrade branch: a below-floor offer is unsafe even if
  // it happens to be newer than the (very old) current install.
  if (target.belowMinVersion) {
    warn(`Latest known ${target.latestKnown} is below the minVersion floor (${minVersion}).`);
    fail(
      EXIT.USAGE,
      `refusing update to ${target.latestKnown} (below minVersion ${minVersion})`,
      opts,
    );
  }

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
