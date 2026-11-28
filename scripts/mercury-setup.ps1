<#
=============================================================================
 Mercury Agent - INSTALL + CONFIGURE + DEPLOY (interactive)
=============================================================================
 OS coverage: Windows ONLY (PowerShell).
   Design note: Linux and macOS are handled by the sibling POSIX bash script
   `mercury-setup.sh` (one bash script for both, branching on `uname`: systemd
   on Linux, launchd on macOS). This .ps1 is the Windows equivalent and deploys
   via a Scheduled Task (at logon) running `node ...bin.js serve`.

 Flow:
   1. Prerequisite checks (git, Node >= 22.5.0, npm).
   2. Clone/update the repo from GitHub.
   3. Build (npm ci || npm install, then npm run build); make the CLI runnable.
   4. Interactive prompts (each overridable by env/param for unattended runs):
        - LLM provider: OpenRouter | Ollama
        - LLM model name (sensible default per provider)
        - OpenRouter API key -> ~/.mercury/.env (never echoed)
          or Ollama base URL + enable provider (+ optional `ollama pull`)
        - Jev decision engine: yes/no
        - Voice (STT/TTS): yes/no  (offline: ffmpeg + whisper + piper)
        - Admin username/password (for `mercury setup`)
   5. Deploy as a Scheduled Task, unless -NoDeploy. Poll http://localhost:3000.

 Params / env for unattended runs (params override env):
   -Provider openrouter|ollama      (env MERCURY_PROVIDER)
   -Model <id>                      (env MERCURY_MODEL)
   -OpenRouterKey <key>             (env OPENROUTER_API_KEY)
   -OllamaBase <url>                (env MERCURY_OLLAMA_BASE)
   -Jev / -NoJev                    (env MERCURY_JEV=yes|no)
   -Voice / -NoVoice                (env MERCURY_VOICE=yes|no)
   -AdminUser <name>               (env MERCURY_ADMIN_USER; default admin)
   -AdminPass <pw>                  (env MERCURY_ADMIN_PASS; >= 8 chars)
   -Dir <path>                      (env MERCURY_DIR; default ~/mercury)
   -Repo <url>                      (env MERCURY_REPO)
   -NoDeploy                        (configure only, skip service)
   -Yes                             (accept defaults / non-interactive)

 $ErrorActionPreference='Stop'. NEVER prints secret values.
=============================================================================
#>
[CmdletBinding()]
param(
  [ValidateSet('openrouter','ollama')][string]$Provider = $env:MERCURY_PROVIDER,
  [string]$Model = $env:MERCURY_MODEL,
  [string]$OpenRouterKey = $env:OPENROUTER_API_KEY,
  [string]$OllamaBase = $(if ($env:MERCURY_OLLAMA_BASE) { $env:MERCURY_OLLAMA_BASE } else { 'http://localhost:11434/v1' }),
  [switch]$Jev,
  [switch]$NoJev,
  [switch]$Voice,
  [switch]$NoVoice,
  [string]$AdminUser = $(if ($env:MERCURY_ADMIN_USER) { $env:MERCURY_ADMIN_USER } else { '' }),
  [string]$AdminPass = $env:MERCURY_ADMIN_PASS,
  [string]$Dir = $(if ($env:MERCURY_DIR) { $env:MERCURY_DIR } else { Join-Path $HOME 'mercury' }),
  [string]$Repo = $(if ($env:MERCURY_REPO) { $env:MERCURY_REPO } else { 'https://github.com/ms1963/mercury_agent.git' }),
  [switch]$NoDeploy,
  [switch]$Yes
)
$ErrorActionPreference = 'Stop'

$TaskName = 'MercuryAgent'
$UserHome = if ($HOME) { $HOME } else { $env:USERPROFILE }
$ConfigHome = if ($env:MERCURY_HOME) { $env:MERCURY_HOME } else { Join-Path $UserHome '.mercury' }

function Ask([string]$Prompt, [string]$Default) {
  if ($Yes) { return $Default }
  $suffix = if ($Default) { " [$Default]" } else { "" }
  $a = Read-Host "$Prompt$suffix"
  if ([string]::IsNullOrWhiteSpace($a)) { return $Default } else { return $a }
}
function AskYesNo([string]$Prompt, [string]$Default) {
  $a = Ask "$Prompt (yes/no)" $Default
  if ($a -match '^(y|yes)$') { return 'yes' } else { return 'no' }
}

Write-Host "============================================================"
Write-Host " Mercury Agent - install + configure + deploy (Windows)"
Write-Host "============================================================"

