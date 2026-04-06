#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║     OpenNova Bootstrap — Build Script      ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# ── Step 1: Install server dependencies ────────────────────────────────────
echo "[1/4] Installing server dependencies..."
npm install
echo "      Done."
echo ""

# ── Step 2: Build wizard frontend ──────────────────────────────────────────
echo "[2/4] Building wizard frontend..."
cd wizard
npm install
npm run build
cd ..
echo "      Wizard built → wizard/dist/"
echo ""

# ── Step 3: Compile server TypeScript ──────────────────────────────────────
echo "[3/4] Compiling server TypeScript..."
npx tsc
echo "      Server compiled → dist/"
echo ""

# ── Step 4: Package standalone binaries ────────────────────────────────────
echo "[4/4] Packaging standalone binaries..."
mkdir -p dist/binaries

npx @yao-pkg/pkg dist/index.js \
  --assets "wizard/dist/**/*" \
  --target node20-macos-arm64,node20-macos-x64,node20-win-x64 \
  --output dist/binaries/novabot-bootstrap

# ── Step 5: Copy Noble BLE native prebuilds alongside binaries ─────────────
echo "[5/5] Copying Noble BLE native prebuilds..."

NOBLE_PREBUILDS="node_modules/@stoprocent/noble/prebuilds"
BIN_DIR="dist/binaries"

# macOS (universal binary: arm64 + x64)
if [ -d "$NOBLE_PREBUILDS/darwin-x64+arm64" ]; then
    mkdir -p "$BIN_DIR/prebuilds/darwin-x64+arm64"
    cp "$NOBLE_PREBUILDS/darwin-x64+arm64/"*.node "$BIN_DIR/prebuilds/darwin-x64+arm64/"
    echo "      macOS prebuilds copied"
fi

# Windows x64
if [ -d "$NOBLE_PREBUILDS/win32-x64" ]; then
    mkdir -p "$BIN_DIR/prebuilds/win32-x64"
    cp "$NOBLE_PREBUILDS/win32-x64/"*.node "$BIN_DIR/prebuilds/win32-x64/"
    echo "      Windows prebuilds copied"
fi

# Linux x64 + arm64 (for future use)
for arch in linux-x64 linux-arm64; do
    if [ -d "$NOBLE_PREBUILDS/$arch" ]; then
        mkdir -p "$BIN_DIR/prebuilds/$arch"
        cp "$NOBLE_PREBUILDS/$arch/"*.node "$BIN_DIR/prebuilds/$arch/"
        echo "      $arch prebuilds copied"
    fi
done

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Build complete!                           ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "Binaries:"
ls -lh "$BIN_DIR"/novabot-bootstrap-*
echo ""
echo "Native prebuilds:"
find "$BIN_DIR/prebuilds" -name "*.node" -exec ls -lh {} \;
echo ""
echo "Distribute the binary + prebuilds/ folder together:"
echo "  macOS ARM64: $BIN_DIR/novabot-bootstrap-macos-arm64 + prebuilds/"
echo "  macOS x64:   $BIN_DIR/novabot-bootstrap-macos-x64   + prebuilds/"
echo "  Windows x64: $BIN_DIR/novabot-bootstrap-win-x64.exe + prebuilds/"
echo ""
