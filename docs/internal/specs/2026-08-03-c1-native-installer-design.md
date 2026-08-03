# C1 Native Installer + Migration + Self-Update (spec)

> Capability-01 (Package Distribution & Release Management) delta. Makes the **native installer the genuinely recommended path** — not prose — by shipping a managed-Node runtime, a migration command that preserves settings, a self-update surface, a real Windows path, a real Homebrew formula, and a trust/verification pipeline. Companion decision: ADR-0005.
>
> This is the reference for the implementation plan (`docs/internal/plans/2026-08-03-c1-native-installer.md`). Direction: `docs/roadmap/capability-01-package-distribution.md`.

## Goal

Replace the current **npm-delegating** `scripts/install.sh` (which requires Node ≥ 22 + npm and delivers only via `npm install -g`) with a **managed-Node native installer** that:

- is a genuinely recommended, tested path on **macOS / Linux / Windows**;
- lets users on any other install method migrate to it **in one command** while **preserving every setting**;
- self-updates cleanly (`noir update`) with a cached, async, configurable startup version check;
- ships **real** Homebrew, Scoop, and PowerShell distribution paths;
- hardens the trust pipeline (pinned installers, checksums, GitHub Artifact Attestations).

All commits stay **local on `develop`** until the publish phase (a separate, later milestone).

## Why (grounded in audit + research)

- Today `scripts/install.sh` is a thin `npm install -g` delegator (install.sh:9). It **requires Node ≥ 22 + npm**, which is the #1 install failure; it fetches from the **mutable `main` branch**; and it has **no integrity verification** beyond TLS.
- Windows has **no native path**: docs say "run from Git Bash/MSYS2/WSL" (installation.md:206).
- There is **no `noir update`/`migrate`**, no startup version check, no install-provenance detection, no TUI migration messaging (capability-01 Gap / backlog:68–73).
- **Single binary is not feasible** with the three native modules (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`): Node SEA and Bun-compile cannot run N-API addons from a blob — they must be extracted to disk and `process.dlopen()`ed (nodejs/help#5129, seabox), and `onnxruntime-node` is ~270 MB installed. The pragmatic native path is **managed-Node** (volta/fnm-style): a pinned Node LTS in `~/.noir/runtime/`, `@noir-ai/cli` in an isolated prefix, and a shim. The three native deps keep shipping as **prebuilt** npm artifacts — zero compiler, platform matrix handled by the upstream ecosystems.
- Claude Code is the reference: native installer is now the recommended path, npm is deprecated-but-kept for version pinning, `claude install` migrates npm→native preserving config, `claude doctor` reports install method + auto-update status, and a one-time startup notice nudges npm users.

## Scope (5 parts)

### P1 — Managed-Node runtime layout + shim

Layout under the existing `~/.noir/` global home (already the single user-scoped Noir home, `packages/core/src/layout.ts`):

```
~/.noir/
├── runtime/<version>/       # managed Node LTS (e.g. 22.x) + bundled npm, downloaded once
├── cli/                     # isolated npm prefix where @noir-ai/cli is installed
│   └── lib/node_modules/@noir-ai/cli
├── bin/noir                 # the SHIM — the only thing on PATH (symlink/script)
├── daemon.json              # existing daemon record (untouched)
├── install.json             # NEW: single source of truth for install method (P3)
└── models/                  # existing embedder cache (untouched)
```

- **The shim is the only contract.** It ensures the managed `node` + the isolated prefix's `NODE_PATH` are used before anything else.
- **Data dir is never touched** by install/reinstall/update. Because native and npm read the *same* `~/.noir/` + project `.noir/`, settings are preserved **by construction** — there is no "copy config" step that could fail.
- The three native deps (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`) are installed from **prebuilt** npm artifacts into a real `node_modules` on a real Node — the exact environment all three require. No compiler, no bundler hacks.
- **Idempotent**: re-running the installer is a no-op or an upgrade-in-place.
- **PATH**: the installer offers to add `~/.noir/bin` to PATH; it never touches `~/.npmrc`, never needs `sudo`, and never conflicts with the npm global prefix.
- **Managed-Node download**: pinned Node LTS matching `engines >=22` and the `better-sqlite3@13` prebuilds; cached under `~/.noir/runtime/<version>/`. First download ~25 MB; reused across installs.

