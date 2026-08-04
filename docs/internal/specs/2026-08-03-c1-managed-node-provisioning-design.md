# C1 Managed-Node Provisioning + Registry Accuracy (spec)

> Capability-01 follow-up. Makes the "managed-Node" claim **real** (the installer actually provisions a pinned Node LTS into `~/.noir/runtime/`), and fixes the release-registry accuracy bugs (channel mislabel on 1.4.0/1.5.0; `changelogRef` null). Companion to `2026-08-03-c1-native-installer-design.md`. Decision: ADR-0005 (managed-Node).
>
> This is the reference for `docs/internal/plans/2026-08-03-c1-managed-node-provisioning.md`.

## Goal

1. **Provision a pinned Node 22 LTS** into `~/.noir/runtime/<v>/` from `nodejs.org/dist` (checksum-verified against the GPG-signed `SHASUMS256.txt`), so the native installer no longer requires a system Node. Managed-first with a system-Node fallback (≥22) when the download is unreachable.
2. **Wire the CLI's `installManagedNode`** to actually provision (download+extract) instead of failing with "not provisioned".
3. **Fix the release registry**: derive `channel` from `type` (not from the `distTags.latest` lookup that mislabels 1.4.0/1.5.0); populate `changelogRef` per release.

## Why (grounded in audit)

- Deep audit (2026-08-03) found **no Node-download code anywhere**: `installManagedNode` (install.ts:120) only *checks* `~/.noir/runtime/v<version>/bin/node` and fails if absent; `install.sh` only `require_node()` (system Node); `install.ps1` falls back to `Get-Command node`. The "managed-Node, no system Node" claim in capability-01/installation.md/ADR-0005 was **stronger than reality** — misleading (violates CLAUDE.md "Docs reflect shipped reality").
- Scalability argument (user): managed-Node makes Noir resilient to future minimum-req bumps (Node 24 LTS). Noir controls its own runtime; users on older system Node are not forced to upgrade. This is exactly the volta/fnm/Claude-Code model.
- Release registry: `buildEntry` (release-registry.mjs:179-183) sets `channel='stable'` only when `distTags.latest === version`. Because `latest` moved on, the stable 1.4.0/1.5.0 rows are mislabeled `beta`. `changelogRef` is hardcoded `null` (buildEntry:207, cmdAdd). Acceptance criterion #7 ("registry rows carry accurate channel labels and non-null changelogRef") is not MET.

## Decisions (locked, 2026-08-03)

- **Node version**: pin **Node 22 LTS** (active LTS; matches `engines >=22`; prebuilds for `better-sqlite3@13`/`onnxruntime-node` are most complete on 22).
- **Fallback**: **managed-first, system fallback**. If the Node download fails (offline/corp firewall), fall back to a system Node ≥22 if present, with a clear warning. Never silently succeed on an unsupported Node.
- **Cleanup**: **auto-cleanup old versions** — after a successful provision of a new Node version, remove older `~/.noir/runtime/<old-version>/` dirs (keep current only).
- **Registry**: **retrofix historical entries** — rebuild the registry so 1.4.0/1.5.0 get `channel: stable`; populate `changelogRef` for all entries. Do not rewrite git history; only rebuild the generated `releases.json`/`releases.md`.

## Scope

### M1 — Node provisioning module (core)

**Files:** create `packages/core/src/node-provision.ts`; export from `packages/core/src/index.ts`; test `packages/core/test/node-provision.test.ts`.

- `interface ProvisionedNode { version: string; nodeBin: string; npmBin: string; dir: string }`
- `const MANAGED_NODE_VERSION = '22.x.x'` (exact pinned LTS patch; single source).
- `runtimeDir(): string` — `~/.noir/runtime/` (add to `layout.ts` next to `modelsDir()`).
- `nodeDistBaseUrl()` — `https://nodejs.org/dist/` (overridable via `NOIR_NODE_DIST_URL` for mirrors/testing).
- `detectNodeTarget(): { os: 'darwin'|'linux'|'win32'; arch: 'x64'|'arm64'; archive: 'tar.gz'|'zip' }` — from `process.platform`/`process.arch`. Reject unsupported targets with a clear error.
- `nodeArchiveUrl(version, target): string` — `https://nodejs.org/dist/v<version>/node-v<version>-<os>-<arch>.<archive>`.
- `downloadAndVerify(version, target, opts?: { signal? }): Promise<{ archivePath: string; sha256: string }>` — fetch the archive + `SHASUMS256.txt` for that version dir, verify the archive's SHA-256 against the entry, **fail-closed on mismatch**. Honor `HTTP(S)_PROXY`/`NO_PROXY`.
- `extractNode(archivePath, target, destDir): Promise<void>` — tar -xzf (posix) / unzip (win32) into `~/.noir/runtime/v<version>/`. The extracted dir contains `bin/node`, `bin/npm`.
- `provisionManagedNode(opts?: { env; signal? }): Promise<ProvisionedNode | { systemFallback: ProvisionedNode }>`:
  1. If `~/.noir/runtime/v<version>/bin/node` exists and passes a version check → reuse (idempotent).
  2. Else download+verify+extract into a staging dir, then atomic-rename into `v<version>/`.
  3. **Auto-cleanup**: remove other `~/.noir/runtime/v*/` dirs != current.
  4. On any failure → **fallback**: probe system `node` ≥22; if present, return `{ systemFallback }` + warn; else throw a clear error.
