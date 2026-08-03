#!/usr/bin/env bash
# scripts/install.sh — the recommended way to install Noir.
#
# Noir is the discipline, context, and memory layer for any agentic CLI
# (https://github.com/agaaaptr/noir). It ships as the npm package
# `@noir-ai/cli` (bin: `noir`) and needs Node.js + native modules
# (better-sqlite3, sqlite-vec, onnxruntime-node). There is no single-binary
# build yet, so this installer is an honest delegator: it detects node/npm,
# then runs `npm install -g @noir-ai/cli@<channel|version>`.
#
# Quick start:
#   curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_CHANNEL=beta bash
#   curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_VERSION=1.2.3 bash
#
# Download-then-review (safer than blind curl|sh):
#   curl -fsSL -o install.sh https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh
#   less install.sh && bash install.sh
#
# Env knobs:
#   NOIR_CHANNEL  npm dist-tag to install. Default: latest. Set to `beta` for the beta channel.
#   NOIR_VERSION  Pin an exact version (e.g. 1.0.0 or 1.0.0-beta.1). Overrides NOIR_CHANNEL.
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY  Passed through to npm verbatim.
#
# Re-running this script upgrades in place (idempotent). Tested with bash; no
# non-POSIX coreutils are required.

set -euo pipefail

PACKAGE="@noir-ai/cli"
REPO_URL="https://github.com/agaaaptr/noir"
NODEJS_URL="https://nodejs.org/"

# --- Output helpers (NO_COLOR / CI → plain) -------------------------------------
if [[ -n "${NO_COLOR:-}" || -n "${CI:-}" ]] || [[ ! -t 1 ]]; then
  C_RESET=""; C_BLUE=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""
else
  C_RESET=$'\033[0m'; C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'
  C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_DIM=$'\033[2m'
fi

info()  { printf "%s==>%s %s\n" "$C_BLUE" "$C_RESET" "$*"; }
note()  { printf "%s   %s%s\n" "$C_DIM" "$*" "$C_RESET"; }
good()  { printf "%s✓%s %s\n" "$C_GREEN" "$C_RESET" "$*"; }
warn()  { printf "%s!%s %s\n" "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()   { printf "%s✗%s %s\n" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# --- OS + arch detection (diagnostics only; npm handles the platform) -----------
detect_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin)            os="macos" ;;
    Linux)             os="linux" ;;
    MINGW*|MSYS*|CYGWIN*) os="windows"
      # C1: on Windows the canonical path is the native PowerShell installer.
      # Don't run a bash-wrapped npm install here — redirect instead.
      warn "Windows detected - use the native PowerShell installer:"
      warn "  powershell -c \"irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex\""
      exit 0
      ;;
    *)                 os="unknown:$(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)   arch="x64" ;;
    aarch64|arm64)  arch="arm64" ;;
    i386|i686)      arch="ia32" ;;
    armv7l)         arch="arm" ;;
    *)              arch="unknown:$(uname -m)" ;;
  esac
  note "Detected platform: ${os}/${arch} (npm handles the actual install)."
}

# --- Require node (>=22) + npm --------------------------------------------------
require_node() {
  command -v node >/dev/null 2>&1 || die "Node.js is not installed.
    Noir needs Node >= 22. Install it from ${NODEJS_URL}
    or use a version manager: 'nvm' (https://github.com/nvm-sh/nvm),
    'fnm' (https://github.com/Schniz/fnm), or 'brew install node'.
    This installer will not install Node for you."
  command -v npm >/dev/null 2>&1 || die "npm is not installed (it ships with Node).
    Install Node >= 22 from ${NODEJS_URL} and retry."

  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$major" -lt 22 ]]; then
    die "Node $(node --version) is too old — Noir requires Node >= 22.
      Upgrade: https://nodejs.org/ (or nvm/fnm/'brew upgrade node')."
  fi
  good "Node $(node --version) + npm $(npm --version) found."
}

# --- Resolve the package specifier (@latest | @beta | @<version>) ---------------
resolve_spec() {
  if [[ -n "${NOIR_VERSION:-}" ]]; then
    echo "${PACKAGE}@${NOIR_VERSION}"
    return
  fi
  # Capture once: NOIR_CHANNEL is unset by default, so we must NOT reference it
  # bare under `set -u` after the case has matched. `:-latest` defaults safely.
  local channel="${NOIR_CHANNEL:-latest}"
  case "$channel" in
    latest|beta) echo "${PACKAGE}@${channel}" ;;
    *) die "NOIR_CHANNEL='${channel}' is invalid. Use 'latest' or 'beta'." ;;
  esac
}

