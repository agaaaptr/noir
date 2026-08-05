import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  atomicWriteFile,
  type DetectResult,
  detectActiveMethod,
  detectInstallMethods,
  ensureShimExecutable,
  loadProjectInfo,
  MANAGED_NODE_VERSION,
  NOIR_VERSION,
  noirHome,
  type ProvisionedNode,
  type ProvisionOptions,
  provisionManagedNode,
  readInstallRecord,
  runManagerCmd,
  writeInstallRecord,
} from '@noir-ai/core';
import { type CliOptions, EXIT, fail, info, spinner, success, warn } from '../output.js';

export interface InstallOptions extends CliOptions {
  list?: boolean;
  uninstallPrev?: boolean;
  spec?: string;
  /** Dismiss the migration banner for the current CLI version (persists in
   *  install.json's `dismissedVersions`). Typically passed with `--list`. */
  dismiss?: boolean;
}

export interface MigrationPlan {
  detected: DetectResult[];
  currentMethod: string;
  targetSpec: string;
  installedVersion: string | null;
  shouldMigrate: boolean;
  isDowngrade: boolean;
  /**
   * I2 — `update.minVersion` floor (config.ts:238). True when the resolved
   * target is a concrete version below the configured floor. Channel targets
   * (`latest`/`beta`) resolve to the newest at install time and never trip it.
   * Enforced in {@link install} with the same warn/refuse pattern as the
   * downgrade guard.
   */
  belowMinVersion: boolean;
  nativeVersion: string;
  prevUninstallCmd: string | null;
  autoUninstall: boolean; // always false unless --uninstall-prev
}

/** Per-segment numeric semver comparison. Returns true when `a < b`. */
function semverLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** Pure: build the migration plan from detection + target. No I/O. */
export function buildMigrationPlan(opts: {
  detected: DetectResult[];
  currentMethod: string;
  targetSpec: string;
  installedVersion: string | null;
  /**
   * The `update.minVersion` floor from config (default `'1.6.0'`). When
   * omitted, the config default applies. See I2.
   */
  minVersion?: string;
}): MigrationPlan {
  const detected = opts.detected;
  const shouldMigrate = detected.length > 0 && opts.currentMethod !== 'native';
  const nativeVersion = opts.targetSpec;
  let isDowngrade = false;
  if (opts.installedVersion && nativeVersion !== 'latest' && nativeVersion !== 'beta') {
    isDowngrade = semverLt(nativeVersion, opts.installedVersion);
  }
  // I2 — minVersion floor: only a concrete version below the floor trips it;
  // 'latest'/'beta' resolve to the newest at install time (always >= floor).
  const floor = opts.minVersion ?? '1.6.0';
  const belowMinVersion =
    nativeVersion !== 'latest' && nativeVersion !== 'beta' && semverLt(nativeVersion, floor);
  return {
    detected,
    currentMethod: opts.currentMethod,
    targetSpec: opts.targetSpec,
    installedVersion: opts.installedVersion,
    shouldMigrate,
    isDowngrade,
    belowMinVersion,
    nativeVersion,
    prevUninstallCmd: detected[0]?.uninstallCmd ?? null,
    autoUninstall: false,
  };
}

export interface InstallManagedNodeOptions {
  channel?: string;
  version?: string;
  env: NodeJS.ProcessEnv;
  /**
   * Forwarded into {@link provisionManagedNode} (P1). Carries the offline mock
   * seams (`fetch`, `exec`, `target`, `signal`) so the install pipeline is
   * unit-testable without network — same pattern as `provisionManagedNode`'s
   * own suite in `packages/core/test/node-provision.test.ts`.
   */
  provision?: Pick<ProvisionOptions, 'fetch' | 'exec' | 'target' | 'signal'>;
}

/** Normalized record of which runtime backed an install (P2). */
export interface InstallManagedNodeResult {
  ok: boolean;
  version: string | null;
  /** What runtime backed this install: `'managed'` (downloaded into ~/.noir)
   *  or `'system'` (used the system-Node fallback). */
  runtimeSource?: ProvisionedNode['source'];
  error?: string;
}

