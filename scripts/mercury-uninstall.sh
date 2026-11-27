#!/usr/bin/env bash
# Completely erase a Mercury Agent installation from disk.
# Safe to run on macOS or Linux. Review before running — deletions are permanent.
#
# Usage:
#   bash mercury-uninstall.sh          # interactive: asks before deleting
#   bash mercury-uninstall.sh --yes    # no prompts
#   bash mercury-uninstall.sh --backup # make a .mbak of ~/.mercury first (if mercury still works)
#
set -u

ASSUME_YES=0
DO_BACKUP=0
for a in "$@"; do
  case "$a" in
    --yes|-y) ASSUME_YES=1 ;;
    --backup) DO_BACKUP=1 ;;
  esac
done

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  printf '%s [y/N] ' "$1"; read -r ans; [ "$ans" = y ] || [ "$ans" = Y ]
}

# Honor environment overrides if the user set them; else the documented defaults.
HOME_DIR="${MERCURY_HOME:-$HOME/.mercury}"
PROFILES_HOME="${MERCURY_PROFILES_HOME:-$HOME/.mercury-profiles}"
PROFILES_DIR="${MERCURY_PROFILES_DIR:-$HOME/.config/mercury}"
DATA_DIR="${MERCURY_DATA_DIR:-}"

echo "== Mercury Agent uninstaller =="
echo "Will target:"
echo "  data home      : $HOME_DIR"
echo "  profile homes  : $PROFILES_HOME"
echo "  profiles/config: $PROFILES_DIR"
[ -n "$DATA_DIR" ] && echo "  data dir (env) : $DATA_DIR"
echo

# 0. Optional backup of the data home before we delete it.
if [ "$DO_BACKUP" = 1 ] && command -v mercury >/dev/null 2>&1; then
  OUT="$HOME/mercury-final-$(date +%Y%m%d-%H%M%S).mbak"
  echo "Backing up to $OUT ..."
  mercury backup --out "$OUT" || echo "  (backup failed; continuing)"
fi

# 1. Stop any running Mercury processes.
if confirm "Stop running mercury processes?"; then
  pkill -f "bin.js serve" 2>/dev/null
  pkill -f "mercury" 2>/dev/null
  echo "  stopped (if any were running)."
fi

# 2. Remove the CLI if installed globally via npm.
if command -v npm >/dev/null 2>&1 && npm ls -g --depth=0 2>/dev/null | grep -qi "mercury-agent"; then
  if confirm "Remove global npm package 'mercury-agent'?"; then
    npm rm -g mercury-agent && echo "  npm package removed."
  fi
else
  echo "No global npm 'mercury-agent' package found."
  if command -v mercury >/dev/null 2>&1; then
    echo "  'mercury' resolves to: $(command -v mercury)"
    echo "  (If that is a symlink into a source clone, delete the clone below; remove the symlink manually if needed.)"
  fi
fi

# 3. Delete data, profiles, registries, and backups.
for d in "$HOME_DIR" "$PROFILES_HOME" "$PROFILES_DIR" "$DATA_DIR"; do
  [ -n "$d" ] || continue
  if [ -e "$d" ] && confirm "Delete $d ?"; then
    rm -rf "$d" && echo "  deleted $d"
  fi
done

if confirm "Delete Mercury backup archives (mercury-backup-*.mbak, mercury-prerestore-*.mbak) in \$HOME?"; then
  rm -f "$HOME"/mercury-backup-*.mbak "$HOME"/mercury-prerestore-*.mbak 2>/dev/null
  echo "  backup archives in \$HOME removed."
fi

# 4. Note the source clone + shell rc (not auto-deleted — paths vary).
echo
echo "Manual follow-ups (not done automatically):"
echo "  - Delete the source clone if you built from source, e.g.:  rm -rf ~/mercury ~/mercury_agent"
echo "  - Edit your shell rc (~/.zshrc or ~/.bashrc) and remove any lines exporting"
echo "    OPENROUTER_API_KEY or MERCURY_* , then: source ~/.zshrc"
echo

# 5. Verify.
echo "== Verification =="
command -v mercury >/dev/null 2>&1 && echo "  WARNING: 'mercury' still on PATH at $(command -v mercury)" || echo "  mercury command gone."
for d in "$HOME_DIR" "$PROFILES_HOME" "$PROFILES_DIR"; do
  [ -e "$d" ] && echo "  WARNING: still present: $d" || echo "  gone: $d"
done
echo "Done."
