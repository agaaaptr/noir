# Installing Noir

> The complete install reference. Every supported path, when to pick each, and what to do when something goes wrong. New here? The [README](../README.md) is the 30-second "what and why"; this page is the copy-pasteable reference.
>
> **TL;DR — recommended:**
> ```bash
> curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | bash
> ```
> Beta channel: append `| NOIR_CHANNEL=beta bash`. Pin a version: append `| NOIR_VERSION=1.2.3 bash`.

---

## What you're installing

Noir ships as the npm package **`@noir-ai/cli`** (bin: **`noir`**), with ten companion `@noir-ai/*` packages pulled in as dependencies. It is **not** a single binary — it is a Node.js program that builds a few **native modules** at install time:

| Native dep | Why |
|---|---|
| `better-sqlite3` | Embedded SQLite (the project-local store at `.noir/store/`). |
| `sqlite-vec` | 384-dim vector kNN over the same SQLite DB. |
| `onnxruntime-node` | The runtime behind the local embedder (`@huggingface/transformers`, `all-MiniLM-L6-v2`). |

Prebuilt binaries exist for **macOS / Linux / Windows on x64 + arm64**, so on the common platforms `install` is a link step, not a compile step. On exotic platforms you'll need a C/C++ toolchain — see [Troubleshooting](#troubleshooting).

Two release **channels** ship in parallel from `.github/workflows/release.yml`:

| Channel | npm dist-tag | How to ask for it | Version scheme |
|---|---|---|---|
| **Stable** | `latest` (the default) | `npm i @noir-ai/cli` | `X.Y.Z` |
| **Beta** | `beta` (opt-in) | `npm i @noir-ai/cli@beta` | `X.Y.Z-beta.N` |

The installer, `npm`, `npx`, and `pnpm`/`yarn`/`bun` flows below all support both channels. Homebrew is **stable-only**.

---

## Recommended: native installer (`curl | sh`)

A small POSIX/bash script (`scripts/install.sh`) that detects Node + npm, then runs `npm install -g @noir-ai/cli@<channel>` on your behalf. It is **idempotent** (re-running upgrades in place), prints a PATH hint when needed, and verifies with `noir --version` at the end.

```bash
# Stable (the default)
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | bash

# Beta channel
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_CHANNEL=beta bash

# Pin an exact version (overrides the channel)
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_VERSION=1.2.3 bash
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_VERSION=1.2.3-beta.1 bash
```

**What it does, step by step:**

1. Detects OS + arch (`uname -s` / `uname -m`) and prints them for diagnostics. The actual install delegates to npm, which handles platform selection.
2. Requires **Node ≥ 22** and **npm**. If Node is missing or too old, it stops with a clear message linking to https://nodejs.org and suggesting `nvm` / `fnm` / `brew install node`. It will **not** silently install Node for you.
3. Resolves the spec: `NOIR_VERSION` (if set) wins; otherwise `NOIR_CHANNEL` (default `latest`, or `beta`).
4. Detects the npm global prefix (`npm prefix -g`). If it isn't user-writable **and** you have passwordless sudo, it uses `sudo -E`; otherwise it bails with the exact command to fix the prefix. It never surprises you with a sudo password prompt.
5. Honors `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` (passed through to npm).
6. Runs `npm install -g @noir-ai/cli@<spec>`.
7. Verifies with `noir --version` and prints a PATH hint if `noir` isn't on PATH.

