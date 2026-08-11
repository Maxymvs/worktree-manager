# CLAUDE.md — Worktree Manager

## Project Overview

Worktree Manager is a desktop Git worktree manager built with Tauri v2 (Rust backend) and React 19 (TypeScript frontend). It provides a native desktop experience for managing git worktrees with GitHub/Jira integrations and live dev-server detection.

It is a fork of [j1king/grovr](https://github.com/j1king/grovr) (originally "Grovr"), maintained as a personal/internal tool.

### Naming: display name vs. internal identifiers

The **display name** is "Worktree Manager" (`productName` in `tauri.conf.json`, window title, in-app text). The following **internal identifiers were intentionally kept as `grovr`** — do NOT rename them; doing so orphans user data or breaks automation:

- Bundle identifier `com.grovr.desktop` — the macOS app config/settings store path is keyed off this; changing it gives the app an empty settings store.
- Deep-link scheme `grovr://` (`src/lib/deep-link.ts`, `tauri.conf.json` schemes) — external tooling (e.g. Codex) generates these links.
- Keychain service name `"grovr"` (`src-tauri/src/secure_store.rs`) — stored GitHub/Jira tokens are keyed off this.
- Rust crate names `grovr` / `grovr_lib` (`Cargo.toml`, `main.rs`) — internal, not user-visible.

## Tech Stack

- **Frontend**: React 19, TypeScript (strict), Vite 7, TailwindCSS 3, Radix UI
- **Backend**: Rust 2021, Tauri v2, git2 (libgit2), tokio
- **Testing**: Playwright (E2E), Rust `#[cfg(test)]` unit tests
- **Build**: pnpm (v11), Cargo

## Toolchain note

Rust is installed via rustup at `~/.cargo/bin`, which is **not always on PATH**. Prefix Rust/build commands with:

```bash
source "$HOME/.cargo/env"
```

…or ensure `~/.cargo/env` is sourced from your shell profile. Without it, `cargo` and `pnpm tauri build/dev` fail with "failed to run cargo metadata".

## Project Structure

```
src/                       # React frontend
  components/ui/           # Reusable primitives (button, modal, confirm-modal,
                           #   alert-modal, scroll-area, tooltip)
  components/worktree/     # WorktreeRow, ProjectCard (+ SortableProjectCard),
                           #   types.ts, modals/ (IdeConfirmModal, DeleteWorktreeModals)
  hooks/                   # useWorktreeData, useServerPolling,
                           #   useWorktreeKeyboardNav, useKeyboardShortcut
  pages/                   # Page components (WorktreeListPage is now thin
                           #   composition; settings pages in pages/settings/)
  lib/api.ts               # Tauri IPC bridge to Rust backend
  lib/integration-cache.ts # TTL + in-flight-dedup cache for GitHub/Jira lookups
  types/                   # TypeScript interfaces (mirror src-tauri/src/types.rs)

src-tauri/                 # Rust backend
  src/commands/            # git.rs, servers.rs, settings.rs, projects.rs,
                           #   integrations.rs, clipboard.rs
  src/secure_store.rs      # Keyring-based credential storage (service "grovr")

e2e/                       # Playwright E2E tests (fixture mocks the Tauri layer)
scripts/                   # install-local.sh, preview.sh, run-e2e-tests.sh, ...
```

## Essential Commands

```bash
# Development
pnpm dev              # Vite dev server only
pnpm tauri dev        # Run the app in dev mode (hot reload)

# Frontend build / typecheck
pnpm build            # tsc (strict) + vite build

# Rust tests
source "$HOME/.cargo/env"
cargo test --manifest-path src-tauri/Cargo.toml

# E2E
pnpm test:e2e         # All (~48 tests)
pnpm test:smoke       # Quick smoke
pnpm test:critical    # Critical path

# Build + install a personal release copy into /Applications
./scripts/install-local.sh   # ad-hoc signed; re-run to update the installed app
```

## Distribution & updates

Three tiers:

- **Local dev install** — `./scripts/install-local.sh`: ad-hoc signed, copies
  `Worktree Manager.app` to `/Applications`. Maintainer machine only.
- **Local release** — `./scripts/release-build.sh`: signed + notarized universal
  `.dmg`. Credentials are env-driven, sourced from a gitignored `.env.signing`
  (template: `.env.signing.example`). `./scripts/signing-setup.sh` creates/imports
  the Developer ID certificate (no full Xcode needed).
- **CI release** — pushing a `v*` tag runs `.github/workflows/release.yml`
  (macos-14, `tauri-apps/tauri-action`), which signs, notarizes and creates a
  **draft** GitHub release. Needs six repo secrets: `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID`.

Notes:

- Release builds are universal (`--target universal-apple-darwin`), so artifacts
  land in `src-tauri/target/universal-apple-darwin/release/bundle/{macos,dmg}/`
  — **not** `src-tauri/target/release/bundle/`.
- **No auto-updater.** The Tauri updater was removed (it pointed at the upstream
  author's signed releases). Updating means downloading a new `.dmg`.
- Full procedure (Apple setup, secrets, troubleshooting): `docs/DISTRIBUTION.md`.

## Core Principles

### Tauri IPC

- All Rust commands live in `src-tauri/src/commands/` and are registered in
  `src-tauri/src/lib.rs` (`generate_handler!`).
- Frontend calls go through `src/lib/api.ts` via `invoke()`.
- Commands return `Result<T, String>` — use `thiserror` for custom errors.
- NEVER panic in commands. No `anyhow` (no Serialize impl).

### Type Safety

- Match TS types in `src/types/` with Rust types (`src-tauri/src/types.rs` and
  per-command structs). Serde uses **default snake_case** (no `rename_all`); the
  TS `Backend*` interfaces mirror that casing.
- Strict TypeScript is enabled.

### Dependency versions (Tauri)

- Keep the `@tauri-apps/*` npm packages aligned with their Rust crate
  major/minor versions. `pnpm tauri build` **hard-fails** on a mismatch (e.g.
  `@tauri-apps/api` must match the `tauri` crate's minor). `pnpm tauri dev` only
  warns. Fix with `pnpm up "@tauri-apps/*@latest"` when the crates move.

### Styling

- TailwindCSS utility classes only; CVA for variants; `cn()` for merging.
- Dark mode via `.dark`; CSS variables in `src/index.css`. No pure black.
- Animations gated behind `@media (prefers-reduced-motion: no-preference)`.

### Git Operations

- `get_worktrees` parses `git worktree list --porcelain` (handles bare,
  detached HEAD → short SHA, and prunable entries; see `parse_worktree_list`).
- Use `git2` where it fits; fall back to `std::process::Command`. Long ops run
  in `tokio::task::spawn_blocking`.

## Feature: running dev-server detection (macOS)

`src-tauri/src/commands/servers.rs` — `get_running_servers(worktree_paths)` maps
listening TCP ports to worktrees:

1. `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → listeners (pid, command, address, port).
2. `lsof -a -nP -p <pids> -d cwd -Fn` → each pid's cwd.
3. `ps -p <pids> -o pid=,etime=,comm=` → full process name + uptime.

A process belongs to a worktree when its cwd is inside the (canonicalized)
worktree path (longest match wins for nested worktrees). lsof's non-zero exits
are tolerated (parse stdout regardless). The frontend polls every 4s via
`useServerPolling` (paused when the window is hidden), and `WorktreeRow` renders
clickable port badges with a Radix hover card (process, pid, uptime, bind scope,
URL). macOS-only; degrades gracefully elsewhere (errors swallowed, prior state kept).

`stop_worktree_processes(worktree_path)` (same module) is the companion write
side: it finds every process whose cwd is inside the worktree (same cwd-matching
as detection, so it also catches watchers/build steps that don't listen on a
port), SIGTERMs them, then SIGKILLs stragglers. The delete flow calls it before
`remove_worktree` when the user opts in, so a running dev server can't leave the
worktree in the "Directory not empty" half-deleted state.

## Key Files

| File | Purpose |
|------|---------|
| `src/lib/api.ts` | Frontend↔backend IPC bridge |
| `src/lib/integration-cache.ts` | TTL + dedup cache for PR/Jira/remote lookups |
| `src/hooks/useWorktreeData.ts` | Loads projects/worktrees/settings + integrations |
| `src/hooks/useServerPolling.ts` | Polls `get_running_servers` |
| `src/components/worktree/WorktreeRow.tsx` | Row UI: branch, badges, server ports, more-menu |
| `src-tauri/src/lib.rs` | Tauri setup, plugins, command registration, window effects |
| `src-tauri/src/commands/git.rs` | Git/worktree operations |
| `src-tauri/src/commands/servers.rs` | Running dev-server detection (lsof/ps) |
| `src-tauri/src/commands/settings.rs` | App settings (tauri-plugin-store) |
| `src-tauri/src/commands/integrations.rs` | GitHub/Jira API integrations |

## Testing

- E2E uses Playwright with a custom Tauri fixture (`e2e/fixtures/tauri.ts`) that
  mocks the `invoke` layer — add a `case` there for any new command.
- Tag tests: `@smoke`, `@critical`, `@worktree`, `@settings`, `@theme`, `@ide`.
- Each test is independent; let Playwright auto-wait (no `waitForTimeout`).
- Rust parsers (lsof/ps/porcelain) have pure-function unit tests in `servers.rs`
  / `git.rs`.

## Rules

Detailed guidelines in `.claude/rules/`: `tauri.md`, `react.md`, `testing.md`, `styling.md`.

## Don'ts

- Don't rename the internal `grovr` identifiers (bundle id, `grovr://` scheme,
  keychain service, crate names) — see "Naming" above.
- Don't use `anyhow` in Tauri commands; don't panic in commands.
- Don't expose tokens to the frontend — return metadata only.
- Don't let `@tauri-apps/*` npm and Rust crate versions drift apart.
- Don't skip tests when touching critical paths; don't use pure black in dark mode.
