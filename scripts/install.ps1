# scripts/install.ps1 - native PowerShell installer for Noir (Windows).
#
# Mirrors scripts/install.sh. Provisions a pinned managed Node 22 LTS into
# ~\.noir\runtime\v<version>\ (fail-closed SHA-256 verified against
# nodejs.org's SHASUMS256.txt), then uses that node/npm to
# `npm install -g @noir-ai/cli@<channel|version>` into an isolated prefix
# (~\.noir\cli), and writes a shim at ~\.noir\bin\noir.cmd.
#
# Quick start:
#   powershell -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"
#   powershell -c "$env:NOIR_CHANNEL='beta'; irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"
#   powershell -c "$env:NOIR_VERSION='1.2.3'; irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"
#
# Env knobs:
#   NOIR_CHANNEL            npm dist-tag to install. Default: latest. `beta` for the beta channel.
#   NOIR_VERSION            Pin an exact version (e.g. 1.0.0 or 1.0.0-beta.1). Overrides NOIR_CHANNEL.
#   NOIR_NODE_DIST_URL      Override the Node dist root (default: https://nodejs.org/dist).
#   NOIR_SKIP_NODE_PROVISION  Skip managed-Node provisioning; use system node >=22 only.
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY  Passed through to npm verbatim.
#
# Re-running this script upgrades in place (idempotent). Requires Windows
# PowerShell 5.1+ (ships with Windows 10/11) or PowerShell 7+.

# Stop on first error; treat errors as terminating so try/catch works.
$ErrorActionPreference = 'Stop'
# Suppress the IWR progress bar — on PS 5.1 it makes large downloads
# excruciatingly slow (and is noise under `iex` / CI).
$ProgressPreference = 'SilentlyContinue'

$Package  = '@noir-ai/cli'
$RepoUrl  = 'https://github.com/agaaaptr/noir'
$NodeJsUrl = 'https://nodejs.org/'

# --- Output helpers (plain when NO_COLOR/CI; colored otherwise) ---------------
# Defensively detect "no tty": under `iex`-from-pipe, $Host.UI.RawUI may be
# null/stubbed and reading .WindowSize can throw — wrap in try/catch.
$Script:Plain = $false
if ($env:NO_COLOR -or $env:CI) {
  $Script:Plain = $true
} else {
  try { if (-not $Host.UI.RawUI.WindowSize.Width) { $Script:Plain = $true } } catch { $Script:Plain = $true }
}
function Info { param([string]$Msg) if ($Script:Plain) { Write-Host "==> $Msg" } else { Write-Host "==> $Msg" -ForegroundColor Blue } }
function Note { param([string]$Msg) if ($Script:Plain) { Write-Host "    $Msg" } else { Write-Host "    $Msg" -ForegroundColor DarkGray } }
function Good { param([string]$Msg) if ($Script:Plain) { Write-Host "[ok] $Msg" } else { Write-Host "[ok] $Msg" -ForegroundColor Green } }
function Warn { param([string]$Msg) if ($Script:Plain) { Write-Host "[!] $Msg" } else { Write-Host "[!] $Msg" -ForegroundColor Yellow } }
function Die  { param([string]$Msg) { Write-Error $Msg; exit 1 } }

# --- Script dir (so we can locate node-version.env when run from disk) --------
# When piped through `iex`, $PSScriptRoot is empty — fall back to downloading
# node-version.env from the same raw URL. When run from disk, use the sibling file.
function Get-ScriptDir {
  if ($PSScriptRoot) { return $PSScriptRoot }
  # Piped-from-iex fallback: resolve via the installer's own raw URL.
  return $null
}

