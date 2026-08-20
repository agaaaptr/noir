import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeDir } from '../src/layout.js';
import {
  detectNodeTarget,
  downloadAndVerify,
  extractNode,
  MANAGED_NODE_VERSION,
  type NodeTarget,
  nodeArchiveUrl,
  nodeDistBaseUrl,
  provisionManagedNode,
} from '../src/node-provision.js';

/* ---------- isolated runtime dir (NOIR_RUNTIME_DIR override) ---------- */
let dir: string;
let prevRuntime: string | undefined;
let prevDistUrl: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-node-provision-'));
  prevRuntime = process.env.NOIR_RUNTIME_DIR;
  prevDistUrl = process.env.NOIR_NODE_DIST_URL;
  process.env.NOIR_RUNTIME_DIR = dir;
});
afterEach(() => {
  if (prevRuntime === undefined) delete process.env.NOIR_RUNTIME_DIR;
  else process.env.NOIR_RUNTIME_DIR = prevRuntime;
  if (prevDistUrl === undefined) delete process.env.NOIR_NODE_DIST_URL;
  else process.env.NOIR_NODE_DIST_URL = prevDistUrl;
  rmSync(dir, { recursive: true, force: true });
});

/* ---------- helpers: build a fake archive + SHASUMS256.txt ---------- */
function fakeArchive(payload: string): { buf: Buffer; sha256: string } {
  const buf = Buffer.from(payload, 'utf8');
  const sha256 = createHash('sha256').update(buf).digest('hex');
  return { buf, sha256 };
}

/** A mocked fetch that returns the archive for the dist file URL and the
 *  SHASUMS256.txt body for the checksum URL. */