# ---- 1. Prerequisites -------------------------------------------------------
Write-Host "`n[1/5] Checking prerequisites ..."
foreach ($bin in @('git','node','npm')) {
  if (-not (Get-Command $bin -ErrorAction SilentlyContinue)) {
    Write-Error "ERROR: '$bin' is required. Node.js >= 22.5.0: https://nodejs.org"
    exit 1
  }
}
$nodeOk = & node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)'; if ($LASTEXITCODE -ne 0) {
  Write-Error "ERROR: Node.js >= 22.5.0 is required (found $(node -v)): https://nodejs.org"; exit 1
}
Write-Host "  git: $(git --version)"
Write-Host "  node: $(node -v)   npm: $(npm -v)"

# ---- 2. Clone / update ------------------------------------------------------
Write-Host "`n[2/5] Fetching Mercury into $Dir ..."
if (Test-Path (Join-Path $Dir '.git')) {
  Write-Host "  existing checkout found; updating (git pull --ff-only) ..."
  try { git -C $Dir pull --ff-only } catch { Write-Host "  (pull failed; continuing)" }
} elseif ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force -ErrorAction SilentlyContinue)) {
  Write-Error "ERROR: $Dir exists and is not a git checkout. Choose another -Dir."; exit 1
} else {
  git clone $Repo $Dir
}
Set-Location $Dir

# ---- 3. Build ---------------------------------------------------------------
Write-Host "`n[3/5] Building ..."
try { & npm ci } catch { & npm install }
& npm run build

$BinJs = Join-Path $Dir 'packages\cli\dist\bin.js'
$Mercury = $null
try {
  & npm link | Out-Null
  if (Get-Command mercury -ErrorAction SilentlyContinue) { $Mercury = 'mercury' }
} catch {}
if (-not $Mercury) {
  $Mercury = "node `"$BinJs`""
  Write-Host "  npm link unavailable; using: $Mercury"
} else {
  Write-Host "  linked global 'mercury' binary."
}
function Merc { param([Parameter(ValueFromRemainingArguments=$true)]$Args)
  if ($Mercury -eq 'mercury') { & mercury @Args } else { & node $BinJs @Args }
}

# ---- 4. Configuration -------------------------------------------------------
Write-Host "`n[4/5] Configuration"

# 4.1 provider
if (-not $Provider) {
  Write-Host "  Choose an LLM provider:"
  Write-Host "    1) OpenRouter (hosted; needs an API key)"
  Write-Host "    2) Ollama (local; no API key)"
  $c = Ask "  Selection (1/2)" "1"
  $Provider = if ($c -match '^(2|ollama)$') { 'ollama' } else { 'openrouter' }
}
Write-Host "  provider: $Provider"

# 4.2 model
if (-not $Model) {
  $defModel = if ($Provider -eq 'openrouter') { 'openrouter/openai/gpt-4o-mini' } else { 'ollama/llama3.1' }
  $Model = Ask "  Model name" $defModel
}
Write-Host "  model: $Model"

# 4.3 provider-specific
New-Item -ItemType Directory -Force -Path $ConfigHome | Out-Null
$EnvFile = Join-Path $ConfigHome '.env'
$BaseArg = @()
if ($Provider -eq 'openrouter') {
  $key = $OpenRouterKey
  if (-not $key -and -not $Yes) {
    $sec = Read-Host "  OpenRouter API key (hidden)" -AsSecureString
    $key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  if ($key) {
    $existing = @()
    if (Test-Path $EnvFile) { $existing = Get-Content $EnvFile | Where-Object { $_ -notmatch '^OPENROUTER_API_KEY=' } }
    ($existing + "OPENROUTER_API_KEY=$key") | Set-Content -Path $EnvFile -Encoding ascii
    Write-Host "  wrote OPENROUTER_API_KEY to $EnvFile."
  } else {
    Write-Host "  WARNING: no OpenRouter API key provided; set OPENROUTER_API_KEY in $EnvFile later."
  }
} else {
  $OllamaBase = Ask "  Ollama base URL" $OllamaBase
  $BaseArg = @('--base', $OllamaBase)
  Write-Host "  Ollama base URL: $OllamaBase"
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    $pull = AskYesNo "  'ollama' found. Pull model '$($Model -replace '^ollama/','')' now?" "no"
    if ($pull -eq 'yes') { try { & ollama pull ($Model -replace '^ollama/','') } catch { Write-Host "  (ollama pull failed)" } }
  }
}

# 4.4 Jev
$jevChoice = if ($Jev) { 'yes' } elseif ($NoJev) { 'no' } elseif ($env:MERCURY_JEV) { $env:MERCURY_JEV } else { AskYesNo "  Enable the Jev decision engine?" "no" }

# 4.5 Voice
$voiceChoice = if ($Voice) { 'yes' } elseif ($NoVoice) { 'no' } elseif ($env:MERCURY_VOICE) { $env:MERCURY_VOICE } else { AskYesNo "  Enable voice recognition (offline STT/TTS: whisper + piper)?" "no" }

# 4.6 admin creds
if (-not $AdminUser) { $AdminUser = Ask "  Admin username" "admin" }
if (-not $AdminPass) {
  if ($Yes) { Write-Error "ERROR: -Yes requires -AdminPass / MERCURY_ADMIN_PASS (>= 8 chars)."; exit 1 }
  do {
    $sec = Read-Host "  Admin password (>= 8 chars, hidden)" -AsSecureString
    $AdminPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  } while ($AdminPass.Length -lt 8)
}
if ($AdminPass.Length -lt 8) { Write-Error "ERROR: admin password must be >= 8 chars."; exit 1 }

# Apply base config
Write-Host "  Applying configuration via 'mercury setup' ..."
Merc setup --username $AdminUser --password $AdminPass --provider $Provider --model $Model @BaseArg
if ($LASTEXITCODE -ne 0) { Write-Error "ERROR: 'mercury setup' failed."; exit 1 }

# Jev
$hasKey = (Test-Path $EnvFile) -and (Select-String -Path $EnvFile -Pattern '^OPENROUTER_API_KEY=' -Quiet)
if ($jevChoice -eq 'yes') {
  if ($Provider -eq 'ollama' -and -not $hasKey -and -not $env:OPENROUTER_API_KEY) {
    Write-Host "  WARNING: Jev needs OPENROUTER_API_KEY (not set with Ollama). Falling back to decision.provider=auto."
    Merc config set decision.provider auto
  } else {
    Merc config set decision.provider jev
    Write-Host "  decision.provider = jev"
  }
} else {
  Merc config set decision.provider llm
  Write-Host "  decision.provider = llm"
}

# Voice
if ($voiceChoice -eq 'yes') {
  Write-Host "  Installing offline voice engines (ffmpeg + openai-whisper + piper-tts) ..."
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    try { winget install --silent --accept-package-agreements --accept-source-agreements Gyan.FFmpeg | Out-Null } catch { Write-Host "  (winget ffmpeg failed)" }
  } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
    try { choco install -y ffmpeg | Out-Null } catch { Write-Host "  (choco ffmpeg failed)" }
  } else { Write-Host "  (no winget/choco; install ffmpeg manually)" }
  if (Get-Command pip -ErrorAction SilentlyContinue) {
    try { & pip install --user openai-whisper piper-tts | Out-Null } catch { Write-Host "  (whisper/piper via pip failed)" }
  } else { Write-Host "  (no pip; install whisper + piper manually)" }
  try { Merc voice use stt whisper } catch { Write-Host "  (could not set STT=whisper)" }
  try { Merc voice use tts piper } catch { Write-Host "  (could not set TTS=piper)" }
  Write-Host "  voice: STT=whisper, TTS=piper (warnings above are non-fatal)"
} else {
  Write-Host "  voice: left at defaults."
}

