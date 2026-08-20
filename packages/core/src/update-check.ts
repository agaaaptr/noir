import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from './install-method.js';
import { noirHome } from './layout.js';

export interface UpdateCache {
  lastCheckAt: string | null;
  latestVersion: string | null;
  channel: string | null;
}

export interface UpdateConfigLike {
  checkEnabled: boolean;
  checkIntervalHours: number;
  channel: 'latest' | 'beta';
  minVersion: string;
  display: 'notice' | 'silent';
}

export function updateCachePath(): string {
  return process.env.NOIR_UPDATE_CACHE_JSON ?? join(noirHome(), 'update-cache.json');
}

export function readUpdateCache(): UpdateCache {
  try {
    const raw = readFileSync(updateCachePath(), 'utf8');
    const c = JSON.parse(raw) as Partial<UpdateCache>;
    return {
      lastCheckAt: typeof c.lastCheckAt === 'string' ? c.lastCheckAt : null,
      latestVersion: typeof c.latestVersion === 'string' ? c.latestVersion : null,
      channel: typeof c.channel === 'string' ? c.channel : null,
    };
  } catch {
    return { lastCheckAt: null, latestVersion: null, channel: null };
  }
}

export function writeUpdateCache(cache: UpdateCache): void {
  atomicWriteFile(updateCachePath(), `${JSON.stringify(cache, null, 2)}\n`);
}

export function isUpdateCheckDisabled(env: NodeJS.ProcessEnv): boolean {
  return env.NOIR_DISABLE_UPDATE_CHECK !== undefined || env.CI !== undefined;
}

export function isUpdateStale(cache: UpdateCache, intervalHours: number): boolean {
  if (!cache.lastCheckAt) return true;
  const lastMs = new Date(cache.lastCheckAt).getTime();
  // Guard against an unparseable / non-date `lastCheckAt` (e.g. corrupt cache,
  // hand-edited file). `new Date('garbage').getTime()` returns NaN; any
  // arithmetic with NaN is NaN, so the `>=` would be false — meaning a corrupt
  // cache would silently look "fresh" and suppress the check forever. Treat
  // NaN as "never checked" → stale.
  if (Number.isNaN(lastMs)) return true;
  const elapsed = Date.now() - lastMs;
  return elapsed >= intervalHours * 60 * 60 * 1000;
}

export function shouldCheckForUpdate(opts: {
  env: NodeJS.ProcessEnv;
  configUpdate: UpdateConfigLike;
  cache: UpdateCache;
}): boolean {
  if (!opts.configUpdate.checkEnabled) return false;
  if (isUpdateCheckDisabled(opts.env)) return false;
  return isUpdateStale(opts.cache, opts.configUpdate.checkIntervalHours);
}

export function latestVersionFromCache(cache: UpdateCache, channel: string): string | null {
  if (cache.channel !== channel) return null;
  return cache.latestVersion;
}

/** Default registry-fetch bound when the caller passes no signal of its own
 *  (5s) — an unresponsive registry must not hang `noir update --check` /
 *  `noir update` for undici's default ~300s. The fire-and-forget background
 *  check passes its own tighter 2s controller, which takes precedence. */
const UPDATE_FETCH_TIMEOUT_MS = 5_000;

/** Fetch the current dist-tag version from npm. Offline-safe: any failure → null. */
export async function fetchLatestVersion(
  channel: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/@noir-ai/cli/${channel}`, {
      signal: signal ?? AbortSignal.timeout(UPDATE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null;
  }
}