# --- Load MANAGED_NODE_VERSION + NODE_DIST_BASE_URL from node-version.env -----
# node-version.env is plain KEY=VALUE (no `export`) so both bash and PowerShell
# can parse it. We mirror @noir-ai/core's MANAGED_NODE_VERSION constant.
function Load-NodeEnv {
  param([string]$ScriptDir)

  $envFile = $null
  if ($ScriptDir) {
    $candidate = Join-Path $ScriptDir 'node-version.env'
    if (Test-Path $candidate) { $envFile = $candidate }
  }

  # Piped-via-iex fallback: fetch node-version.env from the repo raw URL.
  if (-not $envFile) {
    $rawUrl = 'https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/node-version.env'
    Note "Fetching node-version.env from $rawUrl ..."
    try {
      $text = Invoke-WebRequest -UseBasicParsing -Uri $rawUrl -ErrorAction Stop | Select-Object -ExpandProperty Content
    } catch {
      Die "Failed to fetch node-version.env from $rawUrl ($($_.Exception.Message)). Download install.ps1 to disk next to node-version.env instead."
    }
  } else {
    $text = Get-Content -Raw -Path $envFile
  }

  # Parse KEY=VALUE, skipping blank lines and `#` comments.
  $vars = @{}
  foreach ($line in $text -split "`n") {
    $line = $line.Trim()
    if (-not $line) { continue }
    if ($line.StartsWith('#')) { continue }
    $idx = $line.IndexOf('=')
    if ($idx -le 0) { continue }
    $k = $line.Substring(0, $idx).Trim()
    $v = $line.Substring($idx + 1).Trim()
    $vars[$k] = $v
  }
  if (-not $vars.ContainsKey('MANAGED_NODE_VERSION')) {
    Die 'node-version.env did not set MANAGED_NODE_VERSION.'
  }
  if (-not $vars.ContainsKey('NODE_DIST_BASE_URL')) {
    Die 'node-version.env did not set NODE_DIST_BASE_URL.'
  }
  return $vars
}

# --- Detect os/arch (Windows only; x64/arm64) --------------------------------
# nodejs.org Windows archive tokens are `win-x64` and `win-arm64`. We never
# silently pick a wrong archive.
function Detect-NodeTarget {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if (-not $arch) { $arch = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString() }
  switch ($arch) {
    'AMD64'     { return @{ os = 'win'; arch = 'x64' } }
    'Arm64'     { return @{ os = 'win'; arch = 'arm64' } }
    'X64'       { return @{ os = 'win'; arch = 'x64' } }
    default     { Die "unsupported Windows arch for managed-Node provisioning: $arch." }
  }
}

# --- ~\.noir home -------------------------------------------------------------
function Get-NoirHome {
  if ($env:NOIR_HOME) { return $env:NOIR_HOME }
  return Join-Path $HOME '.noir'
}

