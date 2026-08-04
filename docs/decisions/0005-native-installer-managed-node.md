# ADR-0005: Native installer is managed-Node, not a single binary

- **Status:** Accepted
- **Date:** 2026-08-03

## Context

Capability 1 (Package Distribution) shipped its npm/release-automation core in v1.0–v1.6, but four distribution gaps remained open in the C1 grounding (`docs/roadmap/capability-01-package-distribution.md`):

1. **No CLI self-update / version management** — no `noir update`, no startup version check, no migration messaging.
2. **No native installer beyond `curl|sh`-delegates-to-`npm install -g`** — `scripts/install.sh` was an honest delegator that required a system Node ≥ 22 and a writable npm global prefix (and sometimes `sudo`). There was no Windows-native path.
3. **Homebrew formula was a placeholder** (`url`/`sha256`/`version` TBD); **Scoop / Winget / Chocolatey** did not exist.
4. **No installer trust story** — no checksums, no attestation binding the installer to a release.

The forced question for the native installer: do we ship a **single self-contained binary** (Node + the CLI + native deps compiled in — e.g. via `bun build --compile`, `sea`, or `pkg`), or do we ship a **managed-Node runtime** that installs `@noir-ai/cli` from npm into an isolated prefix?

A research pass collapsed the scope. Three findings were load-bearing:

- **Native deps defeat the single-binary pitch.** Noir depends on `better-sqlite3`, `sqlite-vec`, and `onnxruntime-node` — three N-API native modules that ship as prebuilt `.node` binaries per (platform × arch × Node-ABI). A "single binary" would either have to embed every prebuild (defeating the size win and still missing exotic platforms) or compile from source at first run (worse than today). You do not actually get a single file; you get a directory with a launcher.
- **`onnxruntime-node` actively rejects bundling.** It loads shared libraries and model artifacts by `__dirname`-relative paths at runtime; the bundlers that produce single binaries (`sea`, `pkg`, `bun --compile`) re-home module layout and break those paths. The supported path for `onnxruntime-node` is "install via npm into `node_modules` and run with a real Node."
- **A managed Node 22.x runtime removes the user's Node prerequisite without giving up the npm distribution path.** Installing `@noir-ai/cli@<spec>` into an isolated prefix under `~/.noir/cli/` (via `npm install -g --prefix=…`), with a shim at `~/.noir/bin/noir` that invokes the managed Node against the isolated entry, gets us "no system Node, no `sudo`/admin, idempotent re-run = upgrade" while keeping every other piece (release pipeline, provenance, native-dep prebuilts) unchanged.

The decision fell out of the research: **managed-Node, not single-binary**.

A second, smaller question: which Windows package managers? `install.ps1` is the primary Windows path (mirrors `install.sh`), and **Scoop** fits the manifest model (a JSON file in a bucket). **winget** and **Chocolatey** each add manifest maintenance + a separate submission pipeline without covering any path `install.ps1`/Scoop/npm don't already cover.

## Decision

**The "native installer" is a managed-Node runtime, not a single binary.** Six load-bearing decisions:

### 1. Managed Node 22.x runtime under `~/.noir/`

