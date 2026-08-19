#!/usr/bin/env bash
# scripts/install.sh — the recommended way to install Noir.
#
# Noir is the discipline, context, and memory layer for any agentic CLI
# (https://github.com/agaaaptr/noir). It ships as the npm package
# `@noir-ai/cli` (bin: `noir`) and needs Node.js + native modules
# (better-sqlite3, sqlite-vec, onnxruntime-node). There is no single-binary
# build yet, so this installer is an honest delegator: it provisions a pinned
# managed Node 22 LTS into ~/.noir/runtime/v<version>/ (fail-closed SHA-256
# verified against nodejs.org's SHASUMS256.txt), then uses that node/npm to
# `npm install -g @noir-ai/cli@<channel|version>` into an isolated prefix
# (~/.noir/cli), and writes a shim at ~/.noir/bin/noir.
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
#   NOIR_CHANNEL          npm dist-tag to install. Default: latest. `beta` for the beta channel.
#   NOIR_VERSION          Pin an exact version (e.g. 1.0.0 or 1.0.0-beta.1). Overrides NOIR_CHANNEL.
#   NOIR_NODE_DIST_URL    Override the Node dist root (default: https://nodejs.org/dist).
#   NOIR_SKIP_NODE_PROVISION  Skip managed-Node provisioning; use system node >=22 only.
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY  Passed through to npm verbatim.
#
# Re-running this script upgrades in place (idempotent). Tested with bash; no
# non-POSIX coreutils are required.

set -euo pipefail

PACKAGE="@noir-ai/cli"
REPO_URL="https://github.com/agaaaptr/noir"
NODEJS_URL="https://nodejs.org/"

# --- Resolve the script's own dir so we can source node-version.env ----------
# When piped via `curl ... | bash`, ${BASH_SOURCE[0]} is EMPTY (the script is
# read from stdin, not a file), so dirname "" collapses to "." → SCRIPT_DIR=$PWD
# and the sibling node-version.env isn't found. Under `set -u` that also throws
# "BASH_SOURCE[0]: unbound variable" (reproduced on bash 3.2 + 5.x). So:
#   - when a real path is available, use it;
#   - when piped, leave SCRIPT_DIR empty and let load_node_env() fetch
#     node-version.env from the repo's raw URL (mirrors install.ps1's iex path).
SCRIPT_DIR=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

# --- Output helpers (NO_COLOR / CI → plain) ----------------------------------
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

# --- Source the shared Node version + dist URL (mirrors @noir-ai/core) -------
# node-version.env is plain KEY=VALUE (no `export`) so PowerShell can parse it
# too. We import it into the environment via `set -a` so subprocesses (curl,
# shasum) and downstream functions see the values.
#
# Two resolution modes (mirrors install.ps1's Load-NodeEnv):
#   - run from a file on disk: source the sibling node-version.env;
#   - piped via `curl ... | bash` (SCRIPT_DIR empty): fetch node-version.env
#     from the repo's raw URL — the one file that can't ride the stdin pipe.
#     The URL is pinned to the SAME branch as this script, so a `beta`-branch
#     install gets the matching version pin, never a main drift.
NODE_VERSION_ENV_URL="https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/node-version.env"
load_node_env() {
  local env_file="" content
  if [[ -n "$SCRIPT_DIR" ]]; then
    env_file="$SCRIPT_DIR/node-version.env"
    if [[ ! -f "$env_file" ]]; then
      die "scripts/node-version.env not found next to install.sh ($env_file).
        This file pins MANAGED_NODE_VERSION + NODE_DIST_BASE_URL and is required."
    fi
    content="$(cat "$env_file")"
  else
    # Piped-from-curl fallback: fetch node-version.env from the repo raw URL.
    require_cmd curl "Install it (macOS: brew install curl; linux: apt install curl)."
    note "Fetching node-version.env from ${NODE_VERSION_ENV_URL} ..."
    if ! content="$(curl -fsSL "$NODE_VERSION_ENV_URL" 2>/dev/null)"; then
      die "Failed to fetch node-version.env from ${NODE_VERSION_ENV_URL}.
        Piped installs need network to fetch the version pin. Run 'curl -fsSL -o install.sh <url>' then 'bash install.sh' instead."
    fi
  fi
  # shellcheck disable=SC1090
  set -a; eval "$content"; set +a
  # Allow the user / CI to override the dist root via the same env var the
  # core module honors (NOIR_NODE_DIST_URL). node-version.env provides the default.
  if [[ -z "${MANAGED_NODE_VERSION:-}" ]]; then
    die "scripts/node-version.env did not set MANAGED_NODE_VERSION."
  fi
  if [[ -z "${NODE_DIST_BASE_URL:-}" ]]; then
    die "scripts/node-version.env did not set NODE_DIST_BASE_URL."
  fi
}