# --- Provision managed Node into ~\.noir\runtime\v<version>\ ------------------
# Idempotent: if the runtime's node.exe already exists, reuse it. Otherwise:
# fetch SHASUMS256.txt + the zip, verify SHA-256 (fail-closed), extract to a
# staging dir, atomic-rename into v<version>\, and remove older v*\ dirs.
#
# On any failure, fall back to a system node >= 22 (warn) — never silent on an
# unsupported Node. Sets script-scoped $Script:RuntimeNodeBin /
# $Script:RuntimeNpmBin / $Script:RuntimeSource / $Script:RuntimeVersion.
function Provision-Node {
  param([hashtable]$NodeEnv)

  $target = Detect-NodeTarget
  Note ("Detected platform: {0}/{1}." -f $target.os, $target.arch)

  $home2 = Get-NoirHome
  $runtimeRoot = Join-Path $home2 'runtime'
  $versionDir  = Join-Path $runtimeRoot "v$($NodeEnv.MANAGED_NODE_VERSION)"
  $nodeBin     = Join-Path $versionDir 'node.exe'

  # Skip switch: caller asked to use system node only.
  if ($env:NOIR_SKIP_NODE_PROVISION) {
    Note 'NOIR_SKIP_NODE_PROVISION set; skipping managed-Node provisioning.'
    Use-SystemNodeFallback -Reason 'NOIR_SKIP_NODE_PROVISION set'
    return
  }

  # 1) Reuse: idempotent. Re-runs (noir init / upgrade) are no-ops.
  if (Test-Path $nodeBin) {
    Good "Reusing managed Node $($NodeEnv.MANAGED_NODE_VERSION) at $versionDir."
    $Script:RuntimeNodeBin  = $nodeBin
    $Script:RuntimeNpmBin   = Join-Path $versionDir 'npm.cmd'
    $Script:RuntimeSource   = 'managed'
    $Script:RuntimeVersion  = $NodeEnv.MANAGED_NODE_VERSION
    Cleanup-OldRuntimes -RuntimeRoot $runtimeRoot -Keep "v$($NodeEnv.MANAGED_NODE_VERSION)"
    return
  }

  # 2) Download + verify + extract. Any error falls back to system node.
  # NOIR_NODE_DIST_URL overrides NODE_DIST_BASE_URL (mirrors install.sh + core).
  $distBase = $env:NOIR_NODE_DIST_URL
  if (-not $distBase) { $distBase = $NodeEnv.NODE_DIST_BASE_URL }
  $distBase = $distBase.TrimEnd('/')

  $archiveBasename = "node-v$($NodeEnv.MANAGED_NODE_VERSION)-$($target.os)-$($target.arch).zip"
  $archiveUrl      = "$distBase/v$($NodeEnv.MANAGED_NODE_VERSION)/$archiveBasename"
  $shasumsUrl      = "$distBase/v$($NodeEnv.MANAGED_NODE_VERSION)/SHASUMS256.txt"

  Info "Provisioning managed Node $($NodeEnv.MANAGED_NODE_VERSION) (fail-closed SHA-256 verified)."
  Note "Archive:  $archiveUrl"

  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  # Staging dir on the SAME volume as the rename target, so the final
  # Move-Item is atomic (NTFS rename within a volume is atomic).
  $staging = Join-Path $runtimeRoot ".staging.$($NodeEnv.MANAGED_NODE_VERSION).$([System.IO.Path]::GetRandomFileName())"
  New-Item -ItemType Directory -Force -Path $staging | Out-Null

  try {
    $shasumsFile = Join-Path $staging 'SHASUMS256.txt'
    $archiveFile = Join-Path $staging $archiveBasename

    # 2a) Fetch SHASUMS256.txt (the manifest is GPG-signed upstream; we verify
    # the archive hash against the entry, which is the fail-closed gate).
    Note 'Fetching SHASUMS256.txt ...'
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $shasumsUrl -OutFile $shasumsFile -ErrorAction Stop
    } catch {
      Warn "Failed to fetch SHASUMS256.txt ($($_.Exception.Message)); falling back to system Node."
      Use-SystemNodeFallback -Reason 'SHASUMS256.txt fetch failed'
      return
    }

    # 2b) Find the entry for OUR archive basename. Node SHASUMS lines look like
    # `<hex> *<filename>` (binary-mode asterisk) — strip any leading `*`.
    $expectedSha = $null
    foreach ($line in Get-Content -Path $shasumsFile) {
      $parts = $line -split '\s+', 2
      if ($parts.Length -lt 2) { continue }
      $hash = $parts[0]
      $name = $parts[1].Trim()
      if ($name.StartsWith('*')) { $name = $name.Substring(1) }
      if ($name -ceq $archiveBasename) { $expectedSha = $hash.ToLower(); break }
    }
    if (-not $expectedSha -or $expectedSha.Length -ne 64) {
      Warn "No SHASUMS256.txt entry for $archiveBasename; falling back to system Node."
      Use-SystemNodeFallback -Reason 'missing SHASUMS256.txt entry'
      return
    }

    # 2c) Fetch the archive.
    Note 'Fetching archive (~30 MB) ...'
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archiveFile -ErrorAction Stop
    } catch {
      Warn "Failed to fetch Node archive ($($_.Exception.Message)); falling back to system Node."
      Use-SystemNodeFallback -Reason 'archive fetch failed'
      return
    }

    # 2d) Verify SHA-256 — FAIL-CLOSED. Never install an unverified archive.
    $actualSha = (Get-FileHash -Algorithm SHA256 -Path $archiveFile).Hash.ToLower()
    if ($actualSha -ne $expectedSha) {
      Warn "Checksum mismatch for $archiveBasename:"
      Warn "  expected: $expectedSha"
      Warn "  actual:   $actualSha"
      Warn 'Refusing to install an unverified archive; falling back to system Node.'
      Use-SystemNodeFallback -Reason 'checksum mismatch'
      return
    }
    Good "Checksum verified: $expectedSha"

    # 3) Extract into staging (produces staging\node-v<ver>-win-<arch>\).
    Note 'Extracting ...'
    try {
      Expand-Archive -Path $archiveFile -DestinationPath $staging -Force -ErrorAction Stop
    } catch {
      Warn "Expand-Archive failed ($($_.Exception.Message)); falling back to system Node."
      Use-SystemNodeFallback -Reason 'extraction failed'
      return
    }
    $extractedDir = Join-Path $staging "node-v$($NodeEnv.MANAGED_NODE_VERSION)-$($target.os)-$($target.arch)"
    $extractedNode = Join-Path $extractedDir 'node.exe'
    if (-not (Test-Path $extractedNode)) {
      Warn "Extraction produced no node.exe at $extractedDir; falling back to system Node."
      Use-SystemNodeFallback -Reason 'extraction incomplete'
      return
    }

    # 4) Atomic rename into v<version>\. Remove a stale versionDir first so the
    # rename is unobstructed (concurrent provision / partial state).
    if (Test-Path $versionDir) { Remove-Item -Recurse -Force $versionDir }
    Move-Item -Path $extractedDir -Destination $versionDir
    Good "Installed Node $($NodeEnv.MANAGED_NODE_VERSION) -> $versionDir"

    # 5) Cleanup older runtime dirs (keep current only).
    Cleanup-OldRuntimes -RuntimeRoot $runtimeRoot -Keep "v$($NodeEnv.MANAGED_NODE_VERSION)"

    $Script:RuntimeNodeBin  = Join-Path $versionDir 'node.exe'
    $Script:RuntimeNpmBin   = Join-Path $versionDir 'npm.cmd'
    $Script:RuntimeSource   = 'managed'
    $Script:RuntimeVersion  = $NodeEnv.MANAGED_NODE_VERSION
  } finally {
    # Always clean up staging, even on success (the rename moved the payload out).
    if (Test-Path $staging) { Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue }
  }
}