# --- Pass proxies through to npm (npm also reads npm_config_proxy) --------------
export_proxies() {
  : "${HTTP_PROXY:="${http_proxy:-}"}";  export HTTP_PROXY
  : "${HTTPS_PROXY:="${https_proxy:-}"}"; export HTTPS_PROXY
  : "${NO_PROXY:="${no_proxy:-}"}";       export NO_PROXY
  [[ -z "${HTTPS_PROXY:-}" ]] || note "Honoring HTTPS_PROXY."
}

# --- Decide if sudo is needed (only if prefix isn't user-writable + we can sudo)
maybe_sudo_for() {  # $1 = npm global prefix
  local prefix="$1"
  if [[ -w "$prefix" ]]; then
    echo ""
  elif [[ "$(id -u)" -eq 0 ]]; then
    echo ""            # already root
  elif sudo -n true 2>/dev/null; then
    echo "sudo"        # passwordless sudo available
  else
    echo ""            # don't surprise-prompt; print a hint instead
  fi
}

# --- Main install ---------------------------------------------------------------
main() {
  info "Installing ${PACKAGE} via npm."
  detect_platform
  require_node
  export_proxies

  local spec prefix sudo_prefix npm_bin
  spec="$(resolve_spec)"
  prefix="$(npm prefix -g 2>/dev/null || npm config get prefix 2>/dev/null || echo "")"
  [[ -n "$prefix" ]] || die "Could not determine the npm global prefix.
    Set it with 'npm config set prefix <dir>' and re-run."
  note "npm global prefix: ${prefix}"
  note "Target spec:       ${spec}"

  sudo_prefix="$(maybe_sudo_for "$prefix")"
  if [[ -z "$sudo_prefix" && ! -w "$prefix" && "$(id -u)" -ne 0 ]]; then
    # Don't surprise the user with a password prompt — explain and bail.
    die "The npm global prefix (${prefix}) is not writable by you.
      Re-run with sudo (NOT recommended):
        sudo HTTP_PROXY=\"${HTTP_PROXY:-}\" HTTPS_PROXY=\"${HTTPS_PROXY:-}\" npm install -g ${spec}
      Or fix the prefix once (recommended):
        mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global
        then ensure '~/.npm-global/bin' is on your PATH and re-run this installer."
  fi

  info "Running: ${sudo_prefix:+sudo }npm install -g ${spec}"
  if [[ -n "$sudo_prefix" ]]; then
    # Preserve proxy env across sudo (sudo scrubs env by default).
    sudo -E npm install -g "$spec"
  else
    npm install -g "$spec"
  fi
  good "Installed ${spec}."

  # --- PATH hint + verify -------------------------------------------------------
  # `npm bin -g` was removed in npm 9; derive the global bin dir from the prefix.
  npm_bin="${prefix}/bin"
  if command -v noir >/dev/null 2>&1; then
    good "noir is on PATH at: $(command -v noir)"
    if noir --version >/dev/null 2>&1; then
      good "Verified: $(noir --version)"
    fi
  else
    warn "noir is installed but NOT on your PATH."
    note "Add the npm global bin to your shell profile:"
    note "  export PATH=\"${npm_bin}:\$PATH\""
    note "Then start a new shell and run: noir --version"
  fi

  printf "\n%sNext steps:%s\n" "$C_BLUE" "$C_RESET"
  note "  noir init            # scaffold .noir/ + emit builtin skills + host wiring"
  note "  noir doctor          # config / store / native-deps health check"
  note "Docs: ${REPO_URL}#readme"
}

main "$@"
