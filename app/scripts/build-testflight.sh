#!/bin/bash
#
# Build & upload OpenNova iOS app to TestFlight via CLI.
#
# Usage:
#   cd app/
#   bash scripts/build-testflight.sh
#
# Prerequisites:
#   - Xcode installed with CLI tools
#   - Apple Developer account signed in (Xcode → Settings → Accounts)
#   - CocoaPods installed (gem install cocoapods)
#   - Node.js + npm installed
#
# What it does:
#   1. Clean prebuild (generates ios/ from app.json)
#   2. Archive (Release build, automatic signing)
#   3. Export + upload to App Store Connect (TestFlight)
#
# The app appears in TestFlight ~10-15 min after upload.

set -e

TEAM_ID="KN3YQ3Z9SN"
WORKSPACE="ios/OpenNova.xcworkspace"
SCHEME="OpenNova"
ARCHIVE_PATH="ios/build/OpenNova.xcarchive"
EXPORT_PATH="ios/build/export"
EXPORT_OPTIONS="scripts/ExportOptions.plist"

echo "=== OpenNova TestFlight Build ==="
echo ""

# ── Step 1: Clean prebuild ───────────────────────────────────────────
echo "→ Step 1/3: Prebuild (generating ios/ from app.json)..."
npx expo prebuild --platform ios --clean
echo "  ✓ Prebuild done"
echo ""

# ── Step 2: Archive ──────────────────────────────────────────────────
echo "→ Step 2/3: Archiving (this takes a few minutes)..."
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -sdk iphoneos \
  -archivePath "$ARCHIVE_PATH" \
  archive \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  -allowProvisioningUpdates \
  -quiet

echo "  ✓ Archive succeeded"
echo ""

# ── Step 3: Export + Upload ──────────────────────────────────────────
echo "→ Step 3/3: Uploading to TestFlight..."

# Create ExportOptions.plist if it doesn't exist
cat > "$EXPORT_OPTIONS" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>teamID</key>
	<string>KN3YQ3Z9SN</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>uploadSymbols</key>
	<false/>
	<key>destination</key>
	<string>upload</string>
</dict>
</plist>
PLIST

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates \
  -quiet

echo "  ✓ Upload to App Store Connect succeeded"
echo ""
echo "=== Done! App will appear in TestFlight in ~10-15 minutes ==="
