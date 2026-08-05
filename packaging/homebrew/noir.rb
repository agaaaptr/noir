# packaging/homebrew/noir.rb — Homebrew formula for Noir.
#
# Noir (https://github.com/agaaaptr/noir) ships as the npm package
# `@noir-ai/cli` (bin: `noir`) and needs Node.js + native modules
# (better-sqlite3, sqlite-vec, onnxruntime-node). Because Noir needs Node,
# there is no standalone single-binary build; this formula uses the
# Node-for-Formula-Authors pattern (https://docs.brew.sh/Node-for-Formula-Authors):
# it depends on Homebrew's `node@22`, installs the npm package into `libexec`,
# and symlinks the `noir` bin into the Homebrew `bin`.
#
# `url`/`sha256`/`version` are the REAL values from the 1.8.0 npm tarball
# (they are immutable once published). Refresh all three on each stable
# release:
#   curl -sL https://registry.npmjs.org/@noir-ai/cli/latest | \
#     jq -r '.version, .dist.tarball, .dist.integrity'
#   shasum -a 256 <(curl -sL "<tarball>")   # sha256 of the tarball
#
# Stable-only: Homebrew taps are single-channel. For the beta channel
# (`@noir-ai/cli@beta`), install via npm directly — see docs/installation.md.
#
# Must pass `brew audit --strict` — Homebrew's lines.rb cop forbids the older
# `std_npm_install_args` in favour of `std_npm_args`.

class Noir < Formula
  desc "Discipline, context, and memory layer for any agentic CLI"
  homepage "https://github.com/agaaaptr/noir"
  url "https://registry.npmjs.org/@noir-ai/cli/-/cli-1.8.0.tgz"
  sha256 "2c7ae8d47ce67db7f75f7d1bf4bcbe4b02864826c997088c8b3e5b048ed924b2"
  version "1.8.0"
  license "MIT"

  # Noir requires Node >= 22 (the CLI's package.json `engines.node`).
  depends_on "node@22"

  def install
    # `std_npm_args(prefix: libexec)` delegates to
    # `Language::Node.std_npm_install_args`, which produces roughly:
    #   ["--loglevel=silly", "--global", "--build-from-source",
    #    "--min-release-age=…", "--cache=#{HOMEBREW_CACHE}/npm_cache",
    #    "--ignore-scripts", "--prefix=#{libexec}", "<tarball>"]
    #
    # Two deliberate behaviours:
    #   * `--build-from-source` — Noir's native modules (better-sqlite3,
    #     sqlite-vec, onnxruntime-node) link against Homebrew's node@22, not a
    #     system-global prebuilt; the C/C++ toolchain comes from Homebrew's
    #     `node` / Xcode CLT / build-essential on first install.
    #   * `--ignore-scripts` — the tarball's postinstall is a no-op; install
    #     scripts are stripped from the packed package.json by the helper's
    #     `pack_for_installation`.
    # The helper passes a real tarball archive to `npm install` (never a
    # directory — `npm install <dir>` only symlinks, which would break
    # Homebrew's disposable buildpath), installs under `libexec`, then we
    # symlink every bin the package ships (today: just `noir`) into bin.
    system "npm", "install", *std_npm_args(prefix: libexec)
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  # Homebrew's `brew audit` / `brew test` runs this. Keep it offline (no daemon,
  # no model provider) — `noir --version` prints and exits without touching the
  # network. The version string is the npm version (e.g. "1.6.0").
  test do
    assert_match version.to_s, shell_output("#{bin}/noir --version")
  end
end
