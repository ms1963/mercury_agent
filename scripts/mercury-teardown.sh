#!/usr/bin/env bash
# =============================================================================
# Mercury Agent — TEARDOWN (stop + completely erase)
# =============================================================================
# OS coverage: Linux AND macOS (single POSIX bash script).
#   Design note: one bash script handles BOTH Linux and macOS by branching on
#   `uname`. Service removal differs per OS: systemd on Linux (both
#   `systemctl --user` and system `sudo systemctl`), launchd on macOS
#   (`launchctl bootout`/`unload` + the ~/Library/LaunchAgents plist).
#   Windows is handled by the sibling script `mercury-teardown.ps1`.
#
# What it does:
#   - Stops any running Mercury processes (`bin.js serve`, `mercury serve`).
#   - Removes the deployed auto-start service (systemd user/system OR launchd).
#   - Deletes all data/config (~/.mercury, ~/.mercury-profiles, ~/.config/mercury,
#     honoring MERCURY_HOME / MERCURY_PROFILES_HOME / MERCURY_DATA_DIR overrides),
#     the source clone (default ~/.mercury-src and ~/mercury; custom via MERCURY_DIR),
#     backup archives (mercury-*.mbak) and the global npm package / `mercury` link.
#   - Interactive confirmation before destructive deletes; `--yes`/`-y` to skip.
#   - Optional `--backup` runs `mercury backup` first if the CLI still works.
#   - Ends with a verification section reporting what is gone / still present.
#
# Usage:
#   bash mercury-teardown.sh            # interactive: asks before each delete
#   bash mercury-teardown.sh --yes      # non-interactive, no prompts
#   bash mercury-teardown.sh --backup   # make a .mbak of ~/.mercury first
#   bash mercury-teardown.sh -y --backup
#
# NEVER prints secret values.
# =============================================================================
set -u

ASSUME_YES=0
DO_BACKUP=0
for a in "$@"; do
  case "$a" in
    --yes|-y) ASSUME_YES=1 ;;
    --backup) DO_BACKUP=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown option: $a (use --help)" >&2; exit 2 ;;
  esac
done

OS="$(uname -s 2>/dev/null || echo unknown)"

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [y/N] ' "$1"; read -r ans; [ "$ans" = y ] || [ "$ans" = Y ]
}

# ---- Resolve targets (honor env overrides, else documented defaults) --------
HOME_DIR="${MERCURY_HOME:-$HOME/.mercury}"
PROFILES_HOME="${MERCURY_PROFILES_HOME:-$HOME/.mercury-profiles}"
PROFILES_DIR="${MERCURY_PROFILES_DIR:-$HOME/.config/mercury}"
DATA_DIR="${MERCURY_DATA_DIR:-}"
SRC_DIR="${MERCURY_DIR:-$HOME/.mercury-src}"
ALT_SRC_DIR="$HOME/mercury"

SERVICE_NAME="mercury"
PLIST_LABEL="com.mercury.agent"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"

echo "== Mercury Agent teardown ($OS) =="
echo "Will target:"
echo "  data home       : $HOME_DIR"
echo "  profile homes   : $PROFILES_HOME"
echo "  profiles/config : $PROFILES_DIR"
[ -n "$DATA_DIR" ] && echo "  data dir (env)  : $DATA_DIR"
echo "  source clone(s) : $SRC_DIR , $ALT_SRC_DIR"
echo

# ---- 0. Optional backup before anything is removed --------------------------
if [ "$DO_BACKUP" = 1 ] && command -v mercury >/dev/null 2>&1; then
  OUT="$HOME/mercury-final-$(date +%Y%m%d-%H%M%S).mbak"
  echo "Backing up to $OUT ..."
  mercury backup --out "$OUT" 2>/dev/null || mercury backup 2>/dev/null || echo "  (backup failed; continuing)"
fi

# ---- 1. Stop running Mercury processes --------------------------------------
if confirm "Stop running mercury processes?"; then
  pkill -f "bin.js serve" 2>/dev/null || true
  pkill -f "mercury serve" 2>/dev/null || true
  pkill -f "mercury" 2>/dev/null || true
  echo "  stopped (if any were running)."
fi

