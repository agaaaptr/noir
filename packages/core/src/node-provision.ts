import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runtimeDir } from './layout.js';

/**
 * The single pinned Node version Noir provisions into `~/.noir/runtime/`.
 *
 * Node 22 LTS (codename **Jod**), active LTS — best native-dep prebuild
 * coverage for `better-sqlite3@13` / `onnxruntime-node`, and matches the
 * package `engines >= 22`. Bump this constant (and `scripts/node-version.env`)
 * together to move Noir onto a newer runtime; the module is otherwise
 * version-agnostic.
 */
export const MANAGED_NODE_VERSION = '22.23.2';

/** Minimum Node major version accepted for the SYSTEM fallback path. */
export const MIN_SYSTEM_NODE_MAJOR = 22;

/**
 * Base URL for the Node.js distribution. `https://nodejs.org/dist/` by
 * default; overridable via `NOIR_NODE_DIST_URL` for mirrors / offline tests.
 * Trailing slash normalized.
 */
export function nodeDistBaseUrl(): string {
  const raw = process.env.NOIR_NODE_DIST_URL ?? 'https://nodejs.org/dist/';
  return raw.endsWith('/') ? raw : `${raw}/`;
}

export interface NodeTarget {
  os: 'darwin' | 'linux' | 'win32';
  arch: 'x64' | 'arm64';
  archive: 'tar.gz' | 'zip';
}

/**
 * Map the host `process.platform` / `process.arch` to a Node dist target.
 * Throws on unsupported combinations (never silently pick a wrong archive).
 */
export function detectNodeTarget(): NodeTarget {
  let os: NodeTarget['os'];
  let arch: NodeTarget['arch'];
  switch (process.platform) {
    case 'darwin':
    case 'linux':
    case 'win32':
      os = process.platform;
      break;
    default:
      throw new Error(`unsupported platform for managed-Node provisioning: ${process.platform}`);
  }
  switch (process.arch) {
    case 'x64':
    case 'arm64':
      arch = process.arch;
      break;
    default:
      throw new Error(`unsupported arch for managed-Node provisioning: ${process.arch}`);
  }
  const archive: NodeTarget['archive'] = os === 'win32' ? 'zip' : 'tar.gz';
  return { os, arch, archive };
}

/**
 * Build the canonical Node dist archive URL for `(version, target)`.
 *
 * Note the asymmetry: the version DIR is `v<version>` (e.g. `v22.11.0/`)
 * but the FILE basename uses the bare version inside `node-v22.11.0-…`
 * — both are how nodejs.org/dist is actually laid out.
 */
export function nodeArchiveUrl(version: string, target: NodeTarget): string {
  const base = nodeDistBaseUrl();
  return `${base}v${version}/node-v${version}-${target.os}-${target.arch}.${target.archive}`;
}

/** URL of the GPG-signed checksum manifest for a given Node version. */
function shasumsUrl(version: string): string {
  return `${nodeDistBaseUrl()}v${version}/SHASUMS256.txt`;
}

/* ------------------------------- exec seam ------------------------------ */

/** The shape `extractNode` expects from any executor (real or mocked). */
export type ExecSeam = (
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Spawn-based default executor mirroring `install-detect.runManagerCmd`. */
const defaultExec: ExecSeam = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: 'timeout' });
    }, opts.timeoutMs ?? 60_000);
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/* --------------------------- download + verify -------------------------- */

/** A fetch seam — defaults to the global `fetch` (mockable in tests). */
export type FetchSeam = typeof globalThis.fetch;

/**
 * Download a Node archive + its `SHASUMS256.txt`, verify the archive's
 * SHA-256 against the manifest entry, and return both.
 *
 * FAIL-CLOSED: any mismatch, missing entry, or non-2xx response rejects —
 * the caller must NEVER install an unverified archive. The returned
 * `archiveBuf` is fully in memory (Node archives are ~25 MB; this is the
 * Claude-Code / volta model — download once, verify, then extract).
 *
 * `opts.fetch` is a mock seam (defaults to `globalThis.fetch`).
 */