# Remove ~\.noir\runtime\v*\ dirs other than the one named in $Keep. Best-effort.
function Cleanup-OldRuntimes {
  param([string]$RuntimeRoot, [string]$Keep)
  if (-not (Test-Path $RuntimeRoot)) { return }
  foreach ($entry in Get-ChildItem -Directory -Path $RuntimeRoot) {
    if ($entry.Name -eq $Keep) { continue }
    if ($entry.Name -notlike 'v*') { continue }
    Remove-Item -Recurse -Force $entry.FullName
    Note "Cleaned up old runtime: $($entry.Name)"
  }
}

# --- System-Node fallback -----------------------------------------------------
# Probes PATH for `node` >= 22; sets $Script:Runtime* globals. Dies if no usable
# node. `NOIR_SYSTEM_NODE_BIN` is a hard override (mirrors @noir-ai/core's test
# seam): when SET, the probe uses exactly that path; set to '' to force "none".
function Use-SystemNodeFallback {
  param([string]$Reason = 'managed-Node provisioning failed')

  $nodeBin = $null
  if ($null -ne $env:NOIR_SYSTEM_NODE_BIN) {
    if ($env:NOIR_SYSTEM_NODE_BIN -ne '') { $nodeBin = $env:NOIR_SYSTEM_NODE_BIN }
  } else {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { $nodeBin = $cmd.Source }
  }

  if (-not $nodeBin -or -not (Test-Path $nodeBin)) {
    Die "$Reason; and no system Node on PATH. Noir needs Node >= 22. Install it from $NodeJsUrl or use winget/scoop/nvm-windows."
  }

  # Read major version via the system node itself.
  $raw = & $nodeBin --version 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) {
    Die "$Reason; and system Node at $nodeBin failed to report a version."
  }
  $major = ($raw -replace '^v', '') -split '\.' | Select-Object -First 1
  $majorInt = 0
  if (-not ([int]::TryParse($major, [ref]$majorInt))) {
    Die "$Reason; and system Node reported an unparseable version '$raw'."
  }
  if ($majorInt -lt 22) {
    Die "$Reason; and system Node is $raw (< 22). Upgrade: $NodeJsUrl (or winget/scoop/nvm-windows)."
  }

  Warn "$Reason; using system Node $raw at $nodeBin."
  $Script:RuntimeNodeBin  = $nodeBin
  # npm lives next to node.
  $sibling = Join-Path (Split-Path $nodeBin) 'npm.cmd'
  if (Test-Path $sibling) {
    $Script:RuntimeNpmBin = $sibling
  } else {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
      $Script:RuntimeNpmBin = $npmCmd.Source
    } else {
      Die "npm is not installed (it ships with Node). Install Node >= 22 from $NodeJsUrl and retry."
    }
  }
  $Script:RuntimeSource  = 'system'
  $Script:RuntimeVersion = "system-$($raw -replace '^v', '')"
}

# --- Atomic write: write to a temp sibling, then rename ----------------------
function Write-Atomic {
  param([string]$Path, [string]$Content)
  $dir = Split-Path -Parent $Path
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  $tmp = "$Path.tmp-$PID"
  # Use explicit -Value (never a pipeline value — on PS >= 7.3 a null pipeline
  # value is a NO-OP for Set-Content, which would silently leave a STALE file).
  Set-Content -Path $tmp -Value $Content -Encoding ASCII -NoNewline
  Move-Item -Force $tmp $Path
}

# --- Resolve the package specifier (@latest | @beta | @<version>) -------------
function Resolve-Spec {
  if ($env:NOIR_VERSION) { return "@$($env:NOIR_VERSION)" }
  $ch = if ($env:NOIR_CHANNEL) { $env:NOIR_CHANNEL } else { 'latest' }
  if ($ch -ne 'latest' -and $ch -ne 'beta') { Die "NOIR_CHANNEL='$ch' is invalid. Use 'latest' or 'beta'." }
  return "@$ch"
}

