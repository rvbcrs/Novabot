#!/bin/bash
# Release script: run tests, write the release notes, commit, tag and push.
# The tag makes GitHub build and push the Docker image; this script waits for it.
# Tests run FIRST — a failing test aborts before any commit, tag or push.
set -e
. "$(dirname "$0")/tools/quiet-build.sh"

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
# Flaky-onderzoek (2026-09-09): elke respons >= 400 in de suite wordt met
# headers en poortpaar gelogd, zodat een 403/400 "uit het niets" traceerbaar is.
export TEST_HTTP_TRACE=1 TEST_HTTP_TRACE_FILE="/tmp/novabot-test-http-trace-$(date +%Y%m%d-%H%M%S).log"
( cd server && npm test --silent )

# Version = date.time (e.g. 2026.0410.1523)
NEW=$(date +"%Y.%m%d.%H%M")
echo "Version: $NEW"

# Release notes voor de dashboard-popup: commits sinds de vorige tag,
# gegroepeerd op Dashboard/App/Admin/Firmware/Server. Bakt mee in de image, en
# draagt ook het versienummer: de server leest het daaruit.
#
# server/package.json wordt NIET meer gebumpt. Dat is het bestand dat de
# Dockerfile vlak vóór `npm ci` kopieert, in twee stages, dus een versiebump
# gooide bij elke release de dependency-cache weg voor beide platforms. Gemeten
# op 15-09-2026: de beta's ervóór bouwden in vier minuten met npm ci zes van de
# zes keer gecached, de release erna miste en `npm ci` alleen al kostte 863 s
# onder arm64-emulatie.
node scripts/generate-release-notes.mjs --new "$NEW"

# Commit notes
git add server/release-notes.json
git commit -m "release: v$NEW"
git tag "v$NEW"
git push && git push --tags

# The image is built on GitHub (.github/workflows/docker.yml), started by the
# tag just pushed: it runs the tests again, builds amd64 and arm64 on their own
# hardware, smoke-tests and only then pushes rvbcrs/opennova:latest, :$NEW and
# :beta. Nothing is built, pushed or started on this machine, so no local
# container takes over the mowers via mDNS. Wait for it, so a failed build or
# push shows here.
echo "GitHub builds the image for v$NEW (.github/workflows/docker.yml)..."
RUN_ID=""
for _ in $(seq 1 30); do
  RUN_ID=$(gh run list --workflow docker.yml --branch "v$NEW" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  [ -n "$RUN_ID" ] && break
  sleep 5
done
if [ -z "$RUN_ID" ]; then
  echo "ERROR: no docker workflow run for v$NEW; see https://github.com/rvbcrs/Novabot/actions" >&2
  exit 1
fi
gh run watch "$RUN_ID" --exit-status --interval 30

echo ""
echo "Released v$NEW"
echo "  Docker: rvbcrs/opennova:latest + rvbcrs/opennova:$NEW + rvbcrs/opennova:beta (built by GitHub)"
