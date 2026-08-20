import {
  detectActiveMethod,
  ensureShimExecutable,
  fetchLatestVersion,
  loadProjectInfo,
  readInstallRecord,
  readUpdateCache,
  runManagerCmd,
  shouldCheckForUpdate,
  type UpdateConfigLike,
  writeUpdateCache,
} from '@noir-ai/core';
import { type CliOptions, EXIT, fail, info, spinner, success, warn } from '../output.js';
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
  // The guard target: a concrete `--spec` (an exact version) WINS over the
  // fetched registry version — the T6/I2 guards must evaluate what we will
  // ACTUALLY install, not what the registry happens to offer. A pinned
  // `--spec 1.9.0` against a 1.12.0 registry is a DOWNGRADE, and a pinned
  // `--spec 1.5.0` can trip the minVersion floor — both were previously missed
  // because the guards only ever looked at `latestKnown`.
  const concrete =
    opts.spec != null && opts.spec !== 'latest' && opts.spec !== 'beta'
      ? opts.spec
      : opts.latestKnown;
  // Semver downgrade guard (T6 hardening): only treat the target as an upgrade
  // when it is STRICTLY NEWER than the current one. The prior inequality check
  // (`latestKnown !== currentVersion`) would treat a registry that returned an
  // OLDER version (e.g. beta/prerelease channel lag) as an "upgrade" and
  // silently downgrade the install.
  const isUpgrade =
    concrete != null && opts.currentVersion != null && semverGt(concrete, opts.currentVersion);
  // I2 — minVersion floor: refuse a target version below the floor. null
  // latestKnown is handled separately (registry-unreachable branch).
  const floor = opts.minVersion ?? '1.6.0';
  const belowMinVersion = concrete != null && semverLt(concrete, floor);
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
    const checkSpin = spinner('Checking for updates...', opts).start();
    const latest = await fetchLatestVersion('latest');
    if (latest) {
      checkSpin.succeed(`Latest: ${latest} (you have ${currentVersion ?? 'unknown'})`);
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: { latest, currentVersion } })}\n`);
      }
    } else {
      checkSpin.fail('Could not reach the registry.');
      // fail() emits the canonical {ok:false,error} envelope under --json AND
      // exits 1 (a manual envelope here would leave the process at exit 0 while
      // the payload claims code 1).
      fail(EXIT.ERROR, 'Could not reach the registry.', opts);
    }
    return;
  }

  // Fetch latest (network; timeout-bound).
  const fetchSpin = spinner('Checking for updates...', opts).start();
  const latest = await fetchLatestVersion('latest');
  if (latest === null) {
    fetchSpin.fail('Could not reach the registry.');
    // Registry-unreachable is a FAILURE: route through fail() so --json emits
    // {ok:false,error} on stdout AND the process exits 1 (a silent return would
    // leave stdout empty + exit 0 — indistinguishable from success for scripts).
    fail(EXIT.ERROR, 'Could not reach the registry.', opts);
  }
  fetchSpin.succeed(`Latest: ${latest}`);
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
    fetchSpin.succeed(`noir ${currentVersion} is up to date`);
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, data: { version: currentVersion, upToDate: true } })}\n`,
      );
      return;
    }
    info(`noir ${currentVersion} is up to date.`, opts);
    return;
  }

  if (method === 'native') {
    const updateSpin = spinner(
      `Updating to ${target.latestKnown} via native installer...`,
      opts,
    ).start();
    const res = await installManagedNode({
      version: target.targetSpec === 'latest' ? undefined : target.targetSpec,
      env: process.env,
    });
    if (!res.ok) {
      updateSpin.fail('Update failed');
      fail(EXIT.ERROR, res.error ?? 'update failed', opts);
    }
    // Chicken-egg safety net: the update was ORCHESTRATED by the OLD binary
    // (which may predate the chmod fix). Re-assert the freshly-written shim is
    // executable so the user's NEXT `noir …` doesn't fail with permission
    // denied. This is the ONLY line that closes the regression once 1.7.4+ is
    // installed — it runs in the NEW binary's process.
    ensureShimExecutable();
    updateSpin.succeed(`Updated to noir ${res.version}`);
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, data: { version: res.version } })}\n`);
      return;
    }
    success(`Updated to ${res.version}.`);
    return;
  }

  // npm/pnpm/yarn/bun/homebrew/scoop -> reinstall via the same manager.
  const cmd = updateCmdFor(method, target.targetSpec);
  if (!cmd)
    fail(EXIT.USAGE, `cannot auto-update a ${method} install; use the manager directly`, opts);
  const mgrSpin = spinner(`Updating via ${method}...`, opts).start();
  const { code, stderr } = await runManagerCmd(cmd, { env: process.env });
  if (code !== 0) {
    mgrSpin.fail(`Update failed`);
    fail(EXIT.ERROR, `update failed: ${stderr.slice(0, 300)}`, opts);
  }
  mgrSpin.succeed('Updated');
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data: { version: target.targetSpec } })}\n`);
    return;
  }
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

/**
 * The human-readable update command for an install method. Mirrors
 * {@link updateCmdFor} (the machine command) with the manager the user should
 * actually run — `noir update` is the universal entry (it re-dispatches to the
 * right manager), but the package-manager spellings are shown for transparency.
 */
export function updateAdvice(method: string): string {
  switch (method) {
    case 'npm':
      return 'run `npm install -g @noir-ai/cli@latest`';
    case 'pnpm':
      return 'run `pnpm add -g @noir-ai/cli@latest`';
    case 'yarn':
      return 'run `yarn global add @noir-ai/cli@latest`';
    case 'bun':
      return 'run `bun add -g @noir-ai/cli@latest`';
    case 'homebrew':
      return 'run `brew upgrade noir`';
    case 'scoop':
      return 'run `scoop update noir`';
    case 'native':
      return 'run `noir update`';
    default:
      return 'run `noir update`';
  }
}

/** A "new version available" notice for the home menu (version + advice). */
export interface UpdateNotice {
  readonly latestVersion: string;
  readonly currentVersion: string;
  readonly method: string;
  readonly advice: string;
}

/**
 * Build the home-menu "update available" notice from the cached latest version.
 * Returns `null` when there is no cached latest, no current version, or the
 * latest is NOT strictly newer (the semver downgrade guard — a stale/older
 * cache entry is never advertised as an upgrade).
 */
export function buildUpdateNotice(opts: {
  method: string;
  currentVersion: string | null;
  latestKnown: string | null;
}): UpdateNotice | null {
  const { method, currentVersion, latestKnown } = opts;
  if (currentVersion == null || latestKnown == null) return null;
  if (!semverGt(latestKnown, currentVersion)) return null;
  return { latestVersion: latestKnown, currentVersion, method, advice: updateAdvice(method) };
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