function mockFetch(archiveBuf: Buffer, sha256: string, archiveUrlEnd: string) {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/SHASUMS256.txt')) {
      // Node dist SHASUMS lines look like:  <hex>  node-v22.x.x-...tar.gz
      const entry = `${sha256}  ${archiveUrlEnd}`;
      return new Response(entry, { status: 200 });
    }
    if (u.endsWith(archiveUrlEnd)) {
      return new Response(archiveBuf, { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

/** Fake exec seam: pretends extraction succeeded by writing bin/node & bin/npm
 *  into the dest dir. Lets provisionManagedNode proceed without real tar.
 *
 *  Mirrors BOTH exec calls `extractNode` makes:
 *   1. LIST (assertNoTraversal): `tar -tzf <tmp-basename>` / `unzip -Z1 <tmp>`
 *      → return a canned listing and create NOTHING (the prior mock built a tree
 *      under the last ARG here, which for the list call is the RELATIVE tmp
 *      basename → it wrote `.archive-<pid>-<ts>.tmp/…` into the repo root and
 *      never cleaned it).
 *   2. EXTRACT: `tar -xzf <tmp> -C <destDir>` → build the tree under the exec
 *      `cwd` (which is destDir), mirroring the real tar's `node-v…/` subdir so
 *      the flatten step is exercised. */
function fakeExecThatExtracts(version: string) {
  return vi.fn(
    async (
      _cmd: string,
      args: string[],
      opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
    ) => {
      if (args[0] === '-tzf' || args[0] === '-Z1') {
        // Listing call — canned entry, no filesystem writes.
        return { code: 0, stdout: `node-v${version}-fakeos-fakearch\n`, stderr: '' };
      }
      const destDir = opts.cwd ?? '';
      const extractedRoot = join(destDir, `node-v${version}-fakeos-fakearch`);
      mkdirSync(join(extractedRoot, 'bin'), { recursive: true });
      writeFileSync(join(extractedRoot, 'bin', 'node'), '#!/bin/sh\necho fake-node\n');
      writeFileSync(join(extractedRoot, 'bin', 'npm'), '#!/bin/sh\necho fake-npm\n');
      return { code: 0, stdout: '', stderr: '' };
    },
  );
}

/* =========================== detectNodeTarget =========================== */
describe('detectNodeTarget', () => {
  it('maps the host platform/arch to a Node dist target', () => {
    const t = detectNodeTarget();
    expect(['darwin', 'linux', 'win32']).toContain(t.os);
    expect(['x64', 'arm64']).toContain(t.arch);
    expect(['tar.gz', 'zip']).toContain(t.archive);
    if (t.os === 'win32') expect(t.archive).toBe('zip');
    else expect(t.archive).toBe('tar.gz');
  });
});

/* =========================== nodeArchiveUrl ============================ */
describe('nodeArchiveUrl', () => {
  it('builds the canonical nodejs.org dist URL', () => {
    const u = nodeArchiveUrl('22.11.0', { os: 'darwin', arch: 'arm64', archive: 'tar.gz' });
    expect(u).toBe('https://nodejs.org/dist/v22.11.0/node-v22.11.0-darwin-arm64.tar.gz');
  });
  it('uses .zip for win32', () => {
    const u = nodeArchiveUrl('22.11.0', { os: 'win32', arch: 'x64', archive: 'zip' });
    expect(u).toMatch(/win32-x64\.zip$/);
  });
  it('honors NOIR_NODE_DIST_URL override', () => {
    process.env.NOIR_NODE_DIST_URL = 'https://mirror.example.com/node/';
    const u = nodeArchiveUrl('22.11.0', { os: 'linux', arch: 'x64', archive: 'tar.gz' });
    expect(u).toBe('https://mirror.example.com/node/v22.11.0/node-v22.11.0-linux-x64.tar.gz');
    expect(nodeDistBaseUrl()).toBe('https://mirror.example.com/node/');
  });
});

/* ========================== downloadAndVerify ========================== */
describe('downloadAndVerify', () => {
  const target: NodeTarget = { os: 'linux', arch: 'x64', archive: 'tar.gz' };

  it('returns the archive buffer + sha when the checksum matches', async () => {
    const { buf, sha256 } = fakeArchive('archive-body');
    const urlEnd = `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`;
    const fetchMock = mockFetch(buf, sha256, urlEnd);

    const res = await downloadAndVerify(MANAGED_NODE_VERSION, target, { fetch: fetchMock });
    expect(res.archiveBuf.equals(buf)).toBe(true);
    expect(res.sha256).toBe(sha256);
    // both archive + SHASUMS fetched exactly once
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('FAIL-CLOSED when the archive does not match the listed checksum', async () => {
    const { buf } = fakeArchive('archive-body');
    // SHASUMS lists a *wrong* hash for our archive.
    const listedSha = '0'.repeat(64);
    const urlEnd = `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`;
    const fetchMock = mockFetch(buf, listedSha, urlEnd);

    await expect(
      downloadAndVerify(MANAGED_NODE_VERSION, target, { fetch: fetchMock }),
    ).rejects.toThrow(/checksum|verify|sha256/i);
  });

  it('FAIL-CLOSED when the SHASUMS file has no entry for our archive', async () => {
    const { buf } = fakeArchive('archive-body');
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/SHASUMS256.txt')) {
        return new Response('deadbeef  some-other-archive.tar.gz\n', { status: 200 });
      }
      return new Response(buf, { status: 200 });
    });
    await expect(
      downloadAndVerify(MANAGED_NODE_VERSION, target, { fetch: fetchMock }),
    ).rejects.toThrow(/no .*entry|not found|checksum/i);
  });

  it('FAIL-CLOSED when the archive fetch errors (non-2xx)', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/SHASUMS256.txt')) return new Response('x  y\n', { status: 200 });
      return new Response('server explosion', { status: 500 });
    });
    await expect(
      downloadAndVerify(MANAGED_NODE_VERSION, target, { fetch: fetchMock }),
    ).rejects.toThrow();
  });
});

