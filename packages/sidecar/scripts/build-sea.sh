#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SIDECAR_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BINARIES_DIR="$(cd "$SIDECAR_DIR/../../apps/desktop/src-tauri/binaries" && pwd 2>/dev/null || echo "$SIDECAR_DIR/../../apps/desktop/src-tauri/binaries")"

OS="$(uname -s)"
case "$OS" in
  Darwin*)        PLATFORM="macos" ;;
  Linux*)         PLATFORM="linux" ;;
  MINGW*|MSYS*)   PLATFORM="windows" ;;
  *)              echo "Unsupported OS: $OS"; exit 1 ;;
esac

detect_target_triple() {
  case "$PLATFORM" in
    macos)
      local arch; arch="$(uname -m)"
      if [ "$arch" = "arm64" ]; then echo "aarch64-apple-darwin"
      else echo "x86_64-apple-darwin"; fi ;;
    linux)   echo "x86_64-unknown-linux-gnu" ;;
    windows) echo "x86_64-pc-windows-msvc" ;;
  esac
}

TARGET_TRIPLE="${1:-$(detect_target_triple)}"
BINARY_NAME="sidecar-${TARGET_TRIPLE}"
[ "$PLATFORM" = "windows" ] && BINARY_NAME="${BINARY_NAME}.exe"

echo "==> Platform: $PLATFORM | Target: $TARGET_TRIPLE"

echo "==> [1/6] Building CJS bundle..."
cd "$SIDECAR_DIR"
npx esbuild src/index.ts \
  --bundle --platform=node --target=node20 --format=cjs \
  --outfile=dist/index.cjs \
  --external:bindings \
  --define:import.meta.url=import_meta_url \
  --banner:js="const import_meta_url = require('url').pathToFileURL(__filename).href;"

echo "==> [2/6] Creating SEA config..."
cat > "$SIDECAR_DIR/dist/sea-config.json" <<'SEAEOF'
{
  "main": "index.cjs",
  "output": "sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
SEAEOF

echo "==> [3/6] Generating SEA blob..."
cd "$SIDECAR_DIR/dist"
node --experimental-sea-config sea-config.json

echo "==> [4/6] Copying node binary and injecting blob..."
mkdir -p "$BINARIES_DIR"
NODE_BIN="$(command -v node)"
[ "$PLATFORM" = "windows" ] && NODE_BIN="${NODE_BIN}.exe"
cp "$NODE_BIN" "$BINARIES_DIR/$BINARY_NAME"

[ "$PLATFORM" = "macos" ] && codesign --remove-signature "$BINARIES_DIR/$BINARY_NAME"

POSTJECT_ARGS=(
  "$BINARIES_DIR/$BINARY_NAME"
  NODE_SEA_BLOB sea-prep.blob
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
)
[ "$PLATFORM" = "macos" ] && POSTJECT_ARGS+=(--macho-segment-name NODE_SEA)

npx postject "${POSTJECT_ARGS[@]}"

echo "==> [5/6] Signing binary..."
[ "$PLATFORM" = "macos" ] && codesign --sign - "$BINARIES_DIR/$BINARY_NAME"

echo "==> [6/6] Copying native addon..."
NATIVE_ADDON="$(find "$SIDECAR_DIR/node_modules/better-sqlite3" -name 'better_sqlite3.node' -type f 2>/dev/null | head -1)"
if [ -z "$NATIVE_ADDON" ]; then
  NATIVE_ADDON="$(find "$SIDECAR_DIR/../../node_modules" -name 'better_sqlite3.node' -type f 2>/dev/null | head -1)"
fi

if [ -n "$NATIVE_ADDON" ]; then
  cp "$NATIVE_ADDON" "$BINARIES_DIR/better_sqlite3.node"
  echo "    Copied: $NATIVE_ADDON"
else
  echo "    WARNING: better_sqlite3.node not found!"
  exit 1
fi

echo ""
echo "==> Done! Output:"
ls -lh "$BINARIES_DIR/$BINARY_NAME" "$BINARIES_DIR/better_sqlite3.node"
