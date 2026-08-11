---
name: bump
description: Bump version in all config files and commit
argument-hint: <version> (e.g., 0.6.0)
allowed-tools: Bash(./.claude/skills/bump/bump.sh:*)
---

# Version Bump Skill

Updates version, builds signed app, and creates a single commit.

## Prerequisites

- Git status must be clean
- Signing credentials in the gitignored `.env.signing` (see
  `.env.signing.example`): `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID`. `scripts/release-build.sh` loads that file
  itself, so nothing needs to be exported into your shell.
- A Developer ID Application certificate in the keychain
  (`./scripts/signing-setup.sh --check` to confirm).

## Usage

```bash
./bump.sh <version>
# Example: ./bump.sh 0.8.0
```

## What it does

1. Validates semantic version format (X.Y.Z)
2. Checks git status is clean
3. Updates version in:
   - `package.json`
   - `src-tauri/tauri.conf.json`
   - `src-tauri/Cargo.toml`
4. Runs `scripts/release-build.sh`, the single build path: universal
   (`--target universal-apple-darwin`), signed, notarized and stapled for both
   the `.app` and the `.dmg`, then verified with codesign/spctl/stapler/lipo
5. Creates commit: `chore: bump version to X.Y.Z`

Artifacts land in `src-tauri/target/universal-apple-darwin/release/bundle/`,
**not** `src-tauri/target/release/bundle/`.

## Exit codes

- `0`: Success
- `1`: Invalid arguments or validation failed
- `2`: Environment variables missing or git status not clean
- `4`: Signature verification failed