export async function downloadAndVerify(
  version: string,
  target: NodeTarget,
  opts: { fetch?: FetchSeam; signal?: AbortSignal } = {},
): Promise<{ archiveBuf: Buffer; sha256: string }> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const archiveUrl = nodeArchiveUrl(version, target);
  const archiveBasename = archiveUrl.slice(archiveUrl.lastIndexOf('/') + 1);

  // 1) Fetch SHASUMS256.txt and find the line for OUR archive.
  const sumsRes = await doFetch(shasumsUrl(version), { signal: opts.signal });
  if (!sumsRes.ok) {
    throw new Error(
      `failed to fetch SHASUMS256.txt (status ${sumsRes.status}) for Node v${version}`,
    );
  }
  const sumsBody = await sumsRes.text();
  const expected = parseSha256Entry(sumsBody, archiveBasename);
  if (!expected) {
    throw new Error(`checksum verification failed: no SHASUMS256.txt entry for ${archiveBasename}`);
  }

  // 2) Fetch the archive.
  const archiveRes = await doFetch(archiveUrl, { signal: opts.signal });
  if (!archiveRes.ok) {
    throw new Error(`failed to fetch Node archive (status ${archiveRes.status}): ${archiveUrl}`);
  }
  const archiveBuf = Buffer.from(await archiveRes.arrayBuffer());

  // 3) Verify (fail-closed on mismatch).
  const actual = createHash('sha256').update(archiveBuf).digest('hex');
  if (actual !== expected) {
    throw new Error(
      `checksum verification failed for ${archiveBasename}: expected ${expected}, got ${actual}`,
    );
  }
  return { archiveBuf, sha256: expected };
}

/** Parse a Node `SHASUMS256.txt` line for `basename`; return the hex digest, or null. */
function parseSha256Entry(sumsBody: string, basename: string): string | null {
  for (const rawLine of sumsBody.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    // Format: `<64-hex>  <basename>` (two spaces).
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!m) continue;
    const digest = m[1];
    const name = m[2];
    if (digest === undefined || name === undefined) continue;
    if (name.trim() === basename) return digest.toLowerCase();
  }
  return null;
}

/* ------------------------------- extract -------------------------------- */

/**
 * Extract a Node archive into `destDir`. Posix uses `tar -xzf`, win32 uses
 * `unzip -q`. The real Node archive extracts into a `node-v<ver>-<os>-<arch>/`
 * subdir under `destDir`; the caller (`provisionManagedNode`) flattens that
 * into the final runtime dir.
 *
 * `opts.exec` is a mock seam (defaults to a real spawn-based executor).
 */
