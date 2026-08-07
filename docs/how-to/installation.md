# Installing Noir

> The complete install reference. Every supported path, when to pick each, and what to do when something goes wrong. New here? The [README](../README.md) is the 30-second "what and why"; this page is the copy-pasteable reference.
>
> **TL;DR — recommended (native installer):**
>
> **macOS / Linux**
> ```bash
> curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | bash
> ```
> **Windows (PowerShell)**
> ```powershell
> powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"
> ```
>
> <!-- noir:doc:status -->
**Latest stable:** `1.9.2` (npm dist-tag `latest` — `npm i @noir-ai/cli` resolves here)
**Current beta:** `1.9.2-beta.1` (npm dist-tag `beta` — `npm i @noir-ai/cli@beta` to opt in)
**Source version:** `1.9.3` (clean SemVer in `packages/*/package.json`)

*Last auto-generated: 2026-08-07T10:03:47.393Z*
<!-- /noir:doc:status -->
>
> Pin a version with `NOIR_VERSION=<VERSION>` (POSIX) or `$env:NOIR_VERSION='<VERSION>'` (PowerShell).

---

## What you're installing

Noir ships as the npm package **`@noir-ai/cli`** (bin: **`noir`**), with ten companion `@noir-ai/*` packages pulled in as dependencies. It is **not a single binary** — it is a Node.js program that builds a few **native modules** at install time:

| Native dep | Why |
|---|---|
| `better-sqlite3` | Embedded SQLite (the project-local store at `.noir/store/`). |
| `sqlite-vec` | 384-dim vector kNN over the same SQLite DB. |
| `onnxruntime-node` | The runtime behind the local embedder (`@huggingface/transformers`, `all-MiniLM-L6-v2`). |

Prebuilt binaries exist for **macOS / Linux / Windows on x64 + arm64**, so on the common platforms `install` is a link step, not a compile step. On exotic platforms you'll need a C/C++ toolchain — see [Troubleshooting](#troubleshooting).

### What the native installer actually does

