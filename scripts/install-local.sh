#!/bin/bash
# Build a release version of the app and install it into /Applications.
#
# This is for personal/local use — the app is built and ad-hoc signed on your
# own machine (no Apple Developer ID / notarization needed to run it locally).
# Re-run this script whenever you want to update your installed copy.
#
# Usage: ./scripts/install-local.sh
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# rustup installs cargo to ~/.cargo/bin, which isn't always on PATH.
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

APP_NAME="Worktree Manager"
APP_BUNDLE="src-tauri/target/release/bundle/macos/${APP_NAME}.app"
DEST="/Applications/${APP_NAME}.app"

echo "==> Building ${APP_NAME} (release). First build takes a few minutes..."
pnpm tauri build

if [ ! -d "$APP_BUNDLE" ]; then
  echo "ERROR: build did not produce \"$APP_BUNDLE\"" >&2
  exit 1
fi

echo "==> Installing to \"$DEST\"..."
# Quit a running copy so the replace doesn't fail, then swap the bundle.
osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
rm -rf "$DEST"
cp -R "$APP_BUNDLE" "$DEST"

# Locally-built apps aren't quarantined, but strip the attribute just in case.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo ""
echo "✓ Installed \"${APP_NAME}\" to /Applications."
echo "  Launch it from Spotlight or /Applications — no rebuild needed to use it."
echo "  Re-run this script to update after making changes."