export async function extractNode(
  archiveBuf: Buffer,
  target: NodeTarget,
  destDir: string,
  opts: { exec?: ExecSeam; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<void> {
  const exec = opts.exec ?? defaultExec;
  mkdirSync(destDir, { recursive: true });
  // Extractors want a path, not a buffer. Write to a temp file inside destDir
  // so the same filesystem as the rename target is used (POSIX atomic rename).
  const tmpArchive = join(destDir, `.archive-${process.pid}-${Date.now()}.tmp`);
  const tmpArchiveBase = tmpArchive.slice(tmpArchive.lastIndexOf('/') + 1);
  writeFileSync(tmpArchive, archiveBuf);

  try {
    let code: number;
    if (target.archive === 'zip') {
      // unzip writes <basename>/ into destDir.
      const r = await exec('unzip', ['-q', '-o', tmpArchiveBase, '-d', destDir], {
        cwd: destDir,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
      });
      code = r.code;
      if (code !== 0) throw new Error(`unzip failed (code ${code}): ${r.stderr}`);
    } else {
      const r = await exec('tar', ['-xzf', tmpArchiveBase, '-C', destDir], {
        cwd: destDir,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
      });
      code = r.code;
      if (code !== 0) throw new Error(`tar failed (code ${code}): ${r.stderr}`);
    }
  } finally {
    rmSync(tmpArchive, { force: true });
  }
}

/* ------------------------------ provision ------------------------------- */

export interface ProvisionedNode {
  /** What runtime backs this node: `'managed'` (downloaded into ~/.noir) or `'system'` (fallback). */
  source: 'managed' | 'system';
  /** Node version (e.g. `'22.23.2'`); for the system fallback, the detected version. */
  version: string;
  /** Absolute path to the `node` binary. */
  nodeBin: string;
  /** Absolute path to the `npm` binary. */
  npmBin: string;
  /** The runtime dir: `~/.noir/runtime/v<version>/` (managed) or the system node's dir (fallback). */
  dir: string;
}

export interface ProvisionOptions {
  /** Mock seam for fetch. */
  fetch?: FetchSeam;
  /** Mock seam for tar/unzip. */
  exec?: ExecSeam;
  /** Pin to a specific target instead of {@link detectNodeTarget} (testing). */
  target?: NodeTarget;
  /** Pin to a specific version instead of {@link MANAGED_NODE_VERSION} (testing). */
  version?: string;
  /** Env to probe for the system-Node fallback (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** AbortSignal forwarded into the fetch seam. */
  signal?: AbortSignal;
}

/**
 * Provision the managed Node runtime. Pipeline:
 *
 * 1. **Reuse**: if `~/.noir/runtime/v<version>/bin/node` already exists,
 *    return it immediately (idempotent — `noir init` / re-install are no-ops).
 * 2. **Download + verify**: {@link downloadAndVerify} (fail-closed SHA-256).
 * 3. **Extract + atomic rename**: extract into a staging dir, then rename the
 *    extracted `node-v<ver>-<os>-<arch>/` *contents* into the final
 *    `v<version>/` dir. Never in-place overwrite.
 * 4. **Cleanup**: remove other `~/.noir/runtime/v<old>/` dirs (keep current only).
 * 5. **Fallback**: on any failure, probe the system for a Node ≥
 *    {@link MIN_SYSTEM_NODE_MAJOR}; if found, return `{ source: 'system' }`
 *    + warn. If no usable system Node either, throw — never silent.
 */
export async function provisionManagedNode(opts: ProvisionOptions = {}): Promise<ProvisionedNode> {
  const version = opts.version ?? MANAGED_NODE_VERSION;
  const target = opts.target ?? detectNodeTarget();
  const env = opts.env ?? process.env;
  const root = runtimeDir();
  const versionDir = join(root, `v${version}`);
  // Node archives on win32 extract `node.exe`/`npm.cmd` at the root (no `bin/`);
  // POSIX archives extract into `bin/node` / `bin/npm`.
  const binDir = target.os === 'win32' ? '' : 'bin';
  const nodeBin = join(versionDir, binDir, binName('node', target));
  const npmBin = join(versionDir, binDir, binName('npm', target));

  // 1) Reuse.
  if (existsSync(nodeBin)) {
    return { source: 'managed', version, nodeBin, npmBin, dir: versionDir };
  }

  // 2-4) Download + extract + cleanup. Any failure → fallback.
  try {
    const { archiveBuf } = await downloadAndVerify(version, target, {
      fetch: opts.fetch,
      signal: opts.signal,
    });

    // Staging: extract into a tmp dir under `root` (same FS → atomic rename).
    mkdirSync(root, { recursive: true });
    const staging = mkdtempSync(join(root, `.staging-${process.pid}-${Date.now()}-`));
    try {
      await extractNode(archiveBuf, target, staging, { exec: opts.exec, env });

      // The archive extracts into staging/node-v<ver>-<os>-<arch>/. Flatten
      // its CONTENTS up into versionDir. We do this by rename-ing the
      // extracted top dir itself to versionDir (atomic on POSIX when on the
      // same FS, which is why staging lives under `root`).
      const extracted = findExtractedNodeDir(staging, version, target);
      if (!extracted) {
        throw new Error(`extraction produced no node-v${version}-${target.os}-${target.arch}/ dir`);
      }
      // If a stale versionDir somehow exists (concurrent provision / partial
      // state), remove it first so the rename is unobstructed.
      if (existsSync(versionDir)) rmSync(versionDir, { recursive: true, force: true });
      renameSync(extracted, versionDir);

      if (!existsSync(nodeBin)) {
        throw new Error(`post-extract sanity check failed: ${nodeBin} missing`);
      }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }

    // 4) Cleanup older runtime dirs (keep only the current version).
    cleanupOldRuntimes(root, version);

    return { source: 'managed', version, nodeBin, npmBin, dir: versionDir };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // 5) System fallback.
    const fallback = await probeSystemNode(env);
    if (fallback) {
      console.warn(
        `[noir] managed-Node provision failed (${reason}); falling back to system Node ${fallback.version} at ${fallback.nodeBin}`,
      );
      return fallback;
    }
    throw new Error(
      `managed-Node provision failed (${reason}) and no usable system Node (>= ${MIN_SYSTEM_NODE_MAJOR}) was found for fallback`,
    );
  }
}

/** `.exe` on win32, bare basename otherwise. */
function binName(base: string, target: NodeTarget): string {
  return target.os === 'win32' ? `${base}.exe` : base;
}

/** Locate the `node-v<ver>-<os>-<arch>/` dir produced by extraction inside `staging`. */
function findExtractedNodeDir(staging: string, version: string, target: NodeTarget): string | null {
  const expected = `node-v${version}-${target.os}-${target.arch}`;
  let entries: string[];
  try {
    entries = readdirSync(staging);
  } catch {
    return null;
  }
  if (entries.includes(expected)) return join(staging, expected);
  // Be lenient: a single subdir is also acceptable (tests may not match the
  // exact naming; real tar always does).
  const dirs = entries.filter((e) => e.startsWith('node-v'));
  if (dirs.length === 1) {
    const only = dirs[0];
    if (only !== undefined) return join(staging, only);
  }
  return null;
}

/** Remove `~/.noir/runtime/v<old>/` dirs other than the current version. */
function cleanupOldRuntimes(root: string, keepVersion: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.startsWith('v')) continue;
    if (e === `v${keepVersion}`) continue;
    rmSync(join(root, e), { recursive: true, force: true });
  }
}