**Safer than blind `curl | sh`:** download, review, then run.

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh
less install.sh            # review it
bash install.sh            # then run it
```

The script lives at [`scripts/install.sh`](../scripts/install.sh) in this repo and is meant to be readable end-to-end.

---

## npm / pnpm / yarn / bun

If you already have a Node package manager you prefer, skip the script and install directly. **Global** install puts `noir` on your PATH; re-running the same command upgrades in place. Every command below lives in its own copy-pasteable fenced block.

At a glance (each command also appears in a block below):

| Tool | Stable | Beta |
|---|---|---|
| **npm** | `npm install -g @noir-ai/cli` | `npm install -g @noir-ai/cli@beta` |
| **pnpm** | `pnpm add -g @noir-ai/cli` | `pnpm add -g @noir-ai/cli@beta` |
| **yarn** (classic) | `yarn global add @noir-ai/cli` | `yarn global add @noir-ai/cli@beta` |
| **bun** | `bun add -g @noir-ai/cli` | `bun add -g @noir-ai/cli@beta` |

### npm

```bash
# stable
npm install -g @noir-ai/cli
# beta
npm install -g @noir-ai/cli@beta
```

### pnpm

```bash
# stable
pnpm add -g @noir-ai/cli
# beta
pnpm add -g @noir-ai/cli@beta
```

### yarn (classic)

```bash
# stable
yarn global add @noir-ai/cli
# beta
yarn global add @noir-ai/cli@beta
```

### bun

```bash
# stable
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
# stable
npx @noir-ai/cli init
# beta
npx @noir-ai/cli@beta init
```

**pnpm dlx** (pnpm)
```bash
# stable
pnpm dlx @noir-ai/cli init
# beta
pnpm dlx @noir-ai/cli@beta init
```

**yarn dlx** (yarn / Berry)
```bash
# stable
yarn dlx @noir-ai/cli init
# beta
yarn dlx @noir-ai/cli@beta init
```

**bunx** (bun)
```bash
# stable
bunx @noir-ai/cli init
# beta
bunx @noir-ai/cli@beta init
```

This is the right choice when you want to try Noir in a throwaway project without committing to a global install, or when you'll always invoke it through your package manager's runner.

---

## Homebrew (advanced, stable-only)

A Homebrew formula is maintained at [`packaging/homebrew/noir.rb`](../packaging/homebrew/noir.rb) with setup instructions in [`packaging/homebrew/README.md`](../packaging/homebrew/README.md).

```bash
brew tap agaaaptr/noir https://github.com/agaaaptr/homebrew-noir
brew install noir
```

| Aspect | Note |
|---|---|
| **When to use it** | You already manage your dev stack through Homebrew and want `brew upgrade` to own Noir's lifecycle. |
| **Channel** | **Stable only.** Taps are single-channel. For beta, use `npm i -g @noir-ai/cli@beta` (or any of the npm-family paths above). |
| **Heavier than npm** | The formula depends on Homebrew's `node` and builds the native modules against it, so `brew install` is materially heavier than `npm i -g` against an existing Node. |
| **Tap repo required** | The user must create `agaaaptr/homebrew-noir` and drop `Formula/noir.rb` in it — see [`packaging/homebrew/README.md`](../packaging/homebrew/README.md). The formula ships here ready-to-use. |

Pick Homebrew only if it matches your existing workflow. For everyone else, the [native installer](#recommended-native-installer-curl--sh) or [npm](#npm--pnpm--yarn--bun) path is lighter and supports both channels.

---

## Verify

After any install path, confirm the `noir` bin resolves and runs:

```bash
noir --version       # prints the installed version
noir doctor          # config / store / embedder / native-deps / provider status
```

`noir doctor` is the right next step on a fresh install: it checks the config schema, the SQLite store, the local embedder, the native dependencies, and the (optional) model provider config — all without making a network call. If anything is off, it says so plainly.

Then, from the project you want Noir to manage:

```bash
noir init            # scaffolds .noir/ + emits the 34 skills (33 builtins + 1 integration) + host wiring
```

`noir init` is idempotent — see [getting-started.md](getting-started.md) for the walkthrough.

---

## Requirements

| Requirement | Detail |
|---|---|
| **Node.js ≥ 22** | Noir's `package.json` declares `engines.node: ">=22"` (Node 20 reached EOL on 2026-04-30). The installer and CI use Node 22/24. |
| **npm** (or pnpm/yarn/bun) | The installer uses npm for portability; pnpm/yarn/bun are documented alternatives. |
| **Platform** | macOS, Linux, or Windows on **x64 or arm64** (native deps ship prebuilt). Other architectures fall back to a source build and need a C/C++ toolchain. |
| **Disk** | ~150 MB for the install (node_modules + prebuilt native binaries + the CLI build output). |
| **First-run model download** | The first time the context engine is used, the local embedder downloads the **~22 MB** `all-MiniLM-L6-v2` model **once** into `~/.noir/models/`. Cached after that; offline and private from then on. |

**Windows:** run from Git Bash, MSYS2, or WSL — the installer's `uname` detection covers MINGW/MSYS/Cygwin. A native PowerShell installer is not shipped; use `npm i -g @noir-ai/cli` in Node's bundled terminal if you prefer not to use the bash script.

---

## Troubleshooting

### `noir: command not found` after install

The npm global bin isn't on your PATH. Find it, then add it to your shell profile:

```bash
npm prefix -g              # e.g. /usr/local  or  ~/.npm-global
npm bin -g                 # e.g. /usr/local/bin  or  ~/.npm-global/bin
```

Add the bin to PATH (in `~/.zshrc`, `~/.bashrc`, or your shell's equivalent):

```bash
export PATH="$(npm bin -g):$PATH"
```

Start a new shell, then `noir --version`. The native installer prints this exact hint when it detects the issue.

A clean fix that avoids `sudo` entirely is to move npm's global prefix into your home directory:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
# add ~/.npm-global/bin to PATH, then re-run the installer
```

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