The "native installer" is **not** a single-binary build — it provisions a **managed Node.js runtime** under `~/.noir/` (or `%USERPROFILE%\.noir\` on Windows) and installs `@noir-ai/cli` into an isolated prefix, then writes a `noir` shim at `~/.noir/bin/noir`. Concretely it lays down:

| Path | What |
|---|---|
| `~/.noir/runtime/v<version>/` | A pinned Node 22.x LTS runtime (used by the shim, isolated from your system Node). |
| `~/.noir/cli/lib/node_modules/@noir-ai/cli/` | The CLI package + its 10 companion packages. |
| `~/.noir/bin/noir` (POSIX) / `noir.cmd` (Windows) | The only PATH contract — a shim that invokes the managed Node against the isolated CLI entry. |
| `~/.noir/install.json` | The install record (`method`, `version`, `channel`, `installedAt`, `managedRuntimeVersion`). `noir doctor` reads it; `noir update`/`noir migrate` write it. |

You get a working `noir` on PATH with **no system Node prerequisite** and **no admin/sudo** — the runtime is in your home directory. The native deps (`better-sqlite3`, `sqlite-vec`, `onnxruntime-node`) still resolve to their **prebuilt** binaries for the common platforms; on exotic platforms they fall back to a source build (see [Troubleshooting](#troubleshooting)).

Two release **channels** ship in parallel from `.github/workflows/release.yml`:

| Channel | npm dist-tag | How to ask for it | Version scheme |
|---|---|---|---|
| **Default (`latest`)** | `latest` | `npm i @noir-ai/cli` | `X.Y.Z` stable release |
| **Beta** | `beta` (opt-in) | `npm i @noir-ai/cli@beta` | `X.Y.Z-beta.N` |

The installer, `npm`, `npx`, and `pnpm`/`yarn`/`bun` flows below all support both channels. Homebrew is stable-only; Scoop is single-channel; for beta on those managers use npm directly.

---

## Recommended: native installer

A small script (`scripts/install.sh` on POSIX, `scripts/install.ps1` on Windows) that provisions a managed Node 22.x runtime and installs `@noir-ai/cli` into an isolated prefix under `~/.noir/`. It is **idempotent** (re-running upgrades in place), prints a PATH hint when needed, and verifies with `noir --version` at the end.

### macOS / Linux (`install.sh`)

```bash
# Default (latest channel)
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | bash

# Beta channel
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_CHANNEL=beta bash

# Pin an exact version (overrides the channel)
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_VERSION=1.6.0 bash
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_VERSION=1.6.0-beta.1 bash
```

**What it does, step by step:**

1. Detects OS + arch (`uname -s` / `uname -m`) and prints them for diagnostics.
2. Provisions a managed Node 22.x runtime under `~/.noir/runtime/v<version>/` (the shim uses it; no system Node prerequisite). If the runtime is already provisioned, this is a no-op.
3. Resolves the spec: `NOIR_VERSION` (if set) wins; otherwise `NOIR_CHANNEL` (default `latest`, or `beta`).
4. Installs `@noir-ai/cli@<spec>` into `~/.noir/cli/` via the managed `npm` with `--prefix` (isolated; never the system global; never `sudo`).
5. Writes the `~/.noir/bin/noir` shim (POSIX bash → managed node + isolated entry).
6. Honors `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (passed through to npm).
7. Verifies with `noir --version` (via the shim) and prints a PATH hint if `noir` isn't on PATH.
8. Records the install in `~/.noir/install.json` (`method: native`).

### Windows (`install.ps1` — PowerShell)

Windows is a first-class install path. The PowerShell installer mirrors `install.sh` and writes a `noir.cmd` shim:

```powershell
# Default (latest channel)
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"

# Beta channel
$env:NOIR_CHANNEL='beta'; powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"

# Pin a version
$env:NOIR_VERSION='1.6.0'; powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"
```

It provisions the runtime under `%USERPROFILE%\.noir\runtime\node\node.exe`, installs into `.noir\cli\`, writes the `.noir\bin\noir.cmd` shim (the only PATH contract), and writes `.noir\install.json`. If the managed runtime isn't provisioned yet, it falls back to a system `node`/`npm` ≥ 22 if present. There is **no need for Git Bash, MSYS2, or WSL** — run the PowerShell one-liner from a normal PowerShell prompt.

**Safer than blind `curl | sh` / `irm | iex`:** download, review, then run.

```bash
# POSIX
curl -fsSL -o install.sh https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh
less install.sh            # review it
bash install.sh            # then run it
```

```powershell
# Windows
curl.exe -fsSL -o install.ps1 https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1
Get-Content install.ps1 | less           # review it
powershell -ExecutionPolicy Bypass -File install.ps1
```

The scripts live at [`scripts/install.sh`](../../scripts/install.sh) and [`scripts/install.ps1`](../../scripts/install.ps1) in this repo and are meant to be readable end-to-end.

### Trust & verification (pinned installers, checksums, attestation)

Every release publishes the installers as **release artifacts** with a `SHA256SUMS` file and a **Sigstore build-time attestation** (the same SLSA provenance predicate npm publishes with). To verify an installer against the release that produced it:

```bash
# 1. Download the installer + SHA256SUMS from the GitHub Release (or use curl above).
# 2. Verify the checksum matches:
shasum -a 256 install.sh            # compare to the install.sh line in SHA256SUMS

# 3. Verify the build-time attestation (binds the file to this repo's CI run):
gh attestation verify install.sh --repo agaaaptr/noir
```

The `SHA256SUMS` file pins both `install.sh` and `install.ps1`; `gh attestation verify` checks the cryptographic attestation GitHub Actions minted for the file at publish time. Both are generated by the `release.yml` job that runs on every tag push — see [releasing.md](releasing.md#2c-installer-artifacts-checksums-attestation).

---

## Migrate an existing install (`noir install` / `noir migrate`)

If you already installed Noir via npm/pnpm/yarn/bun/Homebrew/Scoop and want to move to the native (managed-Node) path without losing settings, run:

```bash
noir install            # or: noir migrate   (alias, mirrors `claude migrate-installer`)
```

`noir install` detects every Noir install on the system (`--list` to see them), provisions the native path, and writes `~/.noir/install.json` with `method: native`. Your `.noir/` project directory, `~/.noir/` user data, and config files are **never touched** — migration only changes where the `noir` bin resolves from. The previous install is left in place; to remove it as part of the same flow, pass `--uninstall-prev`:

```bash
noir install --uninstall-prev     # after the native swap, run the prior manager's uninstall
```

Noir **never auto-uninstalls** the previous method — the flag is explicit, and the suggested uninstall command is always printed when `--uninstall-prev` is omitted. After migration you may need to refresh your shell's command hash:

```bash
hash -r && which -a noir          # POSIX shells (clears stale `noir` path hash)
```

If you started from a non-native install, a **one-time migration banner** is shown on the next `noir` invocation(s), suggesting `noir migrate`. Dismiss it for the current version with `noir install --dismiss` (idempotent; persists in `install.json`'s `dismissedVersions`).

### Version-assert (never a silent downgrade)

`noir install`/`migrate` refuses to downgrade unless you pin the version explicitly. If the target spec resolves to an **older** version than what's recorded, the command fails with a clear message (under `--no-input`) or prompts an interactive confirm. To pin a specific older version on purpose:

```bash
noir install <VERSION>       # explicit positional pin
```

---

## Keep Noir current (`noir update`)

Once installed, update to the latest published version through the **active install method**:

```bash
noir update                 # native → re-provisions; npm/pnpm/yarn/bun/Homebrew/Scoop → reinstall via that manager
noir update --check         # one-shot: print the latest version vs. what you have, then exit
noir update 1.9.0           # pin a specific version (positional)
```

The check is **network-bound and timeout-bounded** (2s abort on the async path). When the registry is unreachable, `noir update` prints "Could not reach the registry." and exits — it never silently treats a network failure as "up to date".

### Async startup version check

By default, Noir runs a **non-blocking, cached** version check at startup (no more than once per 24h, configurable in `.noir/config.yml` under `update:`). The check writes `~/.noir/update.json` (last-check timestamp + latest known version + channel) and prints a **non-blocking notice** when a newer version exists. It never blocks the CLI, never makes a paid call, and silent under `--quiet`/CI/non-TTY.

Two env kill-switches are honored (independent of config):

| Env var | Effect |
|---|---|
| `NOIR_DISABLE_UPDATE_CHECK` | Suppresses the **background** startup check only. `noir update` still works. |
| `NOIR_DISABLE_UPDATES` | Hard kill-switch for the **entire self-update surface**. `noir update` refuses to run (exit 2) with a message pointing to your package manager / image rebuild. Use this to enforce "updates flow only through ops, never from inside the CLI". |

See [Configuration → `update:` block](../reference/config.md) for the schema and defaults.

---

## npm / pnpm / yarn / bun

If you already have a Node 22+ toolchain you prefer, skip the installer and install directly. **Global** install puts `noir` on your PATH; re-running the same command upgrades in place.

At a glance (each command also appears in a block below):

| Tool | Default (`latest`, currently `1.9.0`) | Beta |
|---|---|---|
| **npm** | `npm install -g @noir-ai/cli` | `npm install -g @noir-ai/cli@beta` |
| **pnpm** | `pnpm add -g @noir-ai/cli` | `pnpm add -g @noir-ai/cli@beta` |
| **yarn** (classic) | `yarn global add @noir-ai/cli` | `yarn global add @noir-ai/cli@beta` |
| **bun** | `bun add -g @noir-ai/cli` | `bun add -g @noir-ai/cli@beta` |

### npm

```bash
# default/latest (currently 1.9.0)
npm install -g @noir-ai/cli
# beta
npm install -g @noir-ai/cli@beta
```

### pnpm

```bash
# default/latest (currently 1.9.0)
pnpm add -g @noir-ai/cli
# beta
pnpm add -g @noir-ai/cli@beta
```

### yarn (classic)

```bash
# default/latest (currently 1.9.0)
yarn global add @noir-ai/cli
# beta
yarn global add @noir-ai/cli@beta
```

### bun

```bash
# default/latest (currently 1.9.0)
bun add -g @noir-ai/cli
# beta
bun add -g @noir-ai/cli@beta
```

> **pnpm note:** pnpm gates native-module builds behind `pnpm approve-builds`. If `pnpm add -g @noir-ai/cli` prints a prompt about `onnxruntime-node` / `better-sqlite3` / `sqlite-vec`, run `pnpm approve-builds` and re-run. The native modules will not function until approved.

> **Yarn Berry note:** Yarn 2+ removed first-class `global`. Use `yarn dlx @noir-ai/cli` (one-shot, below) or stick with the classic `yarn global add`.

---

## One-shot (no install)

Run Noir once without adding anything to your PATH. Each tool fetches the package on first use and caches it. Append `@beta` for the beta channel.

**npx** (npm)
```bash
# default/latest (currently 1.9.0)
npx @noir-ai/cli init
# beta
npx @noir-ai/cli@beta init
```

**pnpm dlx** (pnpm)
```bash
# default/latest (currently 1.9.0)
pnpm dlx @noir-ai/cli init
# beta
pnpm dlx @noir-ai/cli@beta init
```

**yarn dlx** (yarn / Berry)
```bash
# default/latest (currently 1.9.0)
yarn dlx @noir-ai/cli init
# beta
yarn dlx @noir-ai/cli@beta init
```

**bunx** (bun)
```bash
# default/latest (currently 1.9.0)
bunx @noir-ai/cli init
# beta
bunx @noir-ai/cli@beta init
```

This is the right choice when you want to try Noir in a throwaway project without committing to a global install, or when you'll always invoke it through your package manager's runner.

---

## Homebrew (macOS)

A real Homebrew formula ships at [`packaging/homebrew/noir.rb`](../../packaging/homebrew/noir.rb), using the Node-for-Formula-Authors pattern: it depends on Homebrew's `node@22`, installs `@noir-ai/cli` into the formula's `libexec`, and symlinks `noir` into the Homebrew `bin`. The `url`/`sha256`/`version` are the real values from the published 1.8.0 npm tarball (immutable).

```bash
brew tap agaaaptr/noir
brew install noir
brew upgrade noir          # upgrade path
```

Homebrew taps are **stable-only** (single-channel). For the **beta** channel, install via npm directly (`npm i -g @noir-ai/cli@beta`). Each `brew upgrade noir` re-runs the npm install under the formula's `libexec`. See the [Homebrew README](../../packaging/homebrew/README.md) for the tap setup and the "heavier than npm" tradeoff.

---

## Scoop (Windows)

A Scoop manifest ships at [`packaging/scoop/noir.json`](../../packaging/scoop/noir.json). It depends on `nodejs-lts` and shims `dist/bin.js` as `noir`:

```powershell
scoop bucket add agaaaptr https://github.com/agaaaptr/noir
scoop install noir
scoop update noir          # upgrade path
```

Scoop is **single-channel** and tracks the stable `latest` tarball; for the beta channel use npm directly.

---

## Verify

After any install path, confirm the `noir` bin resolves and runs:

```bash
noir --version       # prints the installed version
noir doctor          # config / store / embedder / native-deps / provider / install status
```

`noir doctor` is the right next step on a fresh install. It checks the config schema, the SQLite store, the local embedder, the native dependencies, the (optional) model provider config, and — since C1 — an **install row** that reports the detected install method (`method=native` / `npm` / `pnpm` / …), the installed version, the latest-known version from the update cache, and a non-blocking advisory when the install isn't on the recommended native path. The install row is **advisory only** (`ok`/`warn`, never `fail`) and makes **no live network call** — it reads `~/.noir/install.json` and the update cache. None of these checks makes a network call. If anything is off, it says so plainly.

Then, from the project you want Noir to manage:

```bash
noir init            # scaffolds .noir/ + emits the 34 skills (33 builtins + 1 integration) + host wiring
```

`noir init` is idempotent — see [getting-started.md](../getting-started.md) for the walkthrough.

---

## Requirements

| Requirement | Detail |
|---|---|
| **Node.js ≥ 22** *(only if you bypass the native installer)* | The native installer provisions a managed Node 22.x runtime for you. If you install via npm/pnpm/yarn/bun directly, your system Node must be ≥ 22 (Node 20 reached EOL on 2026-04-30). Noir's `package.json` declares `engines.node: ">=22"`. |
| **npm** (or pnpm/yarn/bun) | Required only if you bypass the native installer. The native installer uses its managed npm internally. |
| **Platform** | macOS, Linux, or Windows on **x64 or arm64** (native deps ship prebuilt). Other architectures fall back to a source build and need a C/C++ toolchain. |
| **Disk** | ~150 MB for the install (node_modules + prebuilt native binaries + the CLI build output). |
| **First-run model download** | The first time the context engine is used, the local embedder downloads the **~22 MB** `all-MiniLM-L6-v2` model **once** into `~/.noir/models/`. Cached after that; offline and private from then on. |

**Windows:** the PowerShell installer (`install.ps1`) is the primary path — run it from a normal PowerShell prompt. There is **no need for Git Bash, MSYS2, or WSL**. The Scoop manifest is the alternative Windows path. If you prefer npm directly, `npm i -g @noir-ai/cli` works in any Node-bundled terminal.

---

## Troubleshooting

### `noir: command not found` after install

The `noir` bin isn't on your PATH.

- **Native installer** — it installs the shim at `~/.noir/bin/noir` (POSIX) or `%USERPROFILE%\.noir\bin\noir.cmd` (Windows). Add that directory to PATH:

  ```bash
  # POSIX (add to ~/.zshrc / ~/.bashrc)
  export PATH="$HOME/.noir/bin:$PATH"
  ```
  ```powershell
  # Windows PowerShell (user PATH, persistent)
  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ";$env:USERPROFILE\.noir\bin", 'User')
  ```

  The installer prints this exact hint when it detects the issue.

- **npm/pnpm/yarn/bun** — find the global bin, then add it to PATH:

  ```bash
  npm prefix -g              # e.g. /usr/local  or  ~/.npm-global
  npm bin -g                 # e.g. /usr/local/bin  or  ~/.npm-global/bin
  ```

  A clean fix that avoids `sudo` entirely is to move npm's global prefix into your home directory:

  ```bash
  mkdir -p ~/.npm-global
  npm config set prefix ~/.npm-global
  # add ~/.npm-global/bin to PATH, then re-run the installer
  ```

Start a new shell, then `noir --version`.

### Native-module build failure on exotic platforms

If you're not on mac/linux x64/arm64, `better-sqlite3` / `sqlite-vec` / `onnxruntime-node` fall back to a source build. That needs a C/C++ toolchain:

```bash
# macOS
xcode-select --install