- Offline-safe unit tests: mock `fetch`/`extract`; assert verify-fails-closed on bad checksum, idempotent reuse, fallback-on-download-error, cleanup-of-old-versions. **No real network in the unit suite** (a CI smoke test downloads a real Node once).

### M2 — CLI `installManagedNode` wired to provision

**Files:** modify `packages/cli/src/commands/install.ts`.

- Replace the "not provisioned → fail" branch with a call to `provisionManagedNode()`. If `{ systemFallback }`, warn and use the system node/npm path; write `managedRuntimeVersion: 'system'` in the install record. If a real provisioned node, write the pinned version.
- The shim still points the isolated-prefix entry at whichever node/npm resolved. `installManagedNode` remains the single caller.

### M3 — Installer scripts provision Node

**Files:** modify `scripts/install.sh` + `scripts/install.ps1`.

- Add a `provision_node()` step (bash) / `Provision-Node` (ps1) BEFORE the npm install: if `~/.noir/runtime/v<version>/bin/node` is absent, download the Node archive for the detected OS/arch, verify SHA-256 against `SHASUMS256.txt`, extract into the runtime dir, then use that node/npm for the isolated-prefix install. Same managed-first/system-fallback + auto-cleanup semantics as M1. Reuse M1's URL/checksum constants by sourcing a shared `scripts/node-version.env` (version + dist base URL) so bash/ps1/CLI agree on one pinned version.
- `install.sh` Windows-redirect branch unchanged.

### M4 — Release registry accuracy

**Files:** modify `scripts/release-registry.mjs`; regenerate `.noir/releases/releases.json` + `releases.md`.

- `buildEntry`: derive `channel` and `npmDistTag` from `type` — `isStable ? ('stable'/'latest') : ('beta'/'beta')`. Drop the `distTags.latest === version` heuristic (it only ever matched the *current* latest). Keep dist-tags as metadata, not as the channel source.
- `changelogRef`: set to a stable anchor — `https://github.com/agaaaptr/noir/blob/main/CHANGELOG.md#<version>` (kebab version anchor, e.g. `#160`). Both `buildEntry` and `cmdAdd`.
- Rebuild the registry (`pnpm release:rebuild`) so historical 1.4.0/1.5.0 flip to `channel: stable` and every entry gets a `changelogRef`. Validate (`pnpm release:validate`).

### M5 — Docs accuracy

**Files:** `docs/how-to/installation.md`, `docs/roadmap/capability-01-package-distribution.md`, `docs/decisions/0005-native-installer-managed-node.md`, `README.md`, `docs/roadmap/STATUS.md`, `docs/roadmap/backlog.md`.

- Capability-01: move "CLI-only managed-Node bootstrap" and "Richer release metadata" out of Gap → Shipped; "Reconcile registry channel mislabels" → Resolved. Acceptance #7 → MET.
- installation.md: state the managed-first/system-fallback behavior truthfully; note the pinned Node 22 LTS and where it lands (`~/.noir/runtime/`).
- Backlog: move the registry/changelogRef/bootstrap items to "History of resolutions".
- STATUS/manifest: C1 → **Completed** (🟩) once verified.

## Acceptance

- [ ] `provisionManagedNode()` downloads, SHA-256-verifies (fail-closed), extracts Node 22 LTS into `~/.noir/runtime/v<version>/`, reuses if present, cleans old versions, falls back to system Node ≥22 on download failure. Unit tests offline; CI smoke test does a real download.
- [ ] `installManagedNode` provisions (no longer fails "not provisioned"); shim uses the resolved node; install record records the runtime version.
- [ ] `install.sh` + `install.ps1` provision Node (shared version via `scripts/node-version.env`); managed-first/system-fallback.
- [ ] Registry: 1.4.0/1.5.0 `channel: stable`; every entry has a non-null `changelogRef`; `pnpm release:validate` green.
- [ ] Docs reflect shipped reality (managed-first/system-fallback); capability-01 Gap items resolved; acceptance #7 MET.
- [ ] Full gate green; commits local on `develop` (no push).

## Out of scope

- Node 24 LTS pin (future; the module makes this a one-constant change + re-test).
- winget/Chocolatey (ADR-0005 deferred).
- Per-channel update cache shape change (deliberate trade-off, ADR-0005).

## Risks

- **Native-dep ABI vs pinned Node**: if `better-sqlite3@13`/`onnxruntime-node` lack prebuilds for the exact pinned Node patch, install falls back to source-compile. Mitigate: pin a Node patch known to have prebuilds; CI smoke-test the real provision+install.
- **nodejs.org reachability**: mitigated by the system-Node fallback.
- **Checksum verification** must be fail-closed (never install an unverified archive).
- **Windows extraction**: zip vs tar.gz; handle the `.zip` archive + `node.exe` path.