# --- OS + arch detection -----------------------------------------------------
# Maps the running host to the exact tokens nodejs.org uses in its archive
# filenames: darwin/linux + x64/arm64, and `win` (NOT win32) for Windows.
# Returns "NODER_OS" and "NODER_ARCH" on stdout, or exits via die() on
# unsupported combinations (never silently pick a wrong archive).
detect_node_target() {
  local os arch
  case "$(uname -s)" in
    Darwin)            os="darwin" ;;
    Linux)             os="linux" ;;
    MINGW*|MSYS*|CYGWIN*)
      # C1: on Windows the canonical path is the native PowerShell installer.
      # Don't run a bash-wrapped provision here — redirect instead.
      warn "Windows detected - use the native PowerShell installer:"
      warn "  powershell -c \"irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex\""
      exit 0
      ;;
    *) die "unsupported OS for managed-Node provisioning: $(uname -s)." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "unsupported arch for managed-Node provisioning: $(uname -m)." ;;
  esac
  printf '%s\n%s\n' "$os" "$arch"
}

# --- ~ home (HOME, not the project's .noir/) ---------------------------------
noir_home() { printf '%s/.noir\n' "${HOME:?HOME is not set}"; }

# --- require a command, else die with a hint ---------------------------------
require_cmd() {  # $1 = cmd, $2 = hint
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not on PATH. $2"
}

# --- Provision managed Node into ~/.noir/runtime/v<version>/ ------------------
# Idempotent: if the runtime's bin/node already exists, reuse it. Otherwise:
# fetch SHASUMS256.txt + the archive, verify SHA-256 (fail-closed), extract to
# a staging dir, atomic-rename into v<version>/, and remove older v*/ dirs.
#
# On any failure, fall back to a system node >= 22 (warn) — never silent on
# an unsupported Node. Sets globals RUNTIME_NODE_BIN / RUNTIME_NPM_BIN /
# RUNTIME_SOURCE ('managed' | 'system') / RUNTIME_VERSION for the caller.
provision_node() {
  local target_os target_arch
  { read -r target_os; read -r target_arch; } < <(detect_node_target)
  note "Detected platform: ${target_os}/${target_arch}."

  local home runtime_root version_dir node_bin
  home="$(noir_home)"
  runtime_root="${home}/runtime"
  version_dir="${runtime_root}/v${MANAGED_NODE_VERSION}"
  node_bin="${version_dir}/bin/node"

  # Skip switch: caller asked to use system node only.
  if [[ -n "${NOIR_SKIP_NODE_PROVISION:-}" ]]; then
    note "NOIR_SKIP_NODE_PROVISION set; skipping managed-Node provisioning."
    use_system_node_fallback "NOIR_SKIP_NODE_PROVISION set"
    return
  fi

  # 1) Reuse: idempotent. Re-runs (noir init / upgrade) are no-ops.
  if [[ -x "$node_bin" ]]; then
    good "Reusing managed Node ${MANAGED_NODE_VERSION} at ${version_dir}."
    RUNTIME_NODE_BIN="$node_bin"
    RUNTIME_NPM_BIN="${version_dir}/bin/npm"
    RUNTIME_SOURCE="managed"
    RUNTIME_VERSION="$MANAGED_NODE_VERSION"
    cleanup_old_runtimes "$runtime_root" "v${MANAGED_NODE_VERSION}"
    return
  fi

  # 2) Download + verify + extract. Any error falls back to system node.
  local archive_basename archive_url shasums_url dist_base archive_ext
  dist_base="${NOIR_NODE_DIST_URL:-${NODE_DIST_BASE_URL:-https://nodejs.org/dist}}"
  dist_base="${dist_base%/}"  # trim trailing slash; we add it below
  archive_ext="tar.gz"
  archive_basename="node-v${MANAGED_NODE_VERSION}-${target_os}-${target_arch}.${archive_ext}"
  archive_url="${dist_base}/v${MANAGED_NODE_VERSION}/${archive_basename}"
  shasums_url="${dist_base}/v${MANAGED_NODE_VERSION}/SHASUMS256.txt"

  require_cmd curl "Install it (macOS: brew install curl; linux: apt install curl)."
  require_cmd shasum "It ships with macOS/perl; on linux install perl or 'dpkg -S shasum'."
  require_cmd tar "It ships with every OS; install 'tar'."

  info "Provisioning managed Node ${MANAGED_NODE_VERSION} (fail-closed SHA-256 verified)."
  note "Archive:  ${archive_url}"

  provision_download_verify_extract \
    "$runtime_root" "$version_dir" "$archive_basename" "$archive_url" "$shasums_url"
  if [[ "${MANAGED_PROVISIONED:-0}" == "1" ]]; then
    # Managed Node provisioned. Set the RUNTIME globals here (the helper is a
    # plain function in this scope, but it only sets the flag so nothing leaks).
    RUNTIME_NODE_BIN="${version_dir}/bin/node"
    RUNTIME_NPM_BIN="${version_dir}/bin/npm"
    RUNTIME_SOURCE="managed"
    RUNTIME_VERSION="$MANAGED_NODE_VERSION"
    return 0
  fi
  # The helper fell back to a system node (>=22) and already set RUNTIME_* to
  # it, or died fail-closed on no usable node. Either way, return 0 so `set -e`
  # in main() doesn't abort on the fallback success path.
  return 0
}

