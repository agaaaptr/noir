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
  const isUpgrade =
    opts.latestKnown != null &&
    opts.currentVersion != null &&
    opts.latestKnown !== opts.currentVersion;
  return {
    method: opts.method,
    targetSpec,
    currentVersion: opts.currentVersion,
    latestKnown: opts.latestKnown,
    isUpgrade,
  };
}

export async function update(opts: UpdateOptions = {}): Promise<void> {
  const method = detectActiveMethod();
  const rec = readInstallRecord();
  const currentVersion = rec?.version ?? null;

  if (opts.check === true) {
    const latest = await fetchLatestVersion('latest');
    info(
      latest
        ? `Latest: ${latest} (you have ${currentVersion ?? 'unknown'})`
        : 'Could not reach the registry.',
    );
    return;
  }

  // Fetch latest (network; timeout-bound).
  const latest = await fetchLatestVersion('latest');
  const target = buildUpdateTarget({
    method,
    channel: 'latest',
    spec: opts.spec,
    currentVersion,
    latestKnown: latest,
  });

  if (!target.isUpgrade) {
    info(`noir ${currentVersion} is up to date.`);
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
