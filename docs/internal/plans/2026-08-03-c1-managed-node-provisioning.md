# C1 Managed-Node Provisioning + Registry Accuracy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Provision a pinned Node 22 LTS into `~/.noir/runtime/` (real managed-Node), wire the CLI + installers to use it (managed-first/system-fallback), and fix the release-registry channel/changelogRef accuracy.

**Architecture:** A new `packages/core/src/node-provision.ts` module owns the download→verify→extract→cleanup pipeline; the CLI `installManagedNode` and the install.sh/ps1 scripts both consume it (via a shared `scripts/node-version.env`). The registry fix is a one-function change in `release-registry.mjs` + a rebuild.

**Tech Stack:** Node ≥22, TypeScript, `node:crypto`, `node:child_process` (tar/unzip), bash, PowerShell, vitest.

## Global Constraints

- Commits LOCAL on `develop`. No push.
- Full gate before done: `pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm docs:validate`.
- Unit tests OFFLINE/free — mock `fetch`/extraction; no real network. CI smoke test does the real Node download.
- Checksum verification is **fail-closed** (never install an unverified archive).
- Atomic writes: extract to staging dir → atomic rename.
- Managed-first, system-Node (≥22) fallback on download failure; never silent on unsupported Node.
- Follow existing repo patterns (commander, S9 EXIT/output helpers, additive config, `{ok,data}` envelope, `noirHome()` layout).

---

### Task P1: `node-provision.ts` module (core) — download/verify/extract/cleanup

**Files:**
- Create: `packages/core/src/node-provision.ts`
- Modify: `packages/core/src/layout.ts` (add `runtimeDir()`), `packages/core/src/index.ts` (export)
- Test: `packages/core/test/node-provision.test.ts`

**Interfaces:**
- Produces:
  - `const MANAGED_NODE_VERSION = '<exact 22 LTS patch>'`
  - `function runtimeDir(): string` (also exported from layout.ts)
  - `interface NodeTarget { os: 'darwin'|'linux'|'win32'; arch: 'x64'|'arm64'; archive: 'tar.gz'|'zip' }`
  - `function detectNodeTarget(): NodeTarget`
  - `function nodeArchiveUrl(version, target): string`
  - `interface ProvisionedNode { version: string; nodeBin: string; npmBin: string; dir: string; source: 'managed'|'system' }`
  - `async function downloadAndVerify(version, target, opts?): Promise<{archiveBuf: Buffer; sha256: string}>` — fetch archive + SHASUMS256.txt, verify, fail-closed.
  - `async function extractNode(archiveBuf, target, destDir): Promise<void>`
  - `async function provisionManagedNode(opts?): Promise<ProvisionedNode>`
- Consumes: `noirHome`, `atomicWriteFile`.

- [ ] **Step 1: Write failing test** (offline; mock fetch + extract)

```ts
// packages/core/test/node-provision.test.ts
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectNodeTarget, nodeArchiveUrl, MANAGED_NODE_VERSION } from '../src/node-provision.js';

describe('detectNodeTarget', () => {
  it('maps platform/arch to a Node dist target', () => {
    const t = detectNodeTarget();
    expect(['darwin','linux','win32']).toContain(t.os);
    expect(['x64','arm64']).toContain(t.arch);
    expect(['tar.gz','zip']).toContain(t.archive);
    if (t.os === 'win32') expect(t.archive).toBe('zip');
    else expect(t.archive).toBe('tar.gz');
  });
});

describe('nodeArchiveUrl', () => {
  it('builds the canonical nodejs.org dist URL', () => {
    const u = nodeArchiveUrl('22.11.0', { os: 'darwin', arch: 'arm64', archive: 'tar.gz' });
    expect(u).toBe('https://nodejs.org/dist/v22.11.0/node-v22.11.0-darwin-arm64.tar.gz');
  });
  it('uses .zip for win32', () => {
    const u = nodeArchiveUrl('22.11.0', { os: 'win32', arch: 'x64', archive: 'zip' });
    expect(u).toMatch(/win32-x64\.zip$/);
  });
});

// downloadAndVerify fail-closed + provisionManagedNode reuse/fallback/cleanup are
// tested with mocked fetch + extract in the same file (see full test block below).
```

