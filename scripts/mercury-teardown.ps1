<#
=============================================================================
 Mercury Agent - TEARDOWN (stop + completely erase)
=============================================================================
 OS coverage: Windows ONLY (PowerShell).
   Design note: Linux and macOS are handled by the sibling POSIX bash script
   `mercury-teardown.sh` (one bash script for both, branching on `uname`:
   systemd on Linux, launchd on macOS). This .ps1 is the Windows equivalent
   and removes the Scheduled Task / background service instead.

 What it does:
   - Stops any running Mercury processes (node ...bin.js serve / mercury serve).
   - Removes the deployed auto-start Scheduled Task ("MercuryAgent").
   - Deletes all data/config (~/.mercury, ~/.mercury-profiles, ~/.config/mercury,
     honoring MERCURY_HOME / MERCURY_PROFILES_HOME / MERCURY_DATA_DIR overrides),
     the source clone(s) (default ~/.mercury-src and ~/mercury; custom via
     MERCURY_DIR), backup archives (mercury-*.mbak) and the global npm package /
     `mercury` link.
   - Interactive confirmation before destructive deletes; -Yes / -Force to skip.
   - Optional -Backup runs `mercury backup` first if the CLI still works.
   - Ends with a verification section reporting what is gone / still present.

 Usage:
   powershell -ExecutionPolicy Bypass -File mercury-teardown.ps1
   powershell -ExecutionPolicy Bypass -File mercury-teardown.ps1 -Yes
   powershell -ExecutionPolicy Bypass -File mercury-teardown.ps1 -Backup -Force

 NEVER prints secret values.
=============================================================================
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$Force,
  [switch]$Backup
)
$ErrorActionPreference = 'Stop'

$AssumeYes = $Yes.IsPresent -or $Force.IsPresent
$TaskName  = 'MercuryAgent'

function Confirm-Action([string]$Message) {
  if ($AssumeYes) { return $true }
  $ans = Read-Host "$Message [y/N]"
  return ($ans -eq 'y' -or $ans -eq 'Y')
}

# ---- Resolve targets (honor env overrides, else documented defaults) --------
$UserHome      = $HOME
if (-not $UserHome) { $UserHome = $env:USERPROFILE }
$HomeDir       = if ($env:MERCURY_HOME) { $env:MERCURY_HOME } else { Join-Path $UserHome '.mercury' }
$ProfilesHome  = if ($env:MERCURY_PROFILES_HOME) { $env:MERCURY_PROFILES_HOME } else { Join-Path $UserHome '.mercury-profiles' }
$ProfilesDir   = if ($env:MERCURY_PROFILES_DIR) { $env:MERCURY_PROFILES_DIR } else { Join-Path $UserHome '.config\mercury' }
$DataDir       = $env:MERCURY_DATA_DIR
$SrcDir        = if ($env:MERCURY_DIR) { $env:MERCURY_DIR } else { Join-Path $UserHome '.mercury-src' }
$AltSrcDir     = Join-Path $UserHome 'mercury'

Write-Host "== Mercury Agent teardown (Windows) =="
Write-Host "Will target:"
Write-Host "  data home       : $HomeDir"
Write-Host "  profile homes   : $ProfilesHome"
Write-Host "  profiles/config : $ProfilesDir"
if ($DataDir) { Write-Host "  data dir (env)  : $DataDir" }
Write-Host "  source clone(s) : $SrcDir , $AltSrcDir"
Write-Host ""

# ---- 0. Optional backup before anything is removed --------------------------
if ($Backup -and (Get-Command mercury -ErrorAction SilentlyContinue)) {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $out = Join-Path $UserHome "mercury-final-$stamp.mbak"
  Write-Host "Backing up to $out ..."
  try { & mercury backup --out "$out" } catch { Write-Host "  (backup failed; continuing)" }
}

# ---- 1. Stop running Mercury processes --------------------------------------
if (Confirm-Action "Stop running mercury processes?") {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match 'bin\.js serve' -or $_.CommandLine -match 'mercury serve') } |
    ForEach-Object {
      try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
  Write-Host "  stopped (if any were running)."
}

# ---- 2. Remove the deployed auto-start Scheduled Task -----------------------
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  if (Confirm-Action "Remove Scheduled Task '$TaskName'?") {
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "  Scheduled Task '$TaskName' removed."
  }
} else {
  Write-Host "  no Scheduled Task '$TaskName' found."
}

# ---- 3. Remove the global CLI (npm package / link) --------------------------
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($npm) {
  $globals = (& npm ls -g --depth=0 2>$null) -join "`n"
  if ($globals -match 'mercury-agent') {
    if (Confirm-Action "Remove global npm package 'mercury-agent'?") {
      try { & npm rm -g mercury-agent; Write-Host "  npm package removed." } catch { Write-Host "  (npm rm failed)" }
    }
  } else {
    Write-Host "No global npm 'mercury-agent' package found."
  }
} else {
  Write-Host "npm not found; skipping global package removal."
}

# ---- 4. Delete data, profiles, registries, source clones, backups ----------
foreach ($d in @($HomeDir, $ProfilesHome, $ProfilesDir, $DataDir, $SrcDir, $AltSrcDir)) {
  if ($d -and (Test-Path $d)) {
    if (Confirm-Action "Delete $d ?") {
      Remove-Item -Recurse -Force -LiteralPath $d -ErrorAction SilentlyContinue
      Write-Host "  deleted $d"
    }
  }
}

if (Confirm-Action "Delete Mercury backup archives (mercury-*.mbak) in home?") {
  Get-ChildItem -Path $UserHome -Filter 'mercury-*.mbak' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue
  Write-Host "  backup archives removed."
}

Write-Host ""
Write-Host "Manual follow-ups (not done automatically):"
Write-Host "  - Remove any user env vars (OPENROUTER_API_KEY, MERCURY_*) you set via"
Write-Host "    System Properties > Environment Variables."
Write-Host ""

# ---- 5. Verify --------------------------------------------------------------
Write-Host "== Verification =="
if (Get-Command mercury -ErrorAction SilentlyContinue) {
  Write-Host "  WARNING: 'mercury' still on PATH."
} else {
  Write-Host "  mercury command gone."
}
foreach ($d in @($HomeDir, $ProfilesHome, $ProfilesDir, $SrcDir, $AltSrcDir)) {
  if (Test-Path $d) { Write-Host "  WARNING: still present: $d" } else { Write-Host "  gone: $d" }
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Write-Host "  WARNING: Scheduled Task '$TaskName' still present"
} else {
  Write-Host "  Scheduled Task gone."
}
Write-Host "Done."