# --- Main install -------------------------------------------------------------
function Main {
  $scriptDir = Get-ScriptDir
  $nodeEnv = Load-NodeEnv -ScriptDir $scriptDir

  Info "Installing $Package via npm."

  Provision-Node -NodeEnv $nodeEnv

  if ($env:HTTPS_PROXY) { Note 'Honoring HTTPS_PROXY.' }

  $spec    = Resolve-Spec
  $home2   = Get-NoirHome
  $cliDir  = Join-Path $home2 'cli'
  $binDir  = Join-Path $home2 'bin'
  New-Item -ItemType Directory -Force -Path $cliDir, $binDir | Out-Null
  Note "Target spec:       $Package$spec"
  Note "Install prefix:    $cliDir  (isolated; never the system global, no admin)"
  Note "Runtime node:      $($Script:RuntimeNodeBin)  ($($Script:RuntimeSource))"

  # Ensure the provisioned runtime dir is on PATH for the npm install step.
  # npm's wrapper in the Node dist is npm-cli.js invoked via node; in a CLEAN
  # environment (no system Node on PATH) it can't find `node` unless the runtime
  # dir precedes PATH. Only do this for a MANAGED runtime. Setting $env:Path here
  # also scopes the node that runs npm's lifecycle scripts to the provisioned one.
  if ($Script:RuntimeSource -eq 'managed') {
    $runtimeDir = Split-Path -Parent $Script:RuntimeNodeBin
    if (Test-Path $runtimeDir) {
      $env:Path = "$runtimeDir;$env:Path"
      Note "Runtime dir prepended to PATH (clean-env npm): $runtimeDir"
    }
  }

  # Install into the isolated prefix using the provisioned npm.
  Info "Running: npm install -g $Package$spec --prefix=$cliDir"
  & $Script:RuntimeNpmBin install -g "$Package$spec" "--prefix=$cliDir"
  if ($LASTEXITCODE -ne 0) {
    Die "npm install failed (exit $LASTEXITCODE). Re-run with NOIR_SKIP_NODE_PROVISION=1 to try the system Node instead."
  }
  Good "Installed $Package$spec."

  # Shim: ~\.noir\bin\noir.cmd -> provisioned node + isolated prefix entry.
  $cliMain = Join-Path $cliDir 'lib\node_modules\@noir-ai\cli\dist\bin.js'
  $shim    = Join-Path $binDir 'noir.cmd'
  Write-Atomic -Path $shim -Content "@echo off`r`n`"$($Script:RuntimeNodeBin)`" `"$cliMain`" %*"

  # Verify via the provisioned node.
  $ver = & $Script:RuntimeNodeBin $cliMain --version 2>$null
  if ($LASTEXITCODE -eq 0 -and $ver) {
    Good "Verified: noir $ver"
  } else {
    Warn "Could not read 'noir --version' (the install may still be usable)."
    if (-not $ver) { $ver = '0.0.0' }
  }

  # Record install method: ~\.noir\install.json (same shape core's
  # writeInstallRecord() writes). Reflects which runtime backs this install
  # so `noir doctor` reports it accurately.
  $now     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  $channel = if ($env:NOIR_CHANNEL) { $env:NOIR_CHANNEL } else { 'latest' }
  $rec = @{ method = 'native'; version = $ver; channel = $channel; installedAt = $now; managedRuntimeVersion = $Script:RuntimeVersion } |
    ConvertTo-Json -Compress
  Write-Atomic -Path (Join-Path $home2 'install.json') -Content $rec

  # PATH hint.
  $noirOnPath = Get-Command noir -ErrorAction SilentlyContinue
  if ($noirOnPath) {
    Good "noir is on PATH at: $($noirOnPath.Source)"
  } else {
    Warn 'noir is installed but NOT on your PATH.'
    Note 'Add the shim dir to your PATH (user-scoped, persists across shells):'
    Note "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$binDir', 'User')"
    Note 'Then start a new shell and run: noir --version'
  }

  Write-Host ''
  Info 'Next steps:'
  Note '  noir init            # scaffold .noir/ + emit builtin skills + host wiring'
  Note '  noir doctor          # config / store / native-deps health check'
  Note "Docs: $RepoUrl#readme"
}

# Script-scoped runtime state (set by Provision-Node / Use-SystemNodeFallback).
$Script:RuntimeNodeBin  = $null
$Script:RuntimeNpmBin   = $null
$Script:RuntimeSource   = $null
$Script:RuntimeVersion  = $null

Main