# Debian / Ubuntu
sudo apt install build-essential python3

# Fedora / RHEL
sudo dnf groupinstall "Development Tools" python3
```

Then re-run the installer (or `npm install -g @noir-ai/cli`). On the common platforms you will never see this — the prebuild is a link step.

### `pnpm approve-builds` prompt on install

pnpm gates postinstall scripts behind an explicit approval. If you see a prompt about `onnxruntime-node` / `better-sqlite3` / `sqlite-vec`:

```bash
pnpm approve-builds
```

Approve the three native deps, then re-run `pnpm add -g @noir-ai/cli`. They are required — Noir's store and embedder depend on them.

### `EACCES: permission denied` writing to the global prefix

This only affects the npm/pnpm/yarn/bun path — the **native installer never needs sudo** (it installs into `~/.noir/`). For the npm path, the global prefix (`npm prefix -g`, often `/usr/local`) isn't writable by your user. **Don't reach for `sudo npm install -g` reflexively** — it leaves root-owned files in your home dir's npm cache. Either:

1. **Move the prefix into your home dir** (recommended; see above), or
2. **Switch to the native installer** (`curl | sh` / `irm | iex`) — it sidesteps the global prefix entirely.

### Corporate proxy / self-signed TLS

Export the standard proxy env vars before running the installer or npm:

```bash
export HTTPS_PROXY=http://corp-proxy.example:3128
export HTTP_PROXY=http://corp-proxy.example:3128
export NO_PROXY=localhost,127.0.0.1
```

```powershell
$env:HTTPS_PROXY='http://corp-proxy.example:3128'
$env:HTTP_PROXY='http://corp-proxy.example:3128'
$env:NO_PROXY='localhost,127.0.0.1'
```

The installer passes these through to npm verbatim. For self-signed TLS, configure npm directly: `npm config set cafile /path/to/corp-ca.pem` (or `npm config set strict-ssl false` only as a last resort, never in production).

### Beta installed but `noir --version` shows the stable version

Two `noir` installs on PATH — npm's global `latest` and `beta` resolve to the same bin name. Uninstall whichever you don't want:

```bash
npm uninstall -g @noir-ai/cli       # removes whichever dist-tag you installed
npm install -g @noir-ai/cli@beta    # reinstall the one you want
```

`which -a noir` lists every `noir` on PATH; the first one wins.

### Deprecation warnings during install

A couple of warnings may appear during `npm install -g @noir-ai/cli` — most are harmless and none come from Noir directly.

- **`prebuild-install` deprecation** — gone from `1.4.0-beta.1+`: Noir moved to `better-sqlite3@13` (an N-API rewrite) which removes `prebuild-install` entirely. If you still see it, you're on an older beta — upgrade.
- **`boolean@3.2.0` deprecation** — a harmless transitive dependency (`@huggingface/transformers` → `onnxruntime-node` → `global-agent` → `boolean`). There is no released upstream fix yet (tracked in [transformers.js#1730](https://github.com/huggingface/transformers.js/pull/1730)); it will disappear with the next `transformers` release that bumps `onnxruntime-node`. It is muted in Noir's own monorepo via `allowedDeprecatedVersions`.
- **`Unknown user config "python"`** — this comes from YOUR `~/.npmrc` (a legacy `python=` line for node-gyp), surfaced by pnpm 10's strict-config validation. It is not from Noir. With `better-sqlite3@13`'s N-API prebuilts, `python`/`node-gyp` are largely unnecessary; remove that line from `~/.npmrc`, or scope it to a project-local `.npmrc` if you genuinely need a source-compile fallback.
- **A native build (`node-gyp`/`make`) for `better-sqlite3`** — `better-sqlite3@13` is brand-new (2026-07-21); on the very newest Node a matching prebuilt may not be published yet, so it may compile from source (needs a C/C++ toolchain, and on macOS the Xcode Command Line Tools). The build succeeding is fine; prebuilt coverage will fill in.

---

## See also

- [getting-started.md](../getting-started.md) — the post-install walkthrough: `noir init`, transports, your first session, switching full/quick SDD modes.
- [cli.md](../reference/cli.md) — the full CLI reference (auto-generated from `noir --help`), incl. `install`, `migrate`, `update`.
- [config.md](../reference/config.md) — the configuration reference, incl. the `update:` block.
- [releasing.md](releasing.md) — how releases are cut, the beta-vs-stable channel model, and how CI generates installer artifacts + checksums + attestation.
