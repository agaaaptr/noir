# packaging/homebrew/noir.rb — Homebrew formula for Noir.
#
# Noir (https://github.com/agaaaptr/noir) ships as the npm package
# `@noir-ai/cli` (bin: `noir`) and needs Node.js + native modules
# (better-sqlite3, sqlite-vec, onnxruntime-node). Because Noir needs Node,
# there is no standalone single-binary build; this formula uses the
# Node-for-Formula-Authors pattern (https://docs.brew.sh/Node-for-Formula-Authors):
# it depends on Homebrew's `node`, installs the npm package into `libexec`,
# and symlinks the `noir` bin into the Homebrew `bin`.
#
# After the first stable release, fill in `url` + `sha256` (and bump `version`)
# using the values from:
#   curl -sL https://registry.npmjs.org/@noir-ai/cli/latest | jq -r '.version, .dist.tarball, .dist.shasum'
#   shasum -a 256 <(curl -sL <tarball>)   # sha256 of the tarball
#
# Stable-only: Homebrew taps are single-channel. For the beta channel
# (`@noir-ai/cli@beta`), install via npm directly — see docs/installation.md.

class Noir < Formula
  desc "Discipline, context, and memory layer for any agentic CLI"
  homepage "https://github.com/agaaaptr/noir"
  # TODO(first-release): replace the placeholder url/sha256/version below with
  # the real tarball + checksum from the npm registry (instructions above).
  url "https://registry.npmjs.org/@noir-ai/cli/-/@noir-ai/cli-1.0.0.tgz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  version "1.0.0"
  license "MIT"

  # Noir requires Node >= 22 (the CLI's package.json `engines.node`).
  depends_on "node@22"

  # The native modules (better-sqlite3, sqlite-vec, onnxruntime-node) are
  # prebuilt for mac/linux on x64 + arm64. On the common macOS/Linux paths
  # `npm install` here is fast (it links prebuilt artifacts). On exotic
  # platforms it falls back to a source build and needs a C/C++ toolchain
  # (which Homebrew's `node` does not pull in); install Xcode CLT / build-essential first.
  def install
    # `Language::Node.std_npm_install_args(libexec)` produces:
    #   ["--prefix=#{libexec}", "--build-from-source", "--omit=dev", "--omit=peer",
    #    "--no-audit", "--no-fund", "--no-progress"]
    system "npm", "install", *Language::Node.std_npm_install_args(libexec)
    # Symlink every bin the package ships (today: just `noir`) into Homebrew's bin.
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  # Homebrew's `brew audit` / `brew test` runs this. Keep it offline (no daemon,
  # no model provider) — `noir --version` prints and exits without touching the
  # network. The version string is the npm version (e.g. "1.0.0").
  test do
    assert_match version.to_s, shell_output("#{bin}/noir --version")
  end
end
