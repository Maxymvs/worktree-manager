#!/bin/bash
set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory (skills/bump/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Navigate to project root (3 levels up from .claude/skills/bump/)
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

cd "$PROJECT_ROOT"

# Validate arguments
VERSION="$1"

if [[ -z "$VERSION" ]]; then
  echo -e "${RED}ERROR: Version argument required${NC}"
  echo "Usage: $0 <version>"
  echo "Example: $0 0.6.0"
  exit 1
fi

# Validate semantic version format
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo -e "${RED}ERROR: Invalid version format${NC}"
  echo "Expected: X.Y.Z (e.g., 0.6.0)"
  echo "Got: $VERSION"
  exit 1
fi

# Check git status
if [[ -n "$(git status --porcelain)" ]]; then
  echo -e "${RED}ERROR: Uncommitted changes detected${NC}"
  echo ""
  git status --short
  echo ""
  echo "Please commit or stash your changes first"
  exit 2
fi

# Check current branch
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "main" ]]; then
  echo -e "${YELLOW}WARNING: Not on main branch (current: $BRANCH)${NC}"
  read -p "Continue anyway? [y/N] " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
  fi
fi

echo -e "${BLUE}=== Worktree Manager Bump & Build ===${NC}"
echo ""

# Get current version
CURRENT_VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: "\(.*\)".*/\1/')
echo "Current version: $CURRENT_VERSION"
echo "New version: $VERSION"
echo ""

# === Step 1: Update version in all files ===
echo -e "${BLUE}Step 1: Updating version...${NC}"

echo "  Updating package.json..."
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$VERSION\"/" package.json

echo "  Updating src-tauri/tauri.conf.json..."
sed -i '' "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json

echo "  Updating src-tauri/Cargo.toml..."
sed -i '' "s/^version = \"$CURRENT_VERSION\"/version = \"$VERSION\"/" src-tauri/Cargo.toml

echo -e "${GREEN}✓${NC} Version updated to $VERSION"

# === Step 2: Build, sign, notarize ===
# Delegated to scripts/release-build.sh so there is ONE build path. It loads
# credentials from the gitignored .env.signing, builds universal
# (--target universal-apple-darwin), notarizes and staples both the .app and
# the .dmg, and verifies with codesign/spctl/stapler/lipo — so no separate
# signature check is needed here.
echo ""
echo -e "${BLUE}Step 2: Building signed + notarized universal release...${NC}"
echo ""

if [[ ! -x scripts/release-build.sh ]]; then
  echo -e "${RED}ERROR: scripts/release-build.sh not found or not executable${NC}"
  exit 2
fi

pnpm install

if ! ./scripts/release-build.sh; then
  echo ""
  echo -e "${RED}ERROR: release build failed — version files were updated but NOT committed${NC}"
  echo "Fix the build, then re-run this script or commit the version bump by hand."
  exit 4
fi

# === Step 3: Commit all changes ===
echo ""
echo "Creating commit..."

# Cargo.lock has an entry for this app's own crate (named `grovr` internally —
# see CLAUDE.md), so the build rewrites its version on every bump. Cargo.lock is
# tracked (release builds must be reproducible), so it has to go in the same
# commit — otherwise the tree is left dirty and the next bump fails its own
# clean-tree precondition.
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: bump version to $VERSION"

# === Summary ===
echo ""
echo -e "${GREEN}=== Bump & Build Complete ===${NC}"
echo ""
echo "Version: $VERSION"
echo ""
echo "Artifacts:"
ls -lh src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg 2>/dev/null \
  || echo "  (no DMG found)"
echo ""
echo "Next: push the commit, then hand out the .dmg — or tag to trigger CI"
echo "      (CI needs the six Apple repo secrets; see docs/DISTRIBUTION.md)."
