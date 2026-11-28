#!/usr/bin/env bash
# =============================================================================
# Mercury Agent — INSTALL + CONFIGURE + DEPLOY (interactive)
# =============================================================================
# OS coverage: Linux AND macOS (single POSIX bash script).
#   Design note: one bash script handles BOTH Linux and macOS by branching on
#   `uname`. Deployment differs per OS: a `systemd` unit on Linux (prefers a
#   `systemctl --user` unit; offers a system unit with sudo), a `launchd`
#   LaunchAgent plist on macOS. Windows is handled by the sibling script
#   `mercury-setup.ps1` (Scheduled Task).
#
# Flow:
#   1. Prerequisite checks (git, Node >= 22.5.0, npm).
#   2. Clone/update the repo from GitHub.
#   3. Build (npm ci || npm install, then npm run build); make the CLI runnable.
#   4. Interactive prompts (each overridable by env/flag for unattended runs):
#        - LLM provider: OpenRouter | Ollama
#        - LLM model name (sensible default per provider)
#        - OpenRouter API key -> ~/.mercury/.env (chmod 600; never echoed)
#          or Ollama base URL + enable provider (+ optional `ollama pull`)
#        - Jev decision engine: yes/no
#        - Voice (STT/TTS): yes/no  (offline: ffmpeg + whisper + piper)
#        - Admin username/password (for `mercury setup`)
#   5. Deploy as an auto-starting background service (systemd/launchd),
#      unless --no-deploy. Poll http://localhost:3000 and report.
#
# Env/flags for unattended runs (flags override env):
#   MERCURY_REPO           repo URL (default https://github.com/ms1963/mercury_agent.git)
#   MERCURY_DIR            install dir (default ~/mercury)
#   MERCURY_PROVIDER       openrouter|ollama
#   MERCURY_MODEL          model id (default per provider)
#   OPENROUTER_API_KEY     OpenRouter key (if provider=openrouter)
#   MERCURY_OLLAMA_BASE    Ollama base URL (default http://localhost:11434/v1)
#   MERCURY_JEV            yes|no (Jev decision engine)
#   MERCURY_VOICE          yes|no (install offline STT/TTS)
#   MERCURY_ADMIN_USER     admin username (default admin)
#   MERCURY_ADMIN_PASS     admin password (>= 8 chars)
#   Flags: --provider, --model, --jev/--no-jev, --voice/--no-voice,
#          --admin-user, --admin-pass, --dir, --no-deploy, --system (system unit),
#          --yes (accept all defaults / non-interactive), -h/--help
#
# set -eu for robustness. NEVER prints secret values.
# =============================================================================
set -eu

# ---------------------------------------------------------------------------
# Argument / env parsing
# ---------------------------------------------------------------------------
PROVIDER="${MERCURY_PROVIDER:-}"
MODEL="${MERCURY_MODEL:-}"
JEV="${MERCURY_JEV:-}"
VOICE="${MERCURY_VOICE:-}"
ADMIN_USER="${MERCURY_ADMIN_USER:-}"
ADMIN_PASS="${MERCURY_ADMIN_PASS:-}"
INSTALL_DIR="${MERCURY_DIR:-$HOME/mercury}"
REPO_URL="${MERCURY_REPO:-https://github.com/ms1963/mercury_agent.git}"
OLLAMA_BASE="${MERCURY_OLLAMA_BASE:-http://localhost:11434/v1}"
NO_DEPLOY=0
USE_SYSTEM_UNIT=0
ASSUME_YES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --provider) PROVIDER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --jev) JEV=yes; shift ;;
    --no-jev) JEV=no; shift ;;
    --voice) VOICE=yes; shift ;;
    --no-voice) VOICE=no; shift ;;
    --admin-user) ADMIN_USER="$2"; shift 2 ;;
    --admin-pass) ADMIN_PASS="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    --no-deploy) NO_DEPLOY=1; shift ;;
    --system) USE_SYSTEM_UNIT=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (use --help)" >&2; exit 2 ;;
  esac
done

OS="$(uname -s 2>/dev/null || echo unknown)"
MERCURY_CONFIG_HOME="${MERCURY_HOME:-$HOME/.mercury}"

