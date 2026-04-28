#!/usr/bin/env bash
# Build a signed release APK locally, ready to send to testers.
#
# Prerequisites (one-time setup):
#   1. Download the EAS keystore once:
#        cd app && eas credentials --platform android
#        → preview profile → Keystore → Download existing keystore
#        Save to: ~/keystores/opennova.jks
#      Note the storePassword, keyAlias, keyPassword shown in the terminal.
#
#   2. Create ~/.opennova-signing.env with the credentials:
#        OPENNOVA_STORE_FILE=/Users/rvbcrs/keystores/opennova.jks
#        OPENNOVA_STORE_PASSWORD=...
#        OPENNOVA_KEY_ALIAS=...
#        OPENNOVA_KEY_PASSWORD=...
#      chmod 600 ~/.opennova-signing.env
#
#   3. Java 17 + Android SDK installed (already present on this machine).
#
# Usage:
#   ./scripts/build-android-apk.sh           # builds release APK
#   ./scripts/build-android-apk.sh --clean   # wipes android/ first

set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
SIGNING_ENV="${HOME}/.opennova-signing.env"

if [[ ! -f "$SIGNING_ENV" ]]; then
  echo "ERROR: $SIGNING_ENV missing. See header of this script for setup." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$SIGNING_ENV"

: "${OPENNOVA_STORE_FILE:?Missing in signing env}"
: "${OPENNOVA_STORE_PASSWORD:?Missing in signing env}"
: "${OPENNOVA_KEY_ALIAS:?Missing in signing env}"
: "${OPENNOVA_KEY_PASSWORD:?Missing in signing env}"

if [[ ! -f "$OPENNOVA_STORE_FILE" ]]; then
  echo "ERROR: keystore not found at $OPENNOVA_STORE_FILE" >&2
  exit 1
fi

# Use JDK 17 (Gradle compatibility with RN 0.74+ — JDK 21 fails with RN AGP).
for candidate in \
  "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home" \
  "/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home" \
  "/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home"; do
  if [[ -d "$candidate" ]]; then
    export JAVA_HOME="$candidate"
    break
  fi
done
export PATH="$JAVA_HOME/bin:$PATH"
echo "Using JDK: $(java -version 2>&1 | head -1)"

# Step 1: regenerate native android/ folder from app.json (idempotent).
if [[ "${1:-}" == "--clean" ]] || [[ ! -d "$APP_DIR/android" ]]; then
  echo "Running expo prebuild (clean)..."
  npx expo prebuild --platform android --clean
else
  echo "Running expo prebuild (incremental)..."
  npx expo prebuild --platform android --no-install
fi

# Step 2: wire signing config into android/gradle.properties.
GRADLE_PROPS="$APP_DIR/android/gradle.properties"

# Strip any prior OPENNOVA_* lines so reruns stay clean.
sed -i.bak '/^OPENNOVA_/d' "$GRADLE_PROPS"
rm -f "${GRADLE_PROPS}.bak"

cat >>"$GRADLE_PROPS" <<EOF

# Signing config (managed by build-android-apk.sh)
OPENNOVA_STORE_FILE=$OPENNOVA_STORE_FILE
OPENNOVA_STORE_PASSWORD=$OPENNOVA_STORE_PASSWORD
OPENNOVA_KEY_ALIAS=$OPENNOVA_KEY_ALIAS
OPENNOVA_KEY_PASSWORD=$OPENNOVA_KEY_PASSWORD
EOF

# Step 3: patch android/app/build.gradle to use the signing config.
BUILD_GRADLE="$APP_DIR/android/app/build.gradle"

if ! grep -q "OPENNOVA_STORE_FILE" "$BUILD_GRADLE"; then
  python3 - "$BUILD_GRADLE" <<'PY'
import re
import sys

path = sys.argv[1]
with open(path, 'r') as f:
    content = f.read()

signing_block = """
        release {
            if (project.hasProperty('OPENNOVA_STORE_FILE')) {
                storeFile file(OPENNOVA_STORE_FILE)
                storePassword OPENNOVA_STORE_PASSWORD
                keyAlias OPENNOVA_KEY_ALIAS
                keyPassword OPENNOVA_KEY_PASSWORD
            }
        }"""

content = re.sub(
    r"(signingConfigs\s*\{\s*debug\s*\{[^}]*\})",
    r"\1" + signing_block,
    content,
    count=1,
)

content = re.sub(
    r"(buildTypes\s*\{\s*release\s*\{[^}]*?signingConfig\s+signingConfigs\.)debug",
    r"\1release",
    content,
    count=1,
)

with open(path, 'w') as f:
    f.write(content)
PY
  echo "Patched android/app/build.gradle with release signing config."
fi

# Step 4: build the release APK.
cd "$APP_DIR/android"
echo "Running ./gradlew assembleRelease..."
./gradlew assembleRelease

APK_PATH="$APP_DIR/android/app/build/outputs/apk/release/app-release.apk"
if [[ -f "$APK_PATH" ]]; then
  VERSION=$(grep '"version"' "$APP_DIR/app.json" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')
  OUT_DIR="$APP_DIR/builds"
  mkdir -p "$OUT_DIR"
  STAMP=$(date +%Y%m%d-%H%M)
  OUT_APK="$OUT_DIR/opennova-v${VERSION}-${STAMP}.apk"
  cp "$APK_PATH" "$OUT_APK"
  echo ""
  echo "✓ APK ready: $OUT_APK"
  echo "  Size: $(du -h "$OUT_APK" | cut -f1)"
  echo ""
  echo "  Send this file to testers via AirDrop / Drive / email / Telegram."
  echo "  Testers must enable 'Install unknown apps' for their browser/file"
  echo "  manager once. Updates will install over the existing APK because"
  echo "  this build uses the same keystore as the EAS build."
else
  echo "ERROR: APK not produced at $APK_PATH" >&2
  exit 1
fi