/**
 * Provision the managed Node runtime (P1) and install `@noir-ai/cli` into an
 * isolated `~/.noir/cli` prefix, shimmed from `~/.noir/bin/noir`.
 *
 * Replaces the prior "not provisioned" fail branch: instead of requiring the
 * user to pre-run `install.sh`/`install.ps1`, this now delegates to
 * {@link provisionManagedNode} (download + verify + extract, fail-closed), then
 * installs the CLI with the provisioned npm. On a system-Node fallback the
 * fallback node/npm paths are used and a warning is emitted; the install
 * record's `managedRuntimeVersion` reflects which path was taken so `noir
 * doctor` can report it accurately.
 */
export async function installManagedNode(
  opts: InstallManagedNodeOptions,
): Promise<InstallManagedNodeResult> {
  const spec = opts.version ?? opts.channel ?? 'latest';
  const home = noirHome();
  const cliDir = join(home, 'cli');
  const binDir = join(home, 'bin');
  mkdirSync(cliDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  // Provision the managed Node runtime (P1). Idempotent — re-runs are no-ops.
  // On any failure, provisionManagedNode either falls back to a system Node
  // >=22 (returns { source: 'system' }) or throws — we surface the throw as an
  // {ok:false} envelope rather than letting it kill the CLI.
  let runtime: ProvisionedNode;
  try {
    runtime = await provisionManagedNode({
      ...(opts.provision ?? {}),
      env: opts.env,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, version: null, error: `managed-Node provision failed: ${reason}` };
  }
  if (runtime.source === 'system') {
    warn(
      `managed-Node download failed; using system Node ${runtime.version} at ${runtime.nodeBin}.`,
    );
  }

  const { nodeBin, npmBin } = runtime;

  // Install @noir-ai/cli into the isolated prefix using the provisioned npm.
  const { code, stderr } = await runManagerCmd(
    [npmBin, 'install', '-g', `@noir-ai/cli@${spec}`, `--prefix=${cliDir}`],
    { env: opts.env, timeoutMs: 120_000 },
  );
  if (code !== 0) {
    return { ok: false, version: null, error: `npm install failed: ${stderr.slice(0, 300)}` };
  }

  // Shim: ~/.noir/bin/noir -> provisioned node + isolated prefix.
  const shim = join(binDir, 'noir');
  const shimBody = `#!/usr/bin/env bash\n"${nodeBin}" "${join(cliDir, 'lib', 'node_modules', '@noir-ai', 'cli', 'dist', 'bin.js')}" "$@"\n`;
  atomicWriteFile(shim, shimBody);
  chmodSync(shim, 0o755); // must be executable — atomicWriteFile sets 0o644 by default
  ensureShimExecutable(); // defense-in-depth: re-assert 0o755 (idempotent, never throws)
  // (POSIX shim; Windows uses a .cmd wrapper -- install.sh/install.ps1, P3.)

  // Resolve installed version via the provisioned node.
  const ver = await runManagerCmd(
    [
      nodeBin,
      join(cliDir, 'lib', 'node_modules', '@noir-ai', 'cli', 'dist', 'bin.js'),
      '--version',
    ],
    { env: opts.env, timeoutMs: 30_000 },
  );
  const version = ver.code === 0 ? ver.stdout.trim() : null;
  writeInstallRecord({
    method: 'native',
    version: version ?? '0.0.0',
    channel: opts.channel ?? 'latest',
    installedAt: new Date().toISOString(),
    // Reflect which runtime backs this install: the pinned managed version
    // (e.g. '22.23.2') for managed, or 'system-<v>' for the fallback so doctor
    // can distinguish a fallback install from a real managed one.
    managedRuntimeVersion:
      runtime.source === 'managed' ? MANAGED_NODE_VERSION : `system-${runtime.version}`,
  });
  return { ok: true, version, runtimeSource: runtime.source };
}

export async function install(opts: InstallOptions = {}): Promise<void> {
  // --dismiss: append the current CLI version to install.json's
  // `dismissedVersions` so the migration banner stops showing for this
  // version. Idempotent (no duplicate entries). Typically combined with
  // `--list`; works standalone too. Requires an existing install record —
  // if there's none, there's nothing to dismiss (no banner was shown).
  if (opts.dismiss === true) {
    const rec = readInstallRecord();
    if (!rec) {
      info('No install record found; nothing to dismiss.');
      return;
    }
    const dismissed = new Set(rec.dismissedVersions ?? []);
    if (!dismissed.has(NOIR_VERSION)) dismissed.add(NOIR_VERSION);
    writeInstallRecord({ ...rec, dismissedVersions: [...dismissed] });
    success(`Migration banner dismissed for ${NOIR_VERSION}.`);
    if (opts.list !== true) return; // --dismiss alone is done; --list continues below.
  }

  if (opts.list === true) {
    const detected = await detectInstallMethods(process.env);
    const jsonOutput = { ok: true, data: { detected } };
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(jsonOutput)}\n`);
      return;
    }
    info('Detected installs:');
    for (const d of detected) info(`  ${d.method} (${d.version ?? 'unknown'})`);
    return;
  }

  const currentMethod = detectActiveMethod();
  const detected = await detectInstallMethods(process.env);
  const installedRecord = readInstallRecord();
  // I2 — read the `update.minVersion` floor from the project config (falls
  // back to the config default '1.6.0' when the project isn't initialized or
  // the block is absent). Same try/catch pattern as home.ts's update-config read.
  let minVersion = '1.6.0';
  try {
    minVersion = loadProjectInfo(process.cwd()).config.update.minVersion;
  } catch {
    // Not initialized yet — the config default applies.
  }
  const plan = buildMigrationPlan({
    detected,
    currentMethod,
    targetSpec: opts.spec ?? 'latest',
    installedVersion: installedRecord?.version ?? null,
    minVersion,
  });

  // I2 — refuse to install a version below the configured minVersion floor
  // (same warn/refuse pattern as the installed-version downgrade guard).
  if (plan.belowMinVersion) {
    warn(`Target ${plan.nativeVersion} is below the minVersion floor (${minVersion}).`);
    if (opts.noInput === true || opts.input === false) {
      fail(
        EXIT.USAGE,
        `refusing install of ${plan.nativeVersion} (below minVersion ${minVersion})`,
        opts,
      );
    }
  }

  if (plan.isDowngrade) {
    warn(`Target ${plan.nativeVersion} is OLDER than installed ${plan.installedVersion}.`);
    // (Interactive confirm is skipped under --no-input; we hard-stop to be safe.)
    if (opts.noInput === true || opts.input === false) {
      fail(
        EXIT.USAGE,
        `refusing downgrade to ${plan.nativeVersion} (installed ${plan.installedVersion})`,
        opts,
      );
    }
    // @clack confirm gate (lazy import) -- same pattern as home.ts.
  }

  const installSpin = spinner('Installing Noir via native installer...', opts).start();
  const result = await installManagedNode({
    channel: plan.nativeVersion === 'beta' ? 'beta' : undefined,
    version: plan.nativeVersion.startsWith('v')
      ? plan.nativeVersion
      : plan.nativeVersion === 'latest' || plan.nativeVersion === 'beta'
        ? undefined
        : plan.nativeVersion,
    env: process.env,
  });
  if (!result.ok) {
    installSpin.fail('Native install failed');
    fail(EXIT.ERROR, result.error ?? 'native install failed', opts);
  }
  installSpin.succeed(`Installed noir ${result.version}`);

  info(`Installed native: ${result.version}.`);
  if (plan.prevUninstallCmd && opts.uninstallPrev !== true) {
    warn(`To finish the migration, uninstall the previous install: ${plan.prevUninstallCmd}`);
    warn(
      '  Or re-run with --uninstall-prev to do it now. Rollback: reinstall via the previous manager.',
    );
  } else if (plan.prevUninstallCmd && opts.uninstallPrev === true) {
    const { code } = await runManagerCmd(plan.prevUninstallCmd.split(' '), { env: process.env });
    if (code === 0) success('Previous install removed.');
    else warn('Previous install NOT removed (non-zero exit). You can remove it manually.');
  }
  // Claude Code #41806/#27910 mitigation: the old npm bin may still resolve
  // first in $PATH after migration (the shell hashes command paths, and a
  // stale global install can shadow ~/.noir/bin). Hint the user to refresh.
  info('If `noir` still points at the old install, run: hash -r && which -a noir');
  success(`noir ${result.version} installed via native. Run \`noir doctor\` to verify.`);
}