/* ============================= extractNode ============================= */
describe('extractNode', () => {
  it('lists (tar -tzf) then extracts (tar -xzf) for posix .tar.gz', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const target: NodeTarget = { os: 'linux', arch: 'x64', archive: 'tar.gz' };
    await extractNode(Buffer.from('x'), target, dir, { exec });
    expect(exec).toHaveBeenCalledTimes(2); // 1 list (traversal guard) + 1 extract
    const listCall = exec.mock.calls[0];
    const extractCall = exec.mock.calls[1];
    expect(listCall?.[0]).toBe('tar');
    expect(listCall?.[1][0]).toBe('-tzf');
    expect(extractCall?.[0]).toBe('tar');
    expect(extractCall?.[1][0]).toBe('-xzf');
  });

  it('lists (unzip -Z1) then extracts (unzip -q) for win32 .zip', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const target: NodeTarget = { os: 'win32', arch: 'x64', archive: 'zip' };
    await extractNode(Buffer.from('x'), target, dir, { exec });
    expect(exec).toHaveBeenCalledTimes(2);
    const listCall = exec.mock.calls[0];
    const extractCall = exec.mock.calls[1];
    expect(listCall?.[0]).toBe('unzip');
    expect(listCall?.[1][0]).toBe('-Z1');
    expect(extractCall?.[0]).toBe('unzip');
    expect(extractCall?.[1][0]).toBe('-q');
  });

  it('rejects a traversal entry (../) before extracting', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '../evil\n', stderr: '' }));
    const target: NodeTarget = { os: 'linux', arch: 'x64', archive: 'tar.gz' };
    await expect(extractNode(Buffer.from('x'), target, dir, { exec })).rejects.toThrow(/escapes/);
    expect(exec).toHaveBeenCalledTimes(1); // listing only — extraction never ran
  });

  it('rejects an absolute-path entry before extracting', async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: '/etc/passwd\n', stderr: '' }));
    const target: NodeTarget = { os: 'win32', arch: 'x64', archive: 'zip' };
    await expect(extractNode(Buffer.from('x'), target, dir, { exec })).rejects.toThrow(/escapes/);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('throws when the extractor exits non-zero', async () => {
    const exec = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'bad zip' }));
    const target: NodeTarget = { os: 'win32', arch: 'x64', archive: 'zip' };
    await expect(extractNode(Buffer.from('x'), target, dir, { exec })).rejects.toThrow();
  });
});