# ---- 5. Deploy as a Scheduled Task ------------------------------------------
if ($NoDeploy) {
  Write-Host "`n[5/5] Deploy skipped (-NoDeploy). Start manually with: $Mercury serve"
} else {
  Write-Host "`n[5/5] Deploying auto-start Scheduled Task '$TaskName' ..."
  $nodeExe = (Get-Command node).Source
  $action = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$BinJs`" serve --host 127.0.0.1 --port 3000" -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue } catch {}
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description "Mercury Agent server" | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "  Scheduled Task '$TaskName' registered and started."

  Write-Host "  Waiting for http://localhost:3000 ..."
  $up = $false
  for ($i = 0; $i -lt 30; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:3000' -TimeoutSec 2 | Out-Null; $up = $true; break } catch { Start-Sleep -Seconds 1 }
  }
  if ($up) { Write-Host "  Mercury is up at http://localhost:3000" }
  else { Write-Host "  WARNING: server did not respond on :3000 yet (check the task)." }
}

# ---- Summary ----------------------------------------------------------------
Write-Host "`n============================================================"
Write-Host " Done."
Write-Host "   install dir : $Dir"
Write-Host "   config home : $ConfigHome  (config.yaml, .env)"
Write-Host "   provider    : $Provider   model: $Model"
Write-Host "   decision    : $(if ($jevChoice -eq 'yes') { 'jev' } else { 'llm' })"
Write-Host "   voice       : $voiceChoice"
Write-Host "   Next: '$Mercury chat' for terminal chat; web UI at http://localhost:3000"
Write-Host "============================================================"
