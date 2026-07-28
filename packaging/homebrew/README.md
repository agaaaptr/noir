# Homebrew formula for Noir

A future Homebrew tap for Noir, the discipline, context, and memory layer for any agentic CLI. **Not available yet:** this repository contains a maintainer template with a placeholder tarball URL and checksum, to be completed after Noir's first stable release. For all current installs, use the [native installer](../../docs/how-to/installation.md) or `npm i -g @noir-ai/cli`.

## What this is

- `Formula/noir.rb` — a template for a formula that will install `@noir-ai/cli` (the `noir` bin) via npm into the formula's `libexec`, then symlink `noir` into Homebrew's `bin`. It follows the standard [Node-for-Formula-Authors](https://docs.brew.sh/Node-for-Formula-Authors) pattern.
- Once published, the tap will be stable-only. For the **beta** channel (`@noir-ai/cli@beta`), use npm directly — see [docs/installation.md](../../docs/how-to/installation.md#npm--pnpm--yarn--bun).

## Why a tap is heavier than npm/npx (be honest before you choose this)

Noir is a Node.js program that builds/links **native modules** at install time:

- `better-sqlite3`, `sqlite-vec` — embedded SQLite + 384-dim vector kNN
- `onnxruntime-node` — pulled in by `@huggingface/transformers` for the local embedder

These are prebuilt for **mac/linux on x64 + arm64** (and Windows prebuilds exist for the npm install path). Under Homebrew they are built against **Homebrew's `node`**, not the system Node, which means:

- `brew install noir` triggers a Node + native-module install that is materially heavier than `npm i -g @noir-ai/cli` against an existing Node.
- On exotic platforms (no prebuild), the formula needs a C/C++ toolchain (`xcode-select --install` on macOS, `build-essential` on Debian/Ubuntu). The npm install path needs the same toolchain in that case; it just isn't Homebrew-specific.
- Each `brew upgrade noir` re-runs the npm install under the formula's `libexec`.

**Until the formula is published, use npm/npx.** After the first stable release, use the tap only if you already manage your dev stack through Homebrew and want `brew upgrade` to own Noir's lifecycle.

## Tap setup (create the tap repo first)

The formula is intentionally incomplete until the first stable npm release. Once its tarball URL and checksum are filled in, publish it through a tap repository. Homebrew expects a GitHub repo named `homebrew-<name>` (the `homebrew-` prefix is required) with the formula at `Formula/noir.rb`.

1. **Create the tap repo** (one-time, out of scope here): create a **public** GitHub repository named `homebrew-noir` under your account or org. For Noir that is `agaaaptr/homebrew-noir`.
2. **Drop the formula in:** copy this repo's `packaging/homebrew/noir.rb` to `Formula/noir.rb` in the tap repo (the path `Formula/` matters — Homebrew looks there).
3. **Fill in the tarball + checksum** (only after the first stable npm release). Inside `Formula/noir.rb`, replace the placeholder `url` / `sha256` / `version` with the real values from the registry:

   ```bash
   curl -sL https://registry.npmjs.org/@noir-ai/cli/latest | \
     jq -r '.version, .dist.tarball, .dist.shasum'
   shasum -a 256 <(curl -sL "<tarball>")   # publish this as the formula's sha256
   ```

   Bump those three fields on every stable release. The beta channel never goes through this formula.

4. **Publish and install from the tap** (only after completing step 3):

   ```bash
   brew tap agaaaptr/noir https://github.com/agaaaptr/homebrew-noir
   brew install noir
   noir --version     # verify
   ```

   Or one-shot without `brew tap`:

   ```bash
   brew install agaaaptr/noir/noir
   ```

## Upgrading

```bash
brew update && brew upgrade noir
```

`brew upgrade` re-runs `npm install` into the formula's `libexec` against whatever `version` + `url` the formula declares, so it reflects whatever the tap repo has published — not `npm latest`. Update the tap repo's `Formula/noir.rb` to ship a new version through Homebrew.

## Troubleshooting

- **`Error: noir: no such file or directory` after install** — the formula's `bin.install_symlink` failed; re-run `brew reinstall noir`. Almost always a transient npm registry issue during the install step.
- **Native-module build failure on first install** — install the build toolchain first (`xcode-select --install` on macOS; `sudo apt install build-essential` on Debian/Ubuntu), then `brew reinstall noir`. The common macOS/Linux paths use prebuilds and never hit this.
- **`node` not on PATH after `brew install noir`** — `node@22` is a keg-only dependency; Homebrew prints the symlink instruction. Run `brew link --overwrite node@22` if you also want `node` on PATH system-wide.

## See also

- [docs/installation.md](../../docs/how-to/installation.md) — current install paths (native installer, npm/pnpm/yarn/bun, npx) and the Homebrew availability status.
- [docs/releasing.md](../../docs/how-to/releasing.md) — how a stable release is cut and how the formula's `version` + `sha256` should be refreshed each release.