# --- Download + verify + extract (the inner part of provisioning) -------------
# Installs a `trap` whose command is a STRING that expands at EXIT time — the
# staging path is baked into the trap text, NOT referenced through a shell var.
# This avoids the trap-vs-scope trap: a `local` staging var is unset when the
# function returns (so a `trap 'rm -rf "$staging"' RETURN` would read an
# unbound var under `set -u`), and a `trap ... EXIT` inside a SUBSHELL would
# strand RUNTIME_* writes (a subshell can't set caller globals). Baking the
# path into the trap string keeps cleanup working AND keeps RUNTIME_* in the
# caller's scope.
# On success sets MANAGED_PROVISIONED=1 (and the staging dir is cleaned up by
# the trap on EXIT). On any failure it warns + falls back to a system node via
# use_system_node_fallback (which sets the RUNTIME_* globals) or dies
# fail-closed on no usable node.
provision_download_verify_extract() {  # $1=runtime_root $2=version_dir $3=archive_basename $4=archive_url $5=shasums_url
  local runtime_root="$1" version_dir="$2" archive_basename="$3" archive_url="$4" shasums_url="$5"
  local staging shasums_file archive_file expected_sha actual_sha extracted_dir
  MANAGED_PROVISIONED=0   # set to 1 on the managed-success path below
  # mktemp -d on the SAME filesystem as the rename target (runtime_root), so
  # the final rename is atomic (POSIX guarantees rename within a filesystem).
  mkdir -p "$runtime_root"
  staging="$(mktemp -d "${runtime_root}/.staging.${MANAGED_NODE_VERSION}.XXXXXX")"
  # Always clean up staging, even on success (the rename moves the payload out).
  # The trap command is a fixed string with the path inlined — no var deref at
  # trap-run time (which would be an unbound var after `local` loses scope).
  trap "rm -rf '$staging'" EXIT

  shasums_file="${staging}/SHASUMS256.txt"
  archive_file="${staging}/${archive_basename}"

  # 2a) Fetch SHASUMS256.txt (the manifest is GPG-signed upstream; we verify
  # the archive hash against the entry, which is the fail-closed gate).
  note "Fetching SHASUMS256.txt ..."
  if ! curl -fsSL "$shasums_url" -o "$shasums_file"; then
    warn "Failed to fetch SHASUMS256.txt (curl exit $?); falling back to system Node."
    # Fallback: resolves a system node (>=22) or exits fail-closed. On success
    # the RUNTIME_* globals are set here, so return 0 so main proceeds.
    use_system_node_fallback "SHASUMS256.txt fetch failed"
    return 0
  fi

  # 2b) Find the entry for OUR archive basename.
  expected_sha="$(awk -v f="$archive_basename" '
    $2 == f { print $1; exit }
    # Node SHASUMS lines may use the binary-mode form `<hex> *<name>`
    $2 == ("*" f) { print $1; exit }
  ' "$shasums_file")"
  if [[ -z "$expected_sha" || ${#expected_sha} -ne 64 ]]; then
    warn "No SHASUMS256.txt entry for ${archive_basename}; falling back to system Node."
    use_system_node_fallback "missing SHASUMS256.txt entry"
    return 0
  fi

  # 2c) Fetch the archive.
  note "Fetching archive (~25 MB) ..."
  if ! curl -fsSL "$archive_url" -o "$archive_file"; then
    warn "Failed to fetch Node archive (curl exit $?); falling back to system Node."
    use_system_node_fallback "archive fetch failed"
    return 0
  fi

  # 2d) Verify SHA-256 — FAIL-CLOSED. Never install an unverified archive.
  actual_sha="$(shasum -a 256 "$archive_file" | awk '{print $1}')"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    warn "Checksum mismatch for ${archive_basename}:"
    warn "  expected: ${expected_sha}"
    warn "  actual:   ${actual_sha}"
    warn "Refusing to install an unverified archive; falling back to system Node."
    use_system_node_fallback "checksum mismatch"
    return 0
  fi
  good "Checksum verified: ${expected_sha}"

  # 3) Extract into staging (produces staging/node-v<ver>-<os>-<arch>/).
  note "Extracting ..."
  if ! tar -xzf "$archive_file" -C "$staging" 2>/dev/null; then
    warn "tar extraction failed; falling back to system Node."
    use_system_node_fallback "tar extraction failed"
    return 0
  fi
  extracted_dir="${staging}/node-v${MANAGED_NODE_VERSION}-${target_os}-${target_arch}"
  if [[ ! -x "${extracted_dir}/bin/node" ]]; then
    warn "Extraction produced no bin/node at ${extracted_dir}; falling back to system Node."
    use_system_node_fallback "extraction incomplete"
    return 0
  fi

  # 4) Atomic rename into v<version>/. Remove a stale version_dir first so the
  # rename is unobstructed (concurrent provision / partial state).
  if [[ -e "$version_dir" ]]; then rm -rf "$version_dir"; fi
  mv "$extracted_dir" "$version_dir"
  good "Installed Node ${MANAGED_NODE_VERSION} → ${version_dir}"

  # 5) Cleanup older runtime dirs (keep current only).
  cleanup_old_runtimes "$runtime_root" "v${MANAGED_NODE_VERSION}"
  MANAGED_PROVISIONED=1

  return 0
}

# Remove ~/.noir/runtime/v*/ dirs other than the one named in $2. Best-effort.
cleanup_old_runtimes() {  # $1 = runtime_root, $2 = keep dir name (e.g. v22.23.2)
  local root="$1" keep="$2" entry
  [[ -d "$root" ]] || return 0
  for entry in "$root"/v*/; do
    [[ -d "$entry" ]] || continue
    local name; name="$(basename "$entry")"
    [[ "$name" == "$keep" ]] && continue
    rm -rf "$entry"
    note "Cleaned up old runtime: ${name}"
  done
}

# --- System-Node fallback -----------------------------------------------------
# Probes PATH for `node` >= 22; sets RUNTIME_* globals. Dies if no usable node.
use_system_node_fallback() {  # $1 = reason (for the warn message)
  local reason="${1:-managed-Node provisioning failed}"
  command -v node >/dev/null 2>&1 || die "${reason}; and no system Node on PATH.
    Noir needs Node >= 22. Install it from ${NODEJS_URL}
    or use a version manager: 'nvm' (https://github.com/nvm-sh/nvm),
    'fnm' (https://github.com/Schniz/fnm), or 'brew install node'."
  local major raw
  raw="$(node --version 2>/dev/null || echo v0)"
  major="${raw#v}"; major="${major%%.*}"
  if [[ -z "$major" || "$major" -lt 22 ]]; then
    die "${reason}; and system Node is ${raw} (< 22).
      Upgrade: https://nodejs.org/ (or nvm/fnm/'brew upgrade node')."
  fi
  warn "${reason}; using system Node ${raw} at $(command -v node)."
  RUNTIME_NODE_BIN="$(command -v node)"
  # npm lives next to node.
  if command -v npm >/dev/null 2>&1; then
    RUNTIME_NPM_BIN="$(command -v npm)"
  else
    die "npm is not installed (it ships with Node). Install Node >= 22 from ${NODEJS_URL} and retry."
  fi
  RUNTIME_SOURCE="system"
  RUNTIME_VERSION="system-${raw#v}"
}

# --- Resolve the package specifier (@latest | @beta | @<version>) -------------
resolve_spec() {
  if [[ -n "${NOIR_VERSION:-}" ]]; then
    echo "${PACKAGE}@${NOIR_VERSION}"
    return
  fi
  local channel="${NOIR_CHANNEL:-latest}"
  case "$channel" in
    latest|beta) echo "${PACKAGE}@${channel}" ;;
    *) die "NOIR_CHANNEL='${channel}' is invalid. Use 'latest' or 'beta'." ;;
  esac
}

# --- Pass proxies through to npm (npm also reads npm_config_proxy) ------------
export_proxies() {
  : "${HTTP_PROXY:="${http_proxy:-}"}";  export HTTP_PROXY
  : "${HTTPS_PROXY:="${https_proxy:-}"}"; export HTTPS_PROXY
  : "${NO_PROXY:="${no_proxy:-}"}";       export NO_PROXY
  [[ -z "${HTTPS_PROXY:-}" ]] || note "Honoring HTTPS_PROXY."
}

# --- Atomic write: write to a temp sibling, then rename ----------------------
atomic_write() {  # $1 = path, $2 = content
  local path="$1" content="$2" tmp
  mkdir -p "$(dirname "$path")"
  tmp="${path}.tmp.$$"
  printf '%s' "$content" > "$tmp"
  mv -f "$tmp" "$path"
}

# --- Ensure ~/.noir/bin is on PATH via shell profile -------------------------
# Detects the user's shell, finds the right profile file, and adds the Noir
# PATH export with a `# Noir CLI` marker — idempotent (won't duplicate).
# Falls back to ~/.profile for unknown shells; creates the file if missing.
#
# On macOS, the default shell since Catalina (10.15) is zsh, and Terminal.app
# + iTerm2 both launch login shells that read .zprofile or .zshrc. We prefer
# .zshrc (interactive, always read). On Linux, ~/.profile is the portable
# default; bash reads it from login shells.
NOIR_PATH_BLOCK="# Noir CLI
export PATH=\"\$HOME/.noir/bin:\$PATH\""

# fish has no `export` builtin — it uses `set -gx`. Emitting the POSIX export
# line into config.fish would print `fish: Unknown command: export` on every
# launch and never add the PATH. fish_add_path is the idiomatic, idempotent form.
NOIR_PATH_BLOCK_FISH="# Noir CLI
fish_add_path -g \$HOME/.noir/bin"

ensure_path_in_shell_profile() {
  local shell_name profile marker path_block
  shell_name="$(basename "${SHELL:-/bin/sh}")"

  # Pick the right profile file per shell. Fish has its own config layout AND
  # its own syntax; zsh/bash/ksh/dash all accept a POSIX export line.
  case "$shell_name" in
    zsh)  profile="${HOME}/.zshrc"; path_block="$NOIR_PATH_BLOCK" ;;
    # macOS bash login shells read ~/.bash_profile (not .bashrc); Linux distros
    # source .bashrc for interactive shells. Pick per-platform so the PATH block
    # lands in a file the login shell actually sources.
    bash)
      if [[ "$(uname -s)" == "Darwin" ]]; then
        profile="${HOME}/.bash_profile"
      else
        profile="${HOME}/.bashrc"
      fi
      path_block="$NOIR_PATH_BLOCK"
      ;;
    fish) profile="${HOME}/.config/fish/config.fish"; mkdir -p "$(dirname "$profile")"; path_block="$NOIR_PATH_BLOCK_FISH" ;;
    *)    profile="${HOME}/.profile"; path_block="$NOIR_PATH_BLOCK" ;;  # portable POSIX fallback
  esac

  # Idempotent: skip if the marker comment is already present (tolerates
  # minor whitespace variations in the export line; the comment is the key).
  if [[ -f "$profile" ]] && grep -qF '# Noir CLI' "$profile" 2>/dev/null; then
    return 0
  fi

  # Append with a marker so the user knows where it came from (and so
  # re-running the installer doesn't duplicate the entry).
  info "Adding ~/.noir/bin to PATH in ${profile} ..."
  if [[ -f "$profile" ]]; then
    printf '\n%s\n' "$path_block" >> "$profile"
  else
    printf '%s\n' "$path_block" > "$profile"
  fi
  good "Added Noir to ${profile} (start a new shell or run 'source ${profile}' to apply)."
}

