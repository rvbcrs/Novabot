#!/bin/bash
# release-beta.sh — build the CURRENT code and push it to rvbcrs/opennova:beta.
#
# A moving "beta" channel for the latest stuff to test on a beta device, WITHOUT
# touching production. Unlike release.sh it does NOT bump the version, commit/tag
# git, push :latest, or restart the local container (so no mDNS hijack of the LAN
# mowers).
#
#   Beta device:  image: rvbcrs/opennova:beta   (then `docker compose pull && up -d`)
#   Promote a good beta to production:
#     ./release.sh                                       # normal versioned release (rebuilds), OR
#     docker buildx imagetools create \                  # retag the SAME tested bytes, no rebuild
#       -t rvbcrs/opennova:latest rvbcrs/opennova:beta
set -e
cd "$(dirname "$0")"

# ── Pick a node >=18 (vitest needs it; system /usr/local/bin/node may be v8) ──
need_modern_node() {
  command -v node >/dev/null 2>&1 || return 1
  local major; major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null) || return 1
  [ "$major" -ge 18 ]
}
if ! need_modern_node && [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_LATEST=$(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sed 's/^v//' \
    | awk -F. '$1 >= 18' | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)
  [ -n "$NVM_LATEST" ] && export PATH="$HOME/.nvm/versions/node/v$NVM_LATEST/bin:$PATH" \
    && echo "Using node v$NVM_LATEST from nvm"
fi
need_modern_node || { echo "ERROR: node >=18 required for vitest." >&2; exit 1; }

# Tests gate the beta too — a broken beta on a real device wastes more time than
# it saves. ponytail: comment out for a code-only beta push when you're in a hurry.
echo "Running server tests..."
( cd server && npm test --silent )

# Smoke vóór de push: kan de AI-classifier (onnxruntime, glibc) laden in de
# verse image? Les van 2026-07-19: Alpine/musl brak dit stil — tests draaien
# met een gestubde classifier op de host en zien zoiets nooit.
echo "Smoke: classifier-import in verse image (host-arch)..."
docker buildx build --platform "linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" \
  --builder multiplatform-builder -t opennova-smoke --load .
docker run --rm --network none --workdir /app/server --entrypoint node opennova-smoke \
  -e "import('@huggingface/transformers').then(()=>{console.log('smoke OK');process.exit(0)}).catch(e=>{console.error('smoke FAALT:',e.message);process.exit(1)})"

echo "Building + pushing rvbcrs/opennova:beta (amd64 + arm64)..."
docker buildx build --platform linux/amd64,linux/arm64 \
  --builder multiplatform-builder \
  -t "rvbcrs/opennova:beta" \
  --push .

echo ""
echo "Pushed rvbcrs/opennova:beta"
echo "Beta device pulls :beta. Promote when good: ./release.sh (or the imagetools retag in this header)."
