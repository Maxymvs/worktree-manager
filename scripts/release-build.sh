#!/usr/bin/env bash
#
# release-build.sh — build a code-signed + notarized universal macOS .dmg.
#
# Usage:
#   ./scripts/release-build.sh                  Signed + notarized (Tauri notarizes)
#   ./scripts/release-build.sh --skip-notarize   Signed only (fast local check)
#
# Credentials come from environment variables, loaded from a gitignored
# `.env.signing` at the repo root if present (see .env.signing.example):
#   APPLE_SIGNING_IDENTITY, APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID
#
# Tauri v2 notarizes the bundle itself when APPLE_ID / APPLE_PASSWORD /
# APPLE_TEAM_ID are set alongside a signing identity — this script does not
# shell out to notarytool for the main path, it only verifies the result.
#
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: this script is macOS-only." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; NC='\033[0m'

SKIP_NOTARIZE=0
if [[ $# -gt 0 ]]; then
  case "$1" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
    -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "ERROR: unknown option: $1" >&2; exit 1 ;;
  esac
fi

# rustup is not always on PATH (see CLAUDE.md).
if [[ -f "$HOME/.cargo/env" ]]; then
  # shellcheck disable=SC1091
  . "$HOME/.cargo/env"
fi

# Load credentials without putting them in shell history.
if [[ -f "./.env.signing" ]]; then
  echo -e "${BLUE}Loading credentials from .env.signing${NC}"
  set -a
  # shellcheck disable=SC1091
  . ./.env.signing
  set +a
fi

# ---------------------------------------------------------------- preflight ---
missing=0
require_var() {
  local name="$1" hint="$2"
  if [[ -z "${!name:-}" ]]; then
    echo -e "${RED}✗ Missing required environment variable: ${name}${NC}" >&2
    echo "    $hint" >&2
    missing=1
  fi
}

require_var APPLE_SIGNING_IDENTITY \
  'Full "Developer ID Application: Name (TEAMID)" string. Run ./scripts/signing-setup.sh --check'
require_var APPLE_ID \
  'Apple ID email of your Apple Developer account.'
require_var APPLE_PASSWORD \
  'App-specific password from appleid.apple.com (NOT your account password).'
require_var APPLE_TEAM_ID \
  '10-character Team ID from developer.apple.com -> Membership details.'

if [[ $missing -ne 0 ]]; then
  echo "" >&2
  echo -e "${RED}Aborting before build.${NC} Copy .env.signing.example to .env.signing and fill it in." >&2
  exit 1
fi

echo -e "${BLUE}Verifying signing identity is present in the keychain...${NC}"
if ! security find-identity -v -p codesigning | grep -qF "$APPLE_SIGNING_IDENTITY"; then
  echo -e "${RED}✗ Signing identity not found in keychain:${NC}" >&2
  echo "    $APPLE_SIGNING_IDENTITY" >&2
  echo "" >&2
  security find-identity -v -p codesigning >&2 || true
  echo "" >&2
  echo "Run ./scripts/signing-setup.sh to create and import a Developer ID certificate." >&2
  exit 1
fi
echo -e "${GREEN}✓${NC} Signing identity found"

if [[ $SKIP_NOTARIZE -eq 1 ]]; then
  echo -e "${YELLOW}--skip-notarize: unsetting APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID for this build${NC}"
  unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
fi

# -------------------------------------------------------------------- build ---
echo ""
echo -e "${BLUE}=== Building universal release bundle (this takes several minutes) ===${NC}"
pnpm tauri build --target universal-apple-darwin --bundles app,dmg

# ---------------------------------------------------------------- artifacts ---
BUNDLE_DIR="src-tauri/target/universal-apple-darwin/release/bundle"
APP_PATH="$BUNDLE_DIR/macos/Worktree Manager.app"

# Select the dmg by the version we just built, not lexically: once several
# versions accumulate in bundle/dmg/, `find | sort | head -1` picks the OLDEST
# (0.7.3 sorts before 0.8.0) and we would notarize and report a stale artifact.
VERSION="$(node -p "require('./src-tauri/tauri.conf.json').version" 2>/dev/null || true)"
if [[ -z "$VERSION" ]]; then
  echo -e "${RED}✗ Could not read version from src-tauri/tauri.conf.json${NC}" >&2
  echo "    Tried: node -p \"require('./src-tauri/tauri.conf.json').version\"" >&2
  exit 1
fi
DMG_PATH="$BUNDLE_DIR/dmg/Worktree Manager_${VERSION}_universal.dmg"

echo ""
if [[ ! -d "$APP_PATH" ]]; then
  echo -e "${RED}✗ .app bundle not found at: $APP_PATH${NC}" >&2
  exit 1
fi
if [[ ! -f "$DMG_PATH" ]]; then
  echo -e "${RED}✗ Expected .dmg for version $VERSION not found:${NC}" >&2
  echo "    $DMG_PATH" >&2
  echo "" >&2
  echo "Contents of $BUNDLE_DIR/dmg:" >&2
  if [[ -d "$BUNDLE_DIR/dmg" ]]; then
    ls -1 "$BUNDLE_DIR/dmg" >&2 || true
  else
    echo "    (directory does not exist)" >&2
  fi
  exit 1
fi
echo -e "${GREEN}✓${NC} Artifacts found"
echo "    app: $APP_PATH"
echo "    dmg: $DMG_PATH"

# The executable is named after the crate (Grovr), not the productName, so read
# it from Info.plist rather than guessing.
BIN_NAME="$(plutil -extract CFBundleExecutable raw "$APP_PATH/Contents/Info.plist" 2>/dev/null || true)"
BIN_PATH="$APP_PATH/Contents/MacOS/$BIN_NAME"
if [[ -z "$BIN_NAME" || ! -f "$BIN_PATH" ]]; then
  # Fall back to whatever single executable is in MacOS/.
  while IFS= read -r f; do BIN_PATH="$f"; break; done \
    < <(find "$APP_PATH/Contents/MacOS" -maxdepth 1 -type f -perm -u+x | sort)
fi

# ------------------------------------------------------------ notarize dmg ---
# Tauri notarizes and staples the .app, then builds the .dmg around it and only
# SIGNS the dmg — it never notarizes the dmg itself. Gatekeeper then rejects the
# downloaded dmg with "source=Unnotarized Developer ID" even though the app
# inside is properly notarized, so the first thing a teammate sees is a scary
# "Apple cannot check it for malicious software" warning. Submit the dmg too and
# staple its own ticket.
if [[ $SKIP_NOTARIZE -eq 0 ]]; then
  echo ""
  if xcrun stapler validate "$DMG_PATH" >/dev/null 2>&1; then
    echo -e "${GREEN}✓${NC} dmg already has a stapled ticket"
  else
    echo -e "${BLUE}=== Notarizing the .dmg (Apple's queue: usually 1-15 min) ===${NC}"
    # NOTE: --password places the app-specific password in argv, where `ps` can
    # see it for the duration of the call. notarytool offers no env/stdin form;
    # if that matters, run `xcrun notarytool store-credentials <profile>` once
    # and swap the three auth flags below for `-p <profile>`.
    submit_out=""
    if ! submit_out="$(xcrun notarytool submit "$DMG_PATH" \
          --apple-id "$APPLE_ID" \
          --password "$APPLE_PASSWORD" \
          --team-id "$APPLE_TEAM_ID" \
          --wait 2>&1)"; then
      echo "$submit_out" >&2
      echo -e "${RED}✗ dmg notarization call failed${NC}" >&2
      exit 1
    fi
    echo "$submit_out"
    if ! grep -q "status: Accepted" <<<"$submit_out"; then
      echo -e "${RED}✗ dmg notarization did not reach Accepted${NC}" >&2
      echo "Inspect the log with:" >&2
      echo "  xcrun notarytool log <submission-id> --apple-id \"\$APPLE_ID\" --password \"\$APPLE_PASSWORD\" --team-id \"\$APPLE_TEAM_ID\"" >&2
      exit 1
    fi
    xcrun stapler staple "$DMG_PATH"
  fi
fi

# ------------------------------------------------------------ verification ---
# Counter rather than an array: bash 3.2 (macOS system bash) errors on
# ${#arr[@]} for an empty array under `set -u`.
FAIL_COUNT=0
RESULTS=()   # always non-empty by the time it is expanded

check() {
  local label="$1"; shift
  echo ""
  echo -e "${BLUE}--- $label ---${NC}"
  if "$@"; then
    RESULTS+=("PASS  $label")
  else
    RESULTS+=("FAIL  $label")
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

check "codesign --verify (deep, strict)" \
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"

# -t exec, not -t install: `install` is the assessment type for installer
# packages, and misreports on a .app bundle.
check "spctl assessment (-t exec)" \
  spctl -a -vvv -t exec "$APP_PATH"

if [[ $SKIP_NOTARIZE -eq 1 ]]; then
  RESULTS+=("SKIP  stapler validate (--skip-notarize)")
  RESULTS+=("SKIP  spctl assessment of .dmg (--skip-notarize)")
else
  check "stapler validate (.app)" xcrun stapler validate "$APP_PATH"
  check "stapler validate (.dmg)" xcrun stapler validate "$DMG_PATH"
  # This is the check that mirrors what a teammate actually experiences when
  # they double-click the downloaded dmg. Must say "Notarized Developer ID".
  check "spctl assessment of .dmg (-t open)" \
    spctl -a -t open --context context:primary-signature -vv "$DMG_PATH"
fi

check_universal() {
  local archs
  archs="$(lipo -archs "$BIN_PATH")" || return 1
  echo "archs: $archs"
  [[ "$archs" == *x86_64* && "$archs" == *arm64* ]]
}
check "universal binary (lipo -archs)" check_universal

# ---------------------------------------------------------------- summary ----
echo ""
echo -e "${BLUE}=== Verification summary ===${NC}"
for line in "${RESULTS[@]}"; do
  case "$line" in
    PASS*) echo -e "${GREEN}✓ ${line#PASS  }${NC}" ;;
    FAIL*) echo -e "${RED}✗ ${line#FAIL  }${NC}" ;;
    *)     echo -e "${YELLOW}- ${line#SKIP  }${NC}" ;;
  esac
done

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo ""
  echo -e "${RED}=== FAILED ($FAIL_COUNT check(s)) ===${NC}" >&2
  exit 1
fi

echo ""
echo -e "${GREEN}=== PASS — release build is signed$([[ $SKIP_NOTARIZE -eq 1 ]] && echo " (notarization skipped)" || echo " and notarized") ===${NC}"
echo ""
echo "DMG: $DMG_PATH"