ask() {
  # ask "Prompt" "default" -> echoes answer (default when --yes or empty input)
  _prompt="$1"; _default="$2"
  if [ "$ASSUME_YES" = 1 ]; then echo "$_default"; return; fi
  if [ -n "$_default" ]; then printf '%s [%s]: ' "$_prompt" "$_default" >&2; else printf '%s: ' "$_prompt" >&2; fi
  read -r _ans || _ans=""
  [ -n "$_ans" ] && echo "$_ans" || echo "$_default"
}
ask_yesno() {
  _prompt="$1"; _default="$2"
  _a="$(ask "$_prompt (yes/no)" "$_default")"
  case "$_a" in y|Y|yes|YES|Yes) echo yes ;; *) echo no ;; esac
}

echo "============================================================"
echo " Mercury Agent — install + configure + deploy ($OS)"
echo "============================================================"

# ---------------------------------------------------------------------------
# 1. Prerequisite checks
# ---------------------------------------------------------------------------
echo
echo "[1/5] Checking prerequisites ..."
command -v git >/dev/null 2>&1 || { echo "ERROR: git is required. Install it, then re-run." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js >= 22.5.0 is required: https://nodejs.org" >&2; exit 1; }
command -v npm  >/dev/null 2>&1 || { echo "ERROR: npm is required (ships with Node.js): https://nodejs.org" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || { echo "ERROR: Node.js >= 22.5.0 is required (found $(node -v)): https://nodejs.org" >&2; exit 1; }
echo "  git: $(git --version | head -1)"
echo "  node: $(node -v)   npm: $(npm -v)"

# ---------------------------------------------------------------------------
# 2. Clone / update the repository
# ---------------------------------------------------------------------------
echo
echo "[2/5] Fetching Mercury into $INSTALL_DIR ..."
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "  existing checkout found; updating (git pull --ff-only) ..."
  git -C "$INSTALL_DIR" pull --ff-only || echo "  (pull failed; continuing with existing checkout)"
elif [ -e "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  echo "ERROR: $INSTALL_DIR exists and is not a git checkout. Choose another --dir." >&2; exit 1
else
  git clone "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# 3. Build + make CLI runnable
# ---------------------------------------------------------------------------
echo
echo "[3/5] Building ..."
npm ci || npm install
npm run build
chmod +x "$INSTALL_DIR/packages/cli/dist/bin.js" 2>/dev/null || true

# Define the runner used for all subsequent `mercury` calls.
if npm link >/dev/null 2>&1 && command -v mercury >/dev/null 2>&1; then
  MERCURY="mercury"
  echo "  linked global 'mercury' binary."
else
  MERCURY="node $INSTALL_DIR/packages/cli/dist/bin.js"
  echo "  npm link unavailable; using: $MERCURY"
fi

# ---------------------------------------------------------------------------
# 4. Interactive configuration
# ---------------------------------------------------------------------------
echo
echo "[4/5] Configuration"

# --- 4.1 provider ---
if [ -z "$PROVIDER" ]; then
  echo "  Choose an LLM provider:"
  echo "    1) OpenRouter (hosted; needs an API key)"
  echo "    2) Ollama (local; no API key)"
  _c="$(ask "  Selection (1/2)" "1")"
  case "$_c" in 2|ollama|Ollama) PROVIDER=ollama ;; *) PROVIDER=openrouter ;; esac
fi
case "$PROVIDER" in
  openrouter|ollama) ;;
  *) echo "ERROR: provider must be 'openrouter' or 'ollama' (got '$PROVIDER')" >&2; exit 1 ;;
esac
echo "  provider: $PROVIDER"

# --- 4.2 model ---
if [ -z "$MODEL" ]; then
  if [ "$PROVIDER" = openrouter ]; then DEF_MODEL="openrouter/openai/gpt-4o-mini"; else DEF_MODEL="ollama/llama3.1"; fi
  MODEL="$(ask "  Model name" "$DEF_MODEL")"
fi
echo "  model: $MODEL"

# --- 4.3 provider-specific config ---
mkdir -p "$MERCURY_CONFIG_HOME"
ENV_FILE="$MERCURY_CONFIG_HOME/.env"
SETUP_BASE_ARG=""
if [ "$PROVIDER" = openrouter ]; then
  KEY="${OPENROUTER_API_KEY:-}"
  if [ -z "$KEY" ] && [ "$ASSUME_YES" != 1 ]; then
    printf '  OpenRouter API key (input hidden): ' >&2
    stty -echo 2>/dev/null || true; read -r KEY || KEY=""; stty echo 2>/dev/null || true; echo >&2
  fi
  if [ -n "$KEY" ]; then
    touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
    # Replace any existing line, then append (never echo the value).
    grep -v '^OPENROUTER_API_KEY=' "$ENV_FILE" 2>/dev/null > "$ENV_FILE.tmp" || true
    mv "$ENV_FILE.tmp" "$ENV_FILE" 2>/dev/null || true
    printf 'OPENROUTER_API_KEY=%s\n' "$KEY" >> "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    echo "  wrote OPENROUTER_API_KEY to $ENV_FILE (chmod 600)."
  else
    echo "  WARNING: no OpenRouter API key provided; set OPENROUTER_API_KEY in $ENV_FILE later."
  fi
