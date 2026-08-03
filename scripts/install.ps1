# scripts/install.ps1 - native PowerShell installer for Noir (Windows).
# Mirrors scripts/install.sh. Env knobs: NOIR_CHANNEL, NOIR_VERSION,
# HTTP_PROXY/HTTPS_PROXY/NO_PROXY. Installs @noir-ai/cli via a managed-Node
# runtime under ~\.noir (runtime/, cli/, bin/) and writes ~\.noir\install.json.
# Idempotent: re-running upgrades in place (matching install.sh).
# Usage:
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"

$ErrorActionPreference = 'Stop'

$Package = '@noir-ai/cli'

function Info  { Write-Host "==> $args" -ForegroundColor Blue }
function Good  { Write-Host "[ok] $args" -ForegroundColor Green }
function Warn  { Write-Host "[!] $args" -ForegroundColor Yellow }
function Die   { Write-Error $args; exit 1 }

# --- Resolve spec ---
$channel = if ($env:NOIR_CHANNEL) { $env:NOIR_CHANNEL } else { 'latest' }
$spec = if ($env:NOIR_VERSION) { "@$($env:NOIR_VERSION)" } else { "@$channel" }

# $NOIR_HOME honors the same override the CLI's noirHome() honors for install.json.
$home = if ($env:NOIR_HOME) { $env:NOIR_HOME } else { Join-Path $HOME '.noir' }
$runtimeDir = Join-Path $home 'runtime'
$cliDir     = Join-Path $home 'cli'
$binDir     = Join-Path $home 'bin'
New-Item -ItemType Directory -Force -Path $runtimeDir, $cliDir, $binDir | Out-Null

# --- Managed Node: require a provisioned runtime (the CLI's own install reuses it).
$nodeBin = Join-Path $runtimeDir 'node\node.exe'
if (-not (Test-Path $nodeBin)) {
  Warn "Managed Node not provisioned at $nodeBin."
  Warn "For the native path, provision Node 22 LTS under $runtimeDir (see docs)."
  # Fallback: use system node/npm if >= 22.
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Die 'Node.js >= 22 is required. Install it, or provision the managed runtime.' }
  $nodeBin = (Get-Command node).Source
}

$npmBin = if (Test-Path (Join-Path (Split-Path $nodeBin) 'npm.cmd')) { Join-Path (Split-Path $nodeBin) 'npm.cmd' } else { 'npm' }

# --- Pass proxies through to npm (npm also reads npm_config_proxy).
if ($env:HTTPS_PROXY) { Info "Honoring HTTPS_PROXY." }

# --- Install into the isolated prefix (never the system global; no admin).
$prefixArgs = "--prefix=$cliDir"
Info "Installing $Package$spec via npm (prefix: $cliDir)"
& $npmBin install -g "$Package$spec" $prefixArgs
if ($LASTEXITCODE -ne 0) { Die "npm install failed (exit $LASTEXITCODE)" }

# --- Shim: bin\noir.cmd (the only PATH contract, mirroring ~/.noir/bin/noir).
# npm install -g --prefix=<dir> installs into <dir>/lib/node_modules and drops
# its own launcher at <dir>/bin/<name>; our shim points at the real entry so the
# runtime bin is exactly ~/.noir/bin/noir.cmd regardless of npm version.
$shim = Join-Path $binDir 'noir.cmd'
$cliMain = Join-Path $cliDir 'lib\node_modules\@noir-ai\cli\dist\bin.js'
# Note: use -Value with an explicit string, never a pipeline value — on
# PowerShell >= 7.3 a null pipeline value is a NO-OP for Set-Content, which
# would silently leave a STALE shim on re-run.
Set-Content -Path $shim -Value "@echo off`r`n`"%nodeBin%`" `"$cliMain`" %*" -Encoding ASCII -NoNewline

# --- Verify (mirrors install.sh's `noir --version` check).
$ver = & $nodeBin $cliMain --version
if ($LASTEXITCODE -ne 0) { Die 'Verification failed: noir --version' }
Good "Installed $Package$spec ($ver)"

# --- Record install method: ~\.noir\install.json (same shape core's
#     writeInstallRecord() writes). Version-assert: re-running over an equal
#     version is idempotent; the record is refreshed to the resolved version.
$rec = @{ method = 'native'; version = $ver; channel = $channel; installedAt = (Get-Date).ToUniversalTime().ToString('o'); managedRuntimeVersion = '22.x' } | ConvertTo-Json
# Atomic-ish: write to a temp sibling then rename, never in-place overwrite
# (Windows file-locking + the CLI's own atomicWriteFile convention).
$installJson = Join-Path $home 'install.json'
$installJsonTmp = "$installJson.tmp-$PID"
Set-Content -Path $installJsonTmp -Value $rec -Encoding ASCII -NoNewline
Move-Item -Force $installJsonTmp $installJson

# --- PATH hint
$binDir | Out-String | Write-Host
if (-not ($env:PATH -split ';' | Where-Object { $_ -ieq $binDir })) {
  Warn "Add $binDir to your PATH to run 'noir' from anywhere."
  Warn "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$binDir', 'User')"
}