/* ========================= provisionManagedNode ======================== */
describe('provisionManagedNode', () => {
  const target: NodeTarget = { os: 'linux', arch: 'x64', archive: 'tar.gz' };

  it('downloads, verifies, extracts into ~/.noir/runtime/v<version> and returns a managed node', async () => {
    const { buf, sha256 } = fakeArchive('archive-body');
    const urlEnd = `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`;
    const fetchMock = mockFetch(buf, sha256, urlEnd);
    const execMock = fakeExecThatExtracts(MANAGED_NODE_VERSION);

    const res = await provisionManagedNode({
      fetch: fetchMock,
      exec: execMock,
      target,
    });

    expect(res.source).toBe('managed');
    expect(res.version).toBe(MANAGED_NODE_VERSION);
    // bin/node + bin/npm land under the versioned runtime dir.
    expect(existsSync(res.nodeBin)).toBe(true);
    expect(existsSync(res.npmBin)).toBe(true);
    // res.dir is <runtimeRoot>/v<version> (NOIR_RUNTIME_DIR overrides the root,
    // so it may not literally contain a "runtime" segment — check the version).
    expect(res.dir.endsWith(`v${MANAGED_NODE_VERSION}`)).toBe(true);
  });

  it('REUSES the existing provisioned runtime when bin/node already exists (idempotent, no fetch)', async () => {
    const { buf, sha256 } = fakeArchive('archive-body');
    const urlEnd = `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`;
    const fetchMock = mockFetch(buf, sha256, urlEnd);
    const execMock = fakeExecThatExtracts(MANAGED_NODE_VERSION);

    // First call provisions.
    const first = await provisionManagedNode({ fetch: fetchMock, exec: execMock, target });
    expect(first.source).toBe('managed');
    const fetchCallsAfterFirst = fetchMock.mock.calls.length;

    // Second call must reuse — no further fetches.
    const second = await provisionManagedNode({ fetch: fetchMock, exec: execMock, target });
    expect(second.source).toBe('managed');
    expect(second.nodeBin).toBe(first.nodeBin);
    expect(fetchMock.mock.calls.length).toBe(fetchCallsAfterFirst);
  });

  it('CLEANS UP old runtime version dirs after a successful provision', async () => {
    // Pretend an older version was previously provisioned.
    const oldVer = '22.0.0';
    const oldDir = join(dir, `v${oldVer}`, 'bin');
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'node'), 'old');
    expect(existsSync(join(dir, `v${oldVer}`))).toBe(true);

    const { buf, sha256 } = fakeArchive('archive-body');
    const urlEnd = `node-v${MANAGED_NODE_VERSION}-linux-x64.tar.gz`;
    const fetchMock = mockFetch(buf, sha256, urlEnd);
    const execMock = fakeExecThatExtracts(MANAGED_NODE_VERSION);

    await provisionManagedNode({ fetch: fetchMock, exec: execMock, target });

    // old dir gone, current dir present
    expect(existsSync(join(dir, `v${oldVer}`))).toBe(false);
    expect(existsSync(join(dir, `v${MANAGED_NODE_VERSION}`))).toBe(true);
  });

  it('FALLS BACK to system Node (>=22) when the download fails', async () => {
    // Make the archive fetch fail; SHASUMS fetch succeeds (so it's clearly the
    // archive download that broke, not the checksum lookup).
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith('/SHASUMS256.txt')) {
        return new Response('0'.repeat(64), { status: 200 });
      }
      // archive fetch explodes
      throw new Error('network down');
    });

    // Fake a system node >= 22 on PATH.
    const fakeNode = join(dir, 'fake-system-node');
    writeFileSync(fakeNode, '#!/bin/sh\necho v22.5.0\n');
    chmodSync(fakeNode, 0o755);
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      NOIR_SYSTEM_NODE_BIN: fakeNode, // test seam: skip the real `which node`
    };

    const res = await provisionManagedNode({
      fetch: fetchMock,
      target,
      env,
    });

    expect(res.source).toBe('system');
    expect(res.version).toBe('22.5.0');
    expect(res.nodeBin).toBe(fakeNode);
  });

  it('THROWS (no silent success) when download fails AND no usable system Node exists', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    // No system node seam → system probe finds nothing.
    const env = { ...process.env, NOIR_SYSTEM_NODE_BIN: '' };
    await expect(provisionManagedNode({ fetch: fetchMock, target, env })).rejects.toThrow(
      /node|provision|fallback/i,
    );
  });

  it('refuses an unsupported system Node (<22) on fallback', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    const fakeNode = join(dir, 'old-system-node');
    writeFileSync(fakeNode, '#!/bin/sh\necho v18.5.0\n');
    chmodSync(fakeNode, 0o755);
    const env = {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ''}`,
      NOIR_SYSTEM_NODE_BIN: fakeNode,
    };
    await expect(provisionManagedNode({ fetch: fetchMock, target, env })).rejects.toThrow(
      /node.*22|>=.*22|unsupported/i,
    );
  });
});

/* ============================ layout.runtimeDir ======================= */
describe('runtimeDir (layout)', () => {
  it('points at ~/.noir/runtime by default and honors NOIR_RUNTIME_DIR', () => {
    // With NOIR_RUNTIME_DIR set to our temp dir in beforeEach.
    expect(runtimeDir()).toBe(dir);
    delete process.env.NOIR_RUNTIME_DIR;
    expect(runtimeDir()).toBe(join(process.env.HOME ?? '/tmp', '.noir', 'runtime'));
  });
});
