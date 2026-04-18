#!/bin/bash
# Release script: run tests, bump patch version, build + push Docker image.
# Tests run FIRST — a failing test aborts before any commit, tag or push.
set -e

cd "$(dirname "$0")"

# ── Pick a node ≥18 (vitest needs it; the system /usr/local/bin/node is v8) ──
need_modern_node() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null) || return 1
  [ "$major" -ge 18 ]
}

if ! need_modern_node; then
  # Fall back to the newest nvm-installed node ≥18.
  if [ -d "$HOME/.nvm/versions/node" ]; then
    NVM_LATEST=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null \
      | sed 's/^v//' \
      | awk -F. '$1 >= 18' \
      | sort -t. -k1,1n -k2,2n -k3,3n \
      | tail -1)
    if [ -n "$NVM_LATEST" ]; then
      export PATH="$HOME/.nvm/versions/node/v$NVM_LATEST/bin:$PATH"
      echo "Using node v$NVM_LATEST from nvm"
    fi
  fi
fi

if ! need_modern_node; then
  echo "ERROR: node ≥18 required for vitest. Install via nvm or upgrade /usr/local/bin/node." >&2
  exit 1
fi

# ── Tests must pass before we commit / tag / build / push ──
echo "Running server tests..."
( cd server && npm test --silent )

# Version = date.time (e.g. 2026.0410.1523)
NEW=$(date +"%Y.%m%d.%H%M")
echo "Version: $NEW"

# Update package.json
CURRENT=$(node -p "require('./server/package.json').version")
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW\"/" server/package.json

# Commit version bump
git add server/package.json
git commit -m "release: v$NEW"
git tag "v$NEW"
git push && git push --tags

# Build + push multi-platform Docker image (amd64 + arm64)
echo "Building Docker image (amd64 + arm64)..."
docker buildx build --platform linux/amd64,linux/arm64 \
  --builder multiplatform-builder \
  -t "rvbcrs/opennova:latest" \
  -t "rvbcrs/opennova:$NEW" \
  --push --no-cache .

# Restart local container with new image
echo "Restarting local container..."
docker compose down 2>/dev/null
docker compose up -d 2>/dev/null

echo ""
echo "Released v$NEW"
echo "  Docker: rvbcrs/opennova:latest + rvbcrs/opennova:$NEW"
echo "  Local container restarted"
