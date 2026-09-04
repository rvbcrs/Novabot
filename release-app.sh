#!/bin/bash
# release-app.sh — Build the OpenNova Android APK and write a release
# manifest. Both files end up in dist/app-release/. You upload them
# manually to the central NAS host (https://downloads.ramonvanbruggen.nl/app/).
#
# The app polls https://downloads.ramonvanbruggen.nl/app/manifest.json directly,
# so there is no per-server endpoint and no Docker image bloat.
#
# Usage:
#   1. Bump app/app.json expo.version (semver).
#   2. ./release-app.sh
#   3. Drag dist/app-release/{manifest.json, opennova-vX.Y.Z.apk} to the NAS.
#
# Prerequisites:
#   - eas-cli installed (npm install -g eas-cli) — used in --local mode, no credits.
#   - JDK 17+ and Android SDK on PATH.
set -e

cd "$(dirname "$0")"

# EAS --local on macOS fails when its build working dir sits behind a symlink
# (the default temp dir resolves via /tmp -> /private/tmp). CMake/ninja then mix
# the logical and physical paths and can't find react-native-worklets'
# libworklets.so, failing with:
#   ninja: error: '.../libworklets.so', needed by '.../libexpo-modules-core.so',
#   missing and no known rule to make it
# Pin the working dir to a real (non-symlinked) path under $HOME so the build is
# reproducible regardless of the caller's TMPDIR. See reanimated#9151 / expo#42893.
export EAS_LOCAL_BUILD_WORKINGDIR="${EAS_LOCAL_BUILD_WORKINGDIR:-$HOME/tmp/eas-build}"
mkdir -p "$EAS_LOCAL_BUILD_WORKINGDIR"
echo "EAS local build working dir: $EAS_LOCAL_BUILD_WORKINGDIR"

VERSION=$(node -p "require('./app/app.json').expo.version")
echo "Building APK for v${VERSION}..."

OUT_DIR="dist/app-release"
mkdir -p "${OUT_DIR}"

APK_NAME="opennova-v${VERSION}.apk"
APK_OUT="${OUT_DIR}/${APK_NAME}"

# ── Build APK locally via EAS (no cloud queue, no credits) ───────────────────
(
  cd app
  # Use the globally-installed eas-cli directly. `npx eas` only resolves from
  # node_modules / auto-install and misses a global eas that lives under a
  # different nvm node, failing with "could not determine executable to run".
  eas build \
    --platform android \
    --profile apk-release \
    --local \
    --non-interactive \
    --output "../${APK_OUT}"
)

# ── Integrity metadata ───────────────────────────────────────────────────────
SHA=$(shasum -a 256 "${APK_OUT}" | awk '{print $1}')
SIZE=$(stat -f '%z' "${APK_OUT}" 2>/dev/null || stat -c '%s' "${APK_OUT}")

# ── Manifest ─────────────────────────────────────────────────────────────────
# apkUrl is the absolute URL on the central NAS host. Cache-busted on the
# client side; the static path here matches what the upload step expects.
APK_URL="https://downloads.ramonvanbruggen.nl/app/${APK_NAME}"
RELEASED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Release notes — user-friendly summary ────────────────────────────────────
# Earlier versions dumped `git log --oneline` which leaked commit hashes,
# conventional-commit prefixes, and internal cleanup noise. Build a curated
# bullet list instead:
#   - find commits since the previous app version tag (or the last
#     `release(app):` commit if no tag), so each release shows only what
#     changed THIS cycle
#   - keep commits scoped to the app (or unscoped fixes/features that affect
#     the app) and drop pure chore/test/docs/release noise
#   - strip the conventional-commit prefix and capitalise so each line reads
#     like a release-note bullet, not a git subject
PREV_TAG=$(git tag --list 'app-v*' --sort=-v:refname | head -1)
if [ -n "$PREV_TAG" ]; then
  COMMIT_RANGE="${PREV_TAG}..HEAD"
else
  # Fallback: anchor on the SECOND most recent `release(app)` commit. The
  # current build was preceded by its own bump commit, so the most-recent
  # match is the bump for THIS release (range would be empty). Skip past
  # it to the previous version's bump so the range covers everything that
  # changed since the last shipped APK.
  PREV_BUMP=$(git log --grep='^release(app)' --pretty=%H | sed -n '2p')
  COMMIT_RANGE="${PREV_BUMP:+${PREV_BUMP}..HEAD}"
fi

RELEASE_NOTES=$(
  git log --pretty=format:'%s' ${COMMIT_RANGE} 2>/dev/null \
    | grep -vE '^(release|chore|test|docs|ci|build|style|refactor)(\(|:)' \
    | grep -vE '^Merge ' \
    | grep -E '\([^)]*(app|i18n|admin|firmware)[^)]*\)|^(fix|feat):' \
    | sed -E 's/^(fix|feat|perf)\([^)]+\):[[:space:]]+//' \
    | sed -E 's/^(fix|feat|perf):[[:space:]]+//' \
    | sed -E 's/[[:space:]]*\(#[0-9]+\)[[:space:]]*$//' \
    | awk 'NF { sub(/^[[:space:]]+/,""); first=toupper(substr($0,1,1)); rest=substr($0,2); print "• " first rest }' \
    | head -20 \
    | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read().rstrip().replace("—","-").replace("–","-")))'
)
# Empty-list fallback so the manifest stays valid JSON.
if [ -z "$RELEASE_NOTES" ] || [ "$RELEASE_NOTES" = '""' ]; then
  RELEASE_NOTES='"Maintenance release."'
fi

SERVER_VERSION=$(node -p "require('./server/package.json').version")

cat > "${OUT_DIR}/manifest.json" <<EOF
{
  "version": "${VERSION}",
  "platform": "android",
  "apkUrl": "${APK_URL}",
  "sha256": "${SHA}",
  "sizeBytes": ${SIZE},
  "releaseNotes": ${RELEASE_NOTES},
  "minSupportedServerVersion": "${SERVER_VERSION}",
  "releasedAt": "${RELEASED_AT}"
}
EOF

echo ""
echo "Built v${VERSION}:"
echo "  APK:      ${APK_OUT} ($(du -h "${APK_OUT}" | awk '{print $1}'))"
echo "  Manifest: ${OUT_DIR}/manifest.json"
echo "  SHA256:   ${SHA}"
echo ""
echo "Next: upload both files to the NAS folder behind"
echo "      https://downloads.ramonvanbruggen.nl/app/"