- [ ] **Step 2: Run → FAIL (module not found).**
- [ ] **Step 3: Implement** `node-provision.ts` (detect, url, downloadAndVerify with fetch mock seam via `opts.fetch`, extract via `node:child_process` tar/unzip, provisionManagedNode with reuse/staging-atomic-rename/cleanup/fallback). Add `runtimeDir()` to layout.ts. Export from index.ts.
- [ ] **Step 4: Add the offline provision tests** (mocked `fetch` returning a fake archive + SHASUMS; assert verify-fails-closed on tampered checksum; reuse-when-present; fallback-to-system-on-fetch-error; cleanup-of-old-runtimes). All via a `NOIR_RUNTIME_DIR` env override like `NOIR_DAEMON_JSON`.
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(core): node-provision — managed Node 22 LTS download/verify/extract`.

---

### Task P2: wire `installManagedNode` to provision

**Files:** modify `packages/cli/src/commands/install.ts`; test `packages/cli/test/install.test.ts`.

- Replace the `if (!existsSync(nodeBin)) return { ok:false, error:'not provisioned' }` branch with: call `provisionManagedNode()`; on `{ source:'system' }` warn + use system node/npm; record `managedRuntimeVersion` accordingly. Keep the shim logic.
- Test: with provision mocked to return a managed node, `installManagedNode` proceeds (no "not provisioned" error); with system fallback, it warns and uses the fallback path.
- Commit `feat(cli): installManagedNode provisions managed Node`.

---

### Task P3: installer scripts provision Node

**Files:** create `scripts/node-version.env`; modify `scripts/install.sh` + `scripts/install.ps1`.

- `node-version.env`: `MANAGED_NODE_VERSION=<exact>` + `NODE_DIST_BASE_URL=https://nodejs.org/dist`.
- `install.sh`: add `provision_node()` — detect os/arch, fetch `v<ver>/SHASUMS256.txt` + the archive, verify sha256 (`shasum -a 256`), extract to `~/.noir/runtime/v<ver>/` via staging+rename, cleanup old, fallback to system `node`≥22 on failure. Use the runtime's node/npm for the isolated-prefix install.
- `install.ps1`: same in PowerShell (`Invoke-WebRequest`, `Get-FileHash`, `Expand-Archive`).
- Both source `node-version.env`.
- No unit test (CI smoke test in P5 exercises the real download).
- Commit `feat(dist): install.sh/ps1 provision managed Node 22 LTS`.

---

### Task P4: release registry accuracy

**Files:** modify `scripts/release-registry.mjs`; rebuild `.noir/releases/`.

- `buildEntry`: `channel = isStable ? 'stable' : 'beta'`; `npmDistTag = isStable ? 'latest' : 'beta'` (derive from type, not distTags lookup). `changelogRef = \`https://github.com/agaaaptr/noir/blob/main/CHANGELOG.md#${anchorFor(version)}\``. Same in `cmdAdd`.
- `anchorFor(version)`: strip non-alphanumeric → e.g. `1.6.0` → `160`, `1.4.0-beta.1` → `140-beta1` (match CHANGELOG heading style — verify against actual CHANGELOG.md headings).
- Run `pnpm release:rebuild` → 1.4.0/1.5.0 flip to `channel: stable`; all entries get `changelogRef`. Run `pnpm release:validate` (green).
- Test (vitest on release-registry.mjs if a test seam exists, else verify via rebuild+validate + a node assertion script that checks the two fixed rows).
- Commit `fix(release-registry): channel from type + changelogRef populated`.

---

### Task P5: CI smoke test for managed-Node provision

**Files:** modify `.github/workflows/ci.yml`.

- Add a job `node-provision-smoke` (ubuntu/macos/windows) that runs `bash scripts/install.sh` / `install.ps1` from a clean env (no system Node on PATH where feasible) and asserts `~/.noir/runtime/v<ver>/bin/node` exists + `noir --version` works. This is the only place the real Node download runs.
- Commit `ci: managed-Node provision smoke test`.

---

### Task P6: docs accuracy + capability-01 → Completed

**Files:** `docs/how-to/installation.md`, `docs/roadmap/capability-01-package-distribution.md`, `docs/decisions/0005-*.md`, `README.md`, `docs/roadmap/STATUS.md`, `docs/roadmap/roadmap.manifest.yaml`, `docs/roadmap/backlog.md`, `CHANGELOG.md`.

- State managed-first/system-fallback truthfully; note pinned Node 22 LTS + `~/.noir/runtime/`.
- capability-01: move bootstrap/metadata/mislabel out of Gap → Shipped/Resolved; acceptance #7 → MET; status → 🟩 Completed.
- backlog: move the three items to "History of resolutions".
- STATUS/manifest: C1 Completed.
- Run `pnpm docs:validate` (green).
- Commit `docs: managed-Node provisioning + registry accuracy — C1 Completed`.

---

### Task P7: full-gate validation

- `pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate` → all green.
- Verify all commits local on `develop`, none pushed.
- Final report.

## Self-Review

- Spec coverage: M1→P1, M2→P2, M3→P3, M4→P4, M5→P5/P6, docs→P6, acceptance→P1-P6.
- Placeholders: the `<exact 22 LTS patch>` is filled at P1 time from the active LTS (a single constant); `anchorFor` heading style verified against CHANGELOG at P4.
- Type consistency: `ProvisionedNode.source: 'managed'|'system'` consumed by P2; `MANAGED_NODE_VERSION` shared by P1/P3 via the module + `node-version.env`.