`scripts/install.sh` (POSIX) and `scripts/install.ps1` (Windows PowerShell) provision a pinned **Node 22.x LTS** runtime under `~/.noir/runtime/v<version>/` (or `%USERPROFILE%\.noir\runtime\node\`), install `@noir-ai/cli@<spec>` into `~/.noir/cli/` via the managed npm with `--prefix` (isolated; never the system global), and write a `noir` shim at `~/.noir/bin/noir` (POSIX) or `noir.cmd` (Windows) that invokes the managed Node against the isolated CLI entry. The runtime, the prefix, and the shim are all in the user's home directory — **no system Node prerequisite, no `sudo`/admin**. Idempotent: re-running the installer upgrades in place and refreshes the `install.json` record.

### 2. Windows PowerShell is a first-class install path

`install.ps1` mirrors `install.sh` and is the **primary** Windows path. There is **no Git Bash/MSYS2/WSL requirement** — run it from a normal PowerShell prompt. The shim is a `.cmd` wrapper (the only PATH contract). The `release.yml` job runs a Windows CI matrix + an install-smoke step so the Windows path is gated in CI, not just on the maintainer's machine.

### 3. `~/.noir/install.json` is the install record (single source for doctor/update/migrate)

The installer writes `~/.noir/install.json` with `{ method: 'native', version, channel, installedAt, managedRuntimeVersion }`. `noir doctor`'s install row reads it; `noir update`/`noir migrate` write it. The record is written **atomically** (temp → rename), never in-place overwrite. The `method` field is the input to `detectActiveMethod()`, so the CLI always knows which install path it is running from. `noir install --dismiss` appends the current CLI version to a `dismissedVersions` array to suppress the migration banner per version.

### 4. Self-update preserves the active install method; migration is explicit

`noir update` reinstalls via the **active** method — native re-provisions; npm/pnpm/yarn/bun/Homebrew/Scoop reinstall via that manager. It is gated by a per-segment numeric **semver downgrade guard** (refuses to silently install an older version; an explicit positional version pin prints a warning). `NOIR_DISABLE_UPDATES` is a hard kill-switch for the entire self-update surface (enterprise: pin updates to the image rebuild); `NOIR_DISABLE_UPDATE_CHECK` gags only the background startup check. The async startup check is non-blocking, cached (`~/.noir/update.json`, 24h default, configurable under `update:`), silent under `--quiet`/CI/non-TTY, and never makes a paid call.

`noir install` / `noir migrate` moves an existing install **to** the native path. It **never auto-uninstalls** the previous method — `--uninstall-prev` is explicit, and the suggested uninstall command is always printed when it is omitted. Migration touches only where the `noir` bin resolves from; `.noir/` project data and `~/.noir/` user data are never modified.

### 5. Installer trust = pinned checksums + Sigstore build-time attestation

Every release publishes `install.sh`, `install.ps1`, and a `SHA256SUMS` file as Release artifacts, then runs `actions/attest-build-provenance@v3` over all three — persisting a Sigstore attestation to GitHub's attestations API. Consumers verify with `shasum -a 256 install.sh` (offline checksum vs. `SHA256SUMS`) **and** `gh attestation verify install.sh --repo agaaaptr/noir` (cryptographic binding to the CI run). This is the same SLSA predicate npm provenance uses; it is independent of the npm token.

### 6. Homebrew + Scoop ship stable-only; winget/Chocolatey deferred

- **Homebrew** (`packaging/homebrew/noir.rb`) — Node-for-Formula-Authors pattern; depends on Homebrew's `node@22`; installs into `libexec`; symlinks `noir`. Real `url`/`sha256`/`version` from the published 1.6.0 tarball. **Stable-only** (taps are single-channel; for beta use npm directly).
- **Scoop** (`packaging/scoop/noir.json`) — Windows; depends on `nodejs-lts`; shims `dist/bin.js` as `noir`. Stable-only single-channel.
- **winget / Chocolatey** — **deferred by decision.** Windows is covered by `install.ps1` (primary), Scoop, and npm; winget/Chocolatey add manifest breadth but no new capability, and each carries its own submission/review pipeline. Revisit if Windows user demand surfaces.

## Consequences

**Positive:**

- A working `noir` on PATH with **no system Node** and **no admin/sudo** — the biggest install-friction papercuts (Node version, global-prefix permissions) are gone.
- **Windows is first-class**, not "use Git Bash." PowerShell is the primary path; Scoop and npm are alternatives.
- The release pipeline is unchanged in shape — npm + SLSA provenance remain the source of truth; the installers are thin artifacts on top. Checksums + Sigstore attestation extend the existing trust model rather than inventing a new one.
- Self-update is **bounded and honest**: refuses silent downgrades, refuses on network failure (never claims "up to date" when the registry was unreachable), and has a hard kill-switch for environments that want updates to flow only through ops.
- `noir doctor` install row gives users a single command to see "what install am I on, is there a newer one, should I be on native" — without a network call.

**Negative:**

- **It is not a single binary.** Users who expected `noir` to be one file get a `~/.noir/` tree instead. The research showed a real single binary does not exist for this dependency set; the managed-Node tree is the honest expression of what the install actually is. The docs say this plainly (no "single binary" language).
- **The managed runtime is one more thing to keep current.** `noir update` re-provisions, but a major Node LTS bump (e.g. 22 → 24) is a future migration step. The `managedRuntimeVersion` field in `install.json` records what was provisioned so a future migration can detect drift.
- **winget/Chocolatey users have no native package manager path today.** They use `install.ps1`, Scoop, or npm. This is documented as a deliberate deferral, not an oversight.
- **Taps are stable-only.** Beta-channel users on Homebrew/Scoop must use npm directly. Documented in the Homebrew README and `installation.md`.

**Non-goals (explicitly out of scope for this decision):**

- A CLI-only bootstrap that provisions the managed Node runtime without `install.sh`/`install.ps1` — was originally deferred, but **shipped in the final C1 push** (`provisionManagedNode()` in `@noir-ai/core`, called by both `installManagedNode` and the shell scripts). The CLI can now bootstrap the runtime stand-alone; the shell scripts remain the recommended first-time entry point.
- Bundling `onnxruntime-node` into a single artifact — research-verified unsupported upstream.
- Auto-uninstalling the previous install method on migrate — explicitly never done without `--uninstall-prev`.