/** Probe for a system Node ≥ {@link MIN_SYSTEM_NODE_MAJOR}; return null if none.
 *
 * `NOIR_SYSTEM_NODE_BIN` is a hard override (mirrors the `NOIR_*_JSON` test
 * pattern): when SET, the probe uses exactly that path and never falls back
 * to a PATH lookup — set to `''` to force "no system node" in tests. When
 * UNSET, the probe resolves `node` on PATH via `which`/`where`. */
async function probeSystemNode(env: NodeJS.ProcessEnv): Promise<ProvisionedNode | null> {
  let nodeBin: string | null;
  if ('NOIR_SYSTEM_NODE_BIN' in env) {
    const v = env.NOIR_SYSTEM_NODE_BIN;
    nodeBin = typeof v === 'string' && v !== '' ? v : null;
  } else {
    nodeBin = await whichNode(env);
  }
  if (!nodeBin) return null;
  const version = await nodeMajorVersion(nodeBin, env);
  if (version === null) return null;
  if (version.major < MIN_SYSTEM_NODE_MAJOR) {
    throw new Error(
      `system Node is v${version.raw} (< ${MIN_SYSTEM_NODE_MAJOR}); refusing fallback`,
    );
  }
  // Normalize to the bare `22.5.0` form (drop the `v` prefix `node --version`
  // emits), so `ProvisionedNode.version` is consistent with the managed
  // `MANAGED_NODE_VERSION` constant (no `v`).
  const normalized = version.raw.replace(/^v/, '');
  // npm lives next to node in the same bin dir.
  const dir = nodeBin.slice(0, nodeBin.lastIndexOf('/'));
  const isWin = process.platform === 'win32';
  const npmBin = join(dir, isWin ? 'npm.cmd' : 'npm');
  return {
    source: 'system',
    version: normalized,
    nodeBin,
    npmBin,
    dir,
  };
}

/** Resolve `node` on PATH via a one-off `which`/`where` (no throw). */
async function whichNode(env: NodeJS.ProcessEnv): Promise<string | null> {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  return new Promise((resolve) => {
    const child = spawn(cmd, ['node'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 5_000);
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const first = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)[0];
      resolve(first ?? null);
    });
  });
}

/** `node --version` → { major, raw }; null if it doesn't run / parse. */
async function nodeMajorVersion(
  nodeBin: string,
  env: NodeJS.ProcessEnv,
): Promise<{ major: number; raw: string } | null> {
  return new Promise((resolve) => {
    const child = spawn(nodeBin, ['--version'], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, 5_000);
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const raw = stdout.trim();
      const m = /^v(\d+)\./.exec(raw);
      const major = m ? Number(m[1]) : Number.NaN;
      if (Number.isNaN(major)) {
        resolve(null);
        return;
      }
      resolve({ major, raw });
    });
  });
}
