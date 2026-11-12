#!/usr/bin/env sh
# Mercury installer: clones (or updates) the repo, builds it and links the `mercury` binary.
#   curl -fsSL <raw-url>/install.sh | sh        or        ./install.sh  (inside a checkout)
set -eu
REPO_URL="${MERCURY_REPO:-https://github.com/your-org/mercury.git}"
DIR="${MERCURY_DIR:-$HOME/.mercury-src}"

command -v node >/dev/null 2>&1 || { echo "Node.js >= 22.5 is required: https://nodejs.org" >&2; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || { echo "Node.js >= 22.5 is required (found $(node -v))" >&2; exit 1; }

if [ -f package.json ] && grep -q '"name": "mercury-agent"' package.json; then
  DIR="$(pwd)"
elif [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$DIR"
fi

cd "$DIR"
npm ci
npm run build
npm link >/dev/null 2>&1 || echo "note: 'npm link' failed; run mercury via: node $DIR/packages/cli/dist/bin.js"

echo
echo "Mercury installed in $DIR"
echo "Next:  mercury setup      # create the admin user, pick an LLM provider"
echo "       mercury chat       # talk to it in the terminal"
echo "       mercury serve      # web UI on http://localhost:3000"