else
  # Ollama
  OLLAMA_BASE="$(ask "  Ollama base URL" "$OLLAMA_BASE")"
  SETUP_BASE_ARG="--base $OLLAMA_BASE"
  echo "  Ollama base URL: $OLLAMA_BASE"
  if command -v ollama >/dev/null 2>&1; then
    _pull="$(ask_yesno "  'ollama' found. Pull model '${MODEL#ollama/}' now?" "no")"
    if [ "$_pull" = yes ]; then ollama pull "${MODEL#ollama/}" || echo "  (ollama pull failed; continuing)"; fi
  fi
fi

# --- 4.4 Jev decision engine ---
[ -z "$JEV" ] && JEV="$(ask_yesno "  Enable the Jev decision engine?" "no")"

# --- 4.5 Voice ---
[ -z "$VOICE" ] && VOICE="$(ask_yesno "  Enable voice recognition (offline STT/TTS: whisper + piper)?" "no")"

# --- 4.6 Admin credentials ---
[ -z "$ADMIN_USER" ] && ADMIN_USER="$(ask "  Admin username" "admin")"
if [ -z "$ADMIN_PASS" ]; then
  if [ "$ASSUME_YES" = 1 ]; then
    echo "ERROR: --yes requires MERCURY_ADMIN_PASS / --admin-pass (>= 8 chars)." >&2; exit 1
  fi
  while :; do
    printf '  Admin password (>= 8 chars, hidden): ' >&2
    stty -echo 2>/dev/null || true; read -r ADMIN_PASS || ADMIN_PASS=""; stty echo 2>/dev/null || true; echo >&2
    [ "${#ADMIN_PASS}" -ge 8 ] && break
    echo "  password too short (>= 8 chars)." >&2
  done
fi
[ "${#ADMIN_PASS}" -ge 8 ] || { echo "ERROR: admin password must be >= 8 chars." >&2; exit 1; }

# --- Apply base config via non-interactive `mercury setup` ---
echo "  Applying configuration via 'mercury setup' ..."
# shellcheck disable=SC2086
$MERCURY setup --username "$ADMIN_USER" --password "$ADMIN_PASS" --provider "$PROVIDER" --model "$MODEL" $SETUP_BASE_ARG \
  || { echo "ERROR: 'mercury setup' failed." >&2; exit 1; }

# Jev decision engine
if [ "$JEV" = yes ]; then
  if [ "$PROVIDER" = ollama ] && [ -z "${OPENROUTER_API_KEY:-}" ] && ! grep -q '^OPENROUTER_API_KEY=' "$ENV_FILE" 2>/dev/null; then
    echo "  WARNING: Jev needs OPENROUTER_API_KEY, which is not set (Ollama chosen). Falling back to decision.provider=auto."
    $MERCURY config set decision.provider auto || true
  else
    $MERCURY config set decision.provider jev || true
    echo "  decision.provider = jev"
  fi
else
  $MERCURY config set decision.provider llm || true
  echo "  decision.provider = llm"
fi

# Voice engines (best-effort; warn, do not hard-fail)
if [ "$VOICE" = yes ]; then
  echo "  Installing offline voice engines (ffmpeg + openai-whisper + piper-tts) ..."
  if [ "$OS" = Darwin ]; then
    command -v brew >/dev/null 2>&1 && brew install ffmpeg >/dev/null 2>&1 || echo "  (could not install ffmpeg via brew)"
    command -v pip3 >/dev/null 2>&1 && pip3 install --user openai-whisper piper-tts >/dev/null 2>&1 \
      || echo "  (could not install whisper/piper via pip3)"
  else
    if command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y ffmpeg >/dev/null 2>&1 || echo "  (could not apt-get ffmpeg)"; fi
    if command -v pipx >/dev/null 2>&1; then
      pipx install openai-whisper >/dev/null 2>&1 || echo "  (whisper via pipx failed)"
      pipx install piper-tts >/dev/null 2>&1 || echo "  (piper via pipx failed)"
    elif command -v pip3 >/dev/null 2>&1; then
      pip3 install --user openai-whisper piper-tts >/dev/null 2>&1 || echo "  (whisper/piper via pip3 failed)"
    else
      echo "  (no pipx/pip3 found; install whisper + piper manually)"
    fi
  fi
  $MERCURY voice use stt whisper || echo "  (could not set STT=whisper)"
  $MERCURY voice use tts piper || echo "  (could not set TTS=piper)"
  echo "  voice: STT=whisper, TTS=piper (warnings above are non-fatal)"
