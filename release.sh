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

# Release notes voor de dashboard-popup: commits sinds de vorige tag,
# gegroepeerd op Dashboard/App/Admin/Firmware/Server. Bakt mee in de image.
node scripts/generate-release-notes.mjs --new "$NEW"

# Commit version bump + notes
git add server/package.json server/release-notes.json
git commit -m "release: v$NEW"
git tag "v$NEW"
git push && git push --tags

# Build + push multi-platform Docker image (amd64 + arm64).
# Keep Docker's layer cache enabled by default; the npm ci dependency layers
# (server + dashboard) are the expensive part and only rebuild when the
# lockfiles change.
CACHE_ARGS=()
if [ "${RELEASE_NO_CACHE:-0}" = "1" ] || [ "${RELEASE_NO_CACHE:-}" = "true" ]; then
  CACHE_ARGS=(--no-cache)
  echo "Building Docker image (amd64 + arm64, cache disabled)..."
else
  echo "Building Docker image (amd64 + arm64, cache enabled)..."
  echo "  Set RELEASE_NO_CACHE=1 for a full rebuild."
fi

# Smoke vóór de push: kan de AI-classifier (onnxruntime, glibc) laden in de
# verse image? Les van 2026-07-19: Alpine/musl brak dit stil — tests draaien
# met een gestubde classifier op de host en zien zoiets nooit.
echo "Smoke: classifier-import in verse image (host-arch)..."
docker buildx build --platform "linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
  --builder multiplatform-builder -t opennova-smoke --load "${CACHE_ARGS[@]}" .
docker run --rm --platform "linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" --network none --workdir /app/server --entrypoint node opennova-smoke \
  -e "import('@huggingface/transformers').then(()=>{console.log('smoke OK');process.exit(0)}).catch(e=>{console.error('smoke FAALT:',e.message);process.exit(1)})"

docker buildx build --platform linux/amd64,linux/arm64 \
  --builder multiplatform-builder \
  -t "rvbcrs/opennova:latest" \
  -t "rvbcrs/opennova:$NEW" \
  --push "${CACHE_ARGS[@]}" .

# Restart local container with new image.
# NOTE: `docker buildx build --push` (multiplatform) pushes to the registry but
# does NOT load the image into the local Docker store. Without an explicit pull,
# `docker compose up -d` would silently reuse the STALE local image and run old
# code. So pull the freshly-pushed image first.
echo "Pulling freshly-pushed image into local store..."
# docker-compose.yml runs rvbcrs/opennova:LATEST, so we MUST refresh the local
# :latest tag (not just :$NEW) or `up -d` keeps running the stale local :latest.
docker pull "rvbcrs/opennova:latest" 2>/dev/null || docker compose pull 2>/dev/null
docker pull "rvbcrs/opennova:$NEW" 2>/dev/null || true
echo "Restarting local container..."
docker compose down 2>/dev/null
docker compose up -d 2>/dev/null

echo ""
echo "Released v$NEW"
echo "  Docker: rvbcrs/opennova:latest + rvbcrs/opennova:$NEW"
echo "  Local container restarted"