### P2 — `noir install` (alias `noir migrate`)

One command to move to the native path from any other method, preserving settings and staying safe:

```bash
noir install [channel|version]     # native (default: latest)
noir install --list                # list detected install methods + versions
noir install --uninstall-prev      # OPTIONAL: after success, remove the previous method
```

- `noir migrate` is an alias (mirrors `claude migrate-installer`).
- Already-native → no-op / upgrade-in-place.

**Detection (read-only; never depends on PATH order — uses `which -a`):**

| Method | Detect | Uninstall (only with `--uninstall-prev`) |
|---|---|---|
| npm | `npm ls -g @noir-ai/cli` + `npm prefix -g` | `npm uninstall -g @noir-ai/cli` |
| pnpm | `pnpm list -g` | `pnpm remove -g @noir-ai/cli` |
| yarn classic | `yarn global list` | `yarn global remove @noir-ai/cli` |
| bun | `bun pm ls -g` | `bun rm -g @noir-ai/cli` |
| Homebrew | `brew list --versions noir` / `brew --prefix noir` | `brew uninstall noir` |
| Scoop | `scoop which noir` / `scoop status` | `scoop uninstall noir` |
| other | report "unknown manager", don't guess | — |

**Flow (safety-first):**
1. Detect all methods (read-only).
2. **Version-assert**: if the target is *older* than a detected install, warn hard + require confirmation (downgrade-via-migration is almost always a mistake).
3. **Stage + self-test**: install native to a staging location, then self-test `noir --version` + `noir doctor` **before** swapping.
4. **Atomic swap**: write the new shim to temp → rename. The old binary keeps running until done (free rollback).
5. **Never auto-uninstall**: print "to finish: `npm uninstall -g @noir-ai/cli`" and offer `--uninstall-prev`. Rollback = reinstall from the previous manager.
6. **Persist install-method** to `~/.noir/install.json` (single source of truth).

**Settings preservation (non-negotiable):** migrate the bin, leave `~/.noir/` + project `.noir/` completely alone. Never delete `~/.noir/`, `~/.noir/models/`, `daemon.json`, or any project store.

**TUI migration banner (nudge, not nag):** detect alternate installs once per install-channel per version (cached in `~/.noir/install.json`), not every run. Non-modal home-menu banner: "noir installed via npm — consider `noir install` for the native path (auto-update, no npm prefix/PATH issues)." Dismiss persists; no repeat for that version.

### P3 — `noir update` + async version check + doctor row

**`noir update [channel|version]`** — self-update via the same install method:
```bash
noir update                  # update to latest via the active method
noir update beta             # beta channel
noir update 1.6.1            # pin
noir update --check          # check for updates without changing anything
```
- Detect the active method from `~/.noir/install.json`; reinstall via that method (npm → `npm install -g`, native → managed-Node reinstall, homebrew/scoop → manager command).
- Idempotent; atomic (write-temp-rename); version-assert (no downgrade unless explicitly pinned, with warning).

**Async version check (cached, configurable, off in CI):** one helper `checkForUpdate()` on the non-blocking startup path (only `noir`, `noir status`, `noir doctor`, home menu). Cache in `~/.noir/update-cache.json` `{ lastCheckAt, latestVersion, channel }`, TTL default **24 h**, network timeout ~2 s, **fail = silent** (never crash/block). Skipped when `CI=true`, `NOIR_DISABLE_UPDATE_CHECK`, or non-TTY; no print under `--no-input`/`--quiet`.

**Config** (`update:` block in `.noir/config.yml`, following the additive `.default({})` pattern of `daemon:`/`rules:`):
```yaml
update:
  checkEnabled: true      # default true
  checkIntervalHours: 24  # default 24
  channel: latest         # latest | beta
  minVersion: 1.6.0       # floor — update never installs below this
  display: notice         # notice (default) | silent
```

**`noir doctor` row `install`** (new, replacing nothing): `method` (npm/native/homebrew/scoop/unknown), installed vs known-latest (from update-cache, **no live network call**), recommendation (`native recommended` when method ≠ native; `update available` when a newer version exists). Severity **always `ok`/`warn`, never `fail`** (install method must not fail health). Honesty: doctor reads the cache only; `noir update --check` is what does network I/O.