# ---- 2. Remove the deployed auto-start service ------------------------------
remove_systemd() {
  # $1 = "user" | "system"
  local scope="$1" sc unit_file
  if [ "$scope" = user ]; then
    sc="systemctl --user"
    unit_file="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${SERVICE_NAME}.service"
  else
    sc="sudo systemctl"
    unit_file="/etc/systemd/system/${SERVICE_NAME}.service"
  fi
  command -v systemctl >/dev/null 2>&1 || return 0
  if $sc list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service" || [ -f "$unit_file" ]; then
    if confirm "Remove ${scope} systemd service '${SERVICE_NAME}'?"; then
      $sc stop "${SERVICE_NAME}" 2>/dev/null || true
      $sc disable "${SERVICE_NAME}" 2>/dev/null || true
      if [ -f "$unit_file" ]; then
        if [ "$scope" = user ]; then rm -f "$unit_file"; else sudo rm -f "$unit_file"; fi
        echo "  removed unit: $unit_file"
      fi
      $sc daemon-reload 2>/dev/null || true
      echo "  ${scope} systemd service removed."
    fi
  else
    echo "  no ${scope} systemd service found."
  fi
}

remove_launchd() {
  command -v launchctl >/dev/null 2>&1 || return 0
  if [ -f "$PLIST_PATH" ] || launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
    if confirm "Remove launchd agent '${PLIST_LABEL}'?"; then
      launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null \
        || launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH" && echo "  removed plist: $PLIST_PATH"
      echo "  launchd agent removed."
    fi
  else
    echo "  no launchd agent found."
  fi
}

case "$OS" in
  Linux)  remove_systemd user; remove_systemd system ;;
  Darwin) remove_launchd ;;
  *)      echo "  (unknown OS '$OS' — skipping service removal; stop processes manually)" ;;
esac

# ---- 3. Remove the global CLI (npm package / link) --------------------------
if command -v npm >/dev/null 2>&1 && npm ls -g --depth=0 2>/dev/null | grep -qi "mercury-agent"; then
  if confirm "Remove global npm package 'mercury-agent'?"; then
    npm rm -g mercury-agent 2>/dev/null && echo "  npm package removed." || echo "  (npm rm failed)"
  fi
else
  echo "No global npm 'mercury-agent' package found."
  if command -v mercury >/dev/null 2>&1; then
    LINK="$(command -v mercury)"
    echo "  'mercury' resolves to: $LINK"
    if confirm "Remove the 'mercury' symlink/binary at $LINK?"; then
      rm -f "$LINK" 2>/dev/null || sudo rm -f "$LINK" 2>/dev/null || echo "  (could not remove; remove manually)"
    fi
  fi
fi

# ---- 4. Delete data, profiles, registries, source clones, backups ----------
for d in "$HOME_DIR" "$PROFILES_HOME" "$PROFILES_DIR" "$DATA_DIR" "$SRC_DIR" "$ALT_SRC_DIR"; do
  [ -n "$d" ] || continue
  if [ -e "$d" ] && confirm "Delete $d ?"; then
    rm -rf "$d" && echo "  deleted $d"
  fi
done

if confirm "Delete Mercury backup archives (mercury-*.mbak) in \$HOME?"; then
  rm -f "$HOME"/mercury-*.mbak "$HOME"/mercury-backup-*.mbak "$HOME"/mercury-prerestore-*.mbak 2>/dev/null || true
  echo "  backup archives in \$HOME removed."
fi

echo
echo "Manual follow-ups (not done automatically):"
echo "  - Edit your shell rc (~/.zshrc or ~/.bashrc) and remove any lines exporting"
echo "    OPENROUTER_API_KEY or MERCURY_* , then re-source it."
echo

# ---- 5. Verify --------------------------------------------------------------
echo "== Verification =="
if command -v mercury >/dev/null 2>&1; then
  echo "  WARNING: 'mercury' still on PATH at $(command -v mercury)"
else
  echo "  mercury command gone."
fi
for d in "$HOME_DIR" "$PROFILES_HOME" "$PROFILES_DIR" "$SRC_DIR" "$ALT_SRC_DIR"; do
  [ -e "$d" ] && echo "  WARNING: still present: $d" || echo "  gone: $d"
done
case "$OS" in
  Linux)
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}.service" \
        && echo "  WARNING: user systemd unit still present" || echo "  user systemd unit gone."
    fi ;;
  Darwin)
    [ -f "$PLIST_PATH" ] && echo "  WARNING: launchd plist still present" || echo "  launchd plist gone." ;;
esac
echo "Done."
