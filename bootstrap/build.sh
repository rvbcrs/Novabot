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

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Build complete!                           ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "Binaries:"
ls -lh dist/binaries/
echo ""
echo "Distribute:"
echo "  macOS ARM64: dist/binaries/novabot-bootstrap-macos-arm64"
echo "  macOS x64:   dist/binaries/novabot-bootstrap-macos-x64"
echo "  Windows x64: dist/binaries/novabot-bootstrap-win.exe"
echo ""