**`~/.noir/install.json`** (single source of truth):
```json
{ "method": "native", "version": "1.6.0", "channel": "latest",
  "installedAt": "2026-08-03T15:00:00.000Z", "managedRuntimeVersion": "22.x.y" }
```
Written by install.sh/install.ps1, `noir install`, `noir update`; read by `noir update`, `noir doctor`, TUI banner. One file, re-derived from filesystem truth (avoids Claude Code's stale-installMethod bug).

**Security:** `update.minVersion` floor; env kill-switches `NOIR_DISABLE_UPDATE_CHECK` (off checks) and `NOIR_DISABLE_UPDATES` (block all update paths, enterprise); channels isolated (update beta never touches latest); self-update never overwrites data.

### P4 — install.ps1 + Scoop + Homebrew + docs

**`scripts/install.ps1`** (native PowerShell — the canonical Windows path):
```powershell
powershell -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"
```
- Full parity with install.sh (`NOIR_CHANNEL`/`NOIR_VERSION`/proxy; Node ≥ 22 + npm detection — though managed-Node handles Node itself; install to `%LOCALAPPDATA%\noir` / `~\.noir\bin`, no sudo; verify `noir --version`).
- `install.sh` **redirects on Windows**: when MINGW/MSYS/CYGWIN is detected, print the `install.ps1` one-liner and exit instead of running a bash-wrapped npm install.

**Scoop manifest** → community bucket (`ScoopInstaller/Main`), pointing at the npm tarball with `hash`; per-user, no admin. Documented **manual-update** (Scoop does not auto-update).

**Homebrew formula** (`packaging/homebrew/noir.rb`): real `url`/`sha256`/`version` from the npm tarball; use `std_npm_args` (current Homebrew helper — `std_npm_install_args` is the older one); `depends_on "node@22"`; offline-only `test` block; **`brew audit --strict` clean**; documented manual-update (`brew upgrade noir`).

**Docs (user-facing, no drift — living-docs principle):**
- `docs/how-to/installation.md` — full matrix: **native (recommended)** / npm / pnpm / yarn / bun / npx / Homebrew / Scoop / Windows (PowerShell). "What you're installing" updated (managed-Node, not single binary). Windows: install.ps1 is the primary path, drop "must use Git Bash/MSYS2/WSL". Update "currently resolves to" to real versions.
- `docs/getting-started.md`, `README.md`, `docs/reference/cli.md` (new commands), `docs/reference/config.md` (`update:` block).
- `docs/how-to/releasing.md` + `packaging.md` — new release flow (checksums/attestation/installer).

**Roadmap + records (following existing pattern):**
- `docs/roadmap/capability-01-package-distribution.md` — status updates, acceptance criteria, new file references.
- `docs/roadmap/STATUS.md` + `roadmap.manifest.yaml` — C1 status + active capability/slice; keep in sync.
- `docs/roadmap/releases.md` — version targets + narrative.
- `docs/roadmap/backlog.md` — move shipped items to "History of resolutions".
- `CHANGELOG.md` (root) — new entry.
- `docs/decisions/0005-native-installer-managed-node.md` — new ADR (direction change).
- Fix the stale `docs/reference/cli-auto.md` reference in `docs/roadmap/capability-02-cli-runtime.md`.

Verify with `pnpm docs:validate` (broken links + stale version refs + registry integrity) — green before done.

### P5 — Trust/verification + release pipeline

- **Pinned installers**: move the fetch from `raw.githubusercontent.com/main/install.sh` (mutable) to **tagged** `releases/download/vX.Y.Z/install.sh` (and `.ps1`) — the Astral/uv model.
- **SHA256SUMS per release**: covers install.sh, install.ps1, Homebrew tarball, Scoop zip. Verifier is **fail-closed** (download artifact → verify checksum → run).
- **GitHub Artifact Attestations**: extend the existing `id-token: write` + `--provenance` to attest installer scripts + checksum file (`gh attestation verify <file> --repo agaaaptr/noir`), reusing the SLSA/GitHub-OIDC already in place.
- **`release.yml`**: add a step to generate installer artifacts + SHA256SUMS + attestation after the npm publish (consistent with the existing "Update release registry" → "Regenerate docs" → "Commit" → "Create GitHub Release" steps). Versioned installers become assets on the GitHub Release.
- **CI matrix**: add `windows-latest` to `ci.yml` `verify` (ubuntu/macos today); add an **install-smoke-test** job running `install.sh`/`install.ps1` on each OS → `noir --version` + `noir doctor`. This verifies native-deps prebuilds exist per platform (esp. Windows arm64, unverified today) and that the installer truly works per-OS.
- **Atomic writes**: all binary/shim writes go temp → atomic rename (never in-place). Required on macOS (code-sign inode-taint → SIGKILL), Windows (file-locking), and for a daemon running during upgrade. Apply the same to `writeDaemonRecord` (`packages/daemon/src/lifecycle.ts` — currently a direct `writeFileSync`).

## Acceptance

- [ ] `noir install` (and its alias `noir migrate`) detects all six managers (read-only), migrates to native preserving settings (data dir untouched), version-asserts, self-tests before swap, never auto-uninstalls, and persists to `~/.noir/install.json`. Both the primary name and the alias resolve to the same behavior and are tested.
- [ ] `noir update` self-updates via the active method; `noir update --check` works without changing anything; async version check is cached (24 h), off in CI, silent on failure, configurable via `update:`.
- [ ] `noir doctor` reports an `install` row (method, known-latest from cache, recommendation) with `ok`/`warn` severity only.
- [ ] `install.ps1` works from cmd.exe/PowerShell/Git Bash via `powershell -c`; `install.sh` redirects Windows to it.
- [ ] Homebrew formula is real (`url`/`sha256`/`version`, `std_npm_args`, audit-clean); Scoop manifest ships to the community bucket.
- [ ] Installer fetches are pinned (tagged paths); `SHA256SUMS` + Artifact Attestations exist per release.
- [ ] `ci.yml` includes `windows-latest` + an install smoke-test on each OS.
- [ ] All user-facing + roadmap docs updated with no misleading info; `pnpm docs:validate` green.
- [ ] All commits are **local on `develop`** (no push); publish is a separate later phase.
- [ ] Full gate green: `pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm docs:validate`.

## Out of scope

- **Single-binary build** (Bun compile / Node SEA) — infeasible with the three native modules; parked unless the embedder moves to WASM (a product decision, not distribution).
- **winget / Chocolatey / distro packages (apt/dnf/apk)** — explicitly deferred/omitted (recorded in capability-01).
- **GPG/cosign signatures** on artifacts — hardening phase, later (minimal-first chosen: checksums + pinned + attestation now).
- **Cloud sync / team features** — v2.0.
- **The `daemon start --detach` / per-project `daemon.json`** backlog items — separate slices.

## Risks & mitigations

- **Native-prebuild fragility** (`better-sqlite3@13` is new, 2026-07-21): CI smoke-test install on all 6 platforms (mac/win/linux × x64/arm64) at every release; pin native dep versions.
- **`onnxruntime-node` size (~270 MB installed)**: document it prominently; make the local embedder lazy/optional (follow-up) to shrink the cold path.
- **`pnpm approve-builds` gate**: keep `onlyBuiltDependencies` in root package.json; surface the exact approve command in docs.
- **Migration misdetection → wrong data**: read-only detection, never auto-uninstall, version-assert, leave data dir untouched.
- **Mutable-branch installer**: versioned/tagged installers + attestation.
- **PATH shadowing after migration** (Claude Code's #41806/#27910): install.sh/ps1 and `noir install` emit a PATH-precedence hint (`hash -r` / check `which -a noir`); install-method is re-derived from filesystem truth.

## Test additions

- `install.json` read/write round-trip; method detection per manager (mocked commands); version-assert; staging+self-test; atomic swap (temp→rename); idempotent re-run; no-auto-uninstall.
- `noir update` via each method (mocked); `--check`; async version-check cache/TTL/CI-off/silent-fail; config `update:` parsing.
- doctor `install` row (ok/warn only, cache-only, no network).
- `writeDaemonRecord` atomic write.
- install smoke-test (CI): each OS runs installer → `noir --version` + `noir doctor`.

## Implementation notes (2026-08-03)

- Spec-first, per repo convention (this doc). Implementation plan follows in `docs/internal/plans/2026-08-03-c1-native-installer.md`.
- Design approved in 5 sections; decisions: managed-Node native (research-verified), Windows = PowerShell + Scoop (winget/Chocolatey deferred), Full-C1 scope, minimal-then-harden verification, commits local on develop.