else
  echo "  voice: left at defaults."
fi

# ---------------------------------------------------------------------------
# 5. Deploy as an auto-starting background service
# ---------------------------------------------------------------------------
if [ "$NO_DEPLOY" = 1 ]; then
  echo
  echo "[5/5] Deploy skipped (--no-deploy). Start manually with: $MERCURY serve"
else
  echo
  echo "[5/5] Deploying auto-start service ($OS) ..."
  NODE_BIN="$(command -v node)"
  BIN_JS="$INSTALL_DIR/packages/cli/dist/bin.js"

  if [ "$OS" = Linux ]; then
    if [ "$USE_SYSTEM_UNIT" = 1 ]; then
      UNIT_DIR="/etc/systemd/system"; SC="sudo systemctl"; WRITE="sudo tee"
    else
      UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"; SC="systemctl --user"; WRITE="tee"
      mkdir -p "$UNIT_DIR"
    fi
    UNIT_PATH="$UNIT_DIR/mercury.service"
    # Keep a copy alongside the install so teardown can find it.
    GEN_UNIT="$INSTALL_DIR/mercury.generated.service"
    cat > "$GEN_UNIT" <<UNIT
[Unit]
Description=Mercury Agent server (HTTP API + web UI)
After=network-online.target
Wants=network-online.target

[Service]
Environment=HOME=$HOME
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_BIN $BIN_JS serve --host 127.0.0.1 --port 3000
Restart=on-failure
RestartSec=3

[Install]
WantedBy=$( [ "$USE_SYSTEM_UNIT" = 1 ] && echo multi-user.target || echo default.target )
UNIT
    $WRITE "$UNIT_PATH" < "$GEN_UNIT" >/dev/null
    $SC daemon-reload
    $SC enable mercury 2>/dev/null || true
    $SC restart mercury || $SC start mercury
    echo "  systemd unit installed: $UNIT_PATH (copy: $GEN_UNIT)"

  elif [ "$OS" = Darwin ]; then
    PLIST_LABEL="com.mercury.agent"
    PLIST_DIR="$HOME/Library/LaunchAgents"; mkdir -p "$PLIST_DIR"
    PLIST_PATH="$PLIST_DIR/${PLIST_LABEL}.plist"
    GEN_PLIST="$INSTALL_DIR/mercury.generated.plist"
    cat > "$GEN_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$BIN_JS</string>
    <string>serve</string>
    <string>--host</string><string>127.0.0.1</string>
    <string>--port</string><string>3000</string>
  </array>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>EnvironmentVariables</key><dict><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
    cp "$GEN_PLIST" "$PLIST_PATH"
    launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || launchctl load "$PLIST_PATH"
    echo "  launchd agent installed: $PLIST_PATH (copy: $GEN_PLIST)"
  else
    echo "  (unknown OS '$OS' — start manually: $MERCURY serve)"
  fi

  # Poll the server.
  echo "  Waiting for http://localhost:3000 ..."
  i=0; UP=0
  while [ "$i" -lt 30 ]; do
    if curl -fsS -o /dev/null "http://localhost:3000" 2>/dev/null; then UP=1; break; fi
    i=$((i+1)); sleep 1
  done
  [ "$UP" = 1 ] && echo "  Mercury is up at http://localhost:3000" \
                || echo "  WARNING: server did not respond on :3000 yet (check service logs)."
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "============================================================"
echo " Done."
echo "   install dir : $INSTALL_DIR"
echo "   config home : $MERCURY_CONFIG_HOME  (config.yaml, .env)"
echo "   provider    : $PROVIDER   model: $MODEL"
echo "   decision    : $( [ "$JEV" = yes ] && echo jev || echo llm )"
echo "   voice       : $VOICE"
echo "   CLI runner  : $MERCURY"
echo "   Next: '$MERCURY chat' for terminal chat; web UI at http://localhost:3000"
echo "============================================================"