# --- Main install -------------------------------------------------------------
main() {
  load_node_env
  info "Installing ${PACKAGE} via npm."

  provision_node
  export_proxies

  local spec home cli_dir bin_dir shim cli_main ver record
  spec="$(resolve_spec)"
  home="$(noir_home)"
  cli_dir="${home}/cli"
  bin_dir="${home}/bin"
  mkdir -p "$cli_dir" "$bin_dir"
  note "Target spec:       ${spec}"
  note "Install prefix:    ${cli_dir}  (isolated; never the system global, no sudo)"
  note "Runtime node:      ${RUNTIME_NODE_BIN}  (${RUNTIME_SOURCE})"

  # Ensure the provisioned runtime's bin/ is on PATH for the npm install step.
  # npm's wrapper in the Node dist is `#!/usr/bin/env node` (bin/npm -> npm-cli.js),
  # so in a CLEAN environment (no system Node on PATH) it can't find a `node` to
  # exec unless the runtime dir precedes PATH. Only do this for a MANAGED runtime
  # (a system runtime's bin is already on PATH by construction). Setting PATH here
  # also scopes the node that runs npm's lifecycle scripts to the provisioned one.
  if [[ "$RUNTIME_SOURCE" == "managed" && -d "$(dirname "$RUNTIME_NODE_BIN")" ]]; then
    export PATH="$(dirname "$RUNTIME_NODE_BIN"):$PATH"
  fi

  # Install into the isolated prefix using the provisioned npm.
  info "Running: npm install -g ${spec} --prefix=${cli_dir}"
  if ! "$RUNTIME_NPM_BIN" install -g "$spec" "--prefix=${cli_dir}"; then
    die "npm install failed (exit $?).
      Re-run with NOIR_SKIP_NODE_PROVISION=1 to try the system Node instead."
  fi
  good "Installed ${spec}."

  # Shim: ~/.noir/bin/noir -> provisioned node + isolated prefix entry.
  cli_main="${cli_dir}/lib/node_modules/@noir-ai/cli/dist/bin.js"
  shim="${bin_dir}/noir"
  atomic_write "$shim" "#!/usr/bin/env bash
\"${RUNTIME_NODE_BIN}\" \"${cli_main}\" \"\$@\"
"
  chmod +x "$shim"

  # Verify via the provisioned node.
  ver="$("$RUNTIME_NODE_BIN" "$cli_main" --version 2>/dev/null || true)"
  if [[ -n "$ver" ]]; then
    good "Verified: noir ${ver}"
  else
    warn "Could not read 'noir --version' (the install may still be usable)."
  fi

  # Record install method: ~/.noir/install.json (same shape core's
  # writeInstallRecord() writes). Reflects which runtime backs this install
  # so `noir doctor` reports it accurately.
  local now channel managed_rev
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  channel="${NOIR_CHANNEL:-latest}"
  managed_rev="$RUNTIME_VERSION"
  record="$(printf '{"method":"native","version":"%s","channel":"%s","installedAt":"%s","managedRuntimeVersion":"%s"}\n' \
    "${ver:-0.0.0}" "$channel" "$now" "$managed_rev")"
  atomic_write "${home}/install.json" "$record"

  # PATH hint + verify. Automatically add ~/.noir/bin to the shell profile so
  # the next shell session picks up the native shim. Then check what `command -v
  # noir` resolves to RIGHT NOW — a previous install (nvm, npm global, Homebrew)
  # may shadow the new shim until the next shell.
  ensure_path_in_shell_profile

  local shim_ver resolved_noir
  shim_ver="$("$shim" --version 2>/dev/null || true)"
  if [[ -n "$shim_ver" ]]; then
    good "Shim verified: noir ${shim_ver} at ${shim}"
  fi
  if command -v noir >/dev/null 2>&1; then
    resolved_noir="$(command -v noir)"
    if [[ "$resolved_noir" == "$shim" ]]; then
      good "noir is on PATH at: ${resolved_noir}"
    else
      warn "noir currently resolves to an older install (${resolved_noir}), NOT the new shim."
      warn "~/.noir/bin was just added to your shell profile — start a new shell or run:"
      note "  export PATH=\"${bin_dir}:\$PATH\" && hash -r"
      note "Then verify: which noir"
      note "  Expected: ${bin_dir}/noir"
    fi
  else
    warn "noir is not on PATH yet. Start a new shell (or run 'source ${HOME}/.zshrc') to pick it up."
  fi

  printf "\n%sNext steps:%s\n" "$C_BLUE" "$C_RESET"
  note "  noir init            # scaffold .noir/ + emit builtin skills + host wiring"
  note "  noir doctor          # config / store / native-deps health check"
  note "Docs: ${REPO_URL}#readme"
}

main "$@"