The npm global prefix (`npm prefix -g`, often `/usr/local`) isn't writable by your user. **Don't reach for `sudo npm install -g` reflexively** — it leaves root-owned files in your home dir's npm cache. Either:

1. **Move the prefix into your home dir** (recommended; see above), or
2. Re-run the native installer — it detects this case and prints the exact fix.

The installer only uses `sudo` itself when the prefix isn't user-writable **and** you have passwordless sudo configured; it never surprises you with a password prompt.

### Corporate proxy / self-signed TLS

Export the standard proxy env vars before running the installer or npm:

```bash
export HTTPS_PROXY=http://corp-proxy.example:3128
export HTTP_PROXY=http://corp-proxy.example:3128
export NO_PROXY=localhost,127.0.0.1
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

- **`prebuild-install` deprecation** — gone from `1.3.0-beta.7+`: Noir moved to `better-sqlite3@13` (an N-API rewrite) which removes `prebuild-install` entirely. If you still see it, you're on an older beta — upgrade.
- **`boolean@3.2.0` deprecation** — a harmless transitive dependency (`@huggingface/transformers` → `onnxruntime-node` → `global-agent` → `boolean`). There is no released upstream fix yet (tracked in [transformers.js#1730](https://github.com/huggingface/transformers.js/pull/1730)); it will disappear with the next `transformers` release that bumps `onnxruntime-node`. It is muted in Noir's own monorepo via `allowedDeprecatedVersions`.
- **`Unknown user config "python"`** — this comes from YOUR `~/.npmrc` (a legacy `python=` line for node-gyp), surfaced by pnpm 10's strict-config validation. It is not from Noir. With `better-sqlite3@13`'s N-API prebuilts, `python`/`node-gyp` are largely unnecessary; remove that line from `~/.npmrc`, or scope it to a project-local `.npmrc` if you genuinely need a source-compile fallback.
- **A native build (`node-gyp`/`make`) for `better-sqlite3`** — `better-sqlite3@13` is brand-new (2026-07-21); on the very newest Node a matching prebuilt may not be published yet, so it may compile from source (needs a C/C++ toolchain, and on macOS the Xcode Command Line Tools). The build succeeding is fine; prebuilt coverage will fill in.

---

## See also

- [getting-started.md](getting-started.md) — the post-install walkthrough: `noir init`, transports, your first session, switching full/quick SDD modes.
- [usage.md](usage.md) — the full reference: every command, the config schema, the `.noir/` + `~/.noir/` layout.
- [releasing.md](releasing.md) — how releases are cut, the beta-vs-stable channel model, and how CI derives the dist-tag from the branch.
