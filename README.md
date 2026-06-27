<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" height="128" alt="Grovr Logo">
</p>

<h1 align="center">Grovr</h1>

<p align="center">
  A native Git worktree manager for macOS
</p>

<p align="center">
  <a href="https://github.com/Maxymvs/worktree-manager/releases"><img src="https://img.shields.io/github/v/release/Maxymvs/worktree-manager" alt="Release"></a>
  <a href="https://github.com/Maxymvs/worktree-manager/releases"><img src="https://img.shields.io/github/downloads/Maxymvs/worktree-manager/total" alt="Downloads"></a>
  <img src="https://img.shields.io/badge/Tauri-v2-24C8D8?logo=tauri&logoColor=white" alt="Tauri v2">
</p>

<p align="center">
  Forked from <a href="https://github.com/j1king/grovr">j1king/grovr</a>.
</p>

---

Git worktrees let you work on multiple branches simultaneously without stashing or context switching. Grovr makes managing them effortless with a native macOS interface.

<p align="center">
  <img src="docs/main.webp" alt="Grovr Screenshot" width="800">
</p>

---

## Features

### One-Click IDE Launch

Click any worktree to open it in your preferred editor. Supports VS Code, Cursor, Zed, JetBrains IDEs, and custom commands.

<p align="center">
  <img src="docs/feature-ide.webp" alt="IDE Launch" width="800">
</p>

### Search & Keyboard Navigation

Type to search, use arrow keys to navigate, press Enter to launch. No mouse required.

<p align="center">
  <img src="docs/feature-search.webp" alt="Search & Navigation" width="800">
</p>

### Smart Worktree Creation

Create worktrees from clipboard with automatic branch name extraction. Paste a Jira issue key, GitHub PR URL, or any text matching your custom regex pattern. Also supports `grovr://` deep links for automation.

<p align="center">
  <img src="docs/feature-create.gif" alt="Create from URL" width="800">
</p>

### PR & Jira Status at a Glance

See pull request status (draft, review requested, approved, CI status) and Jira issue state directly in the worktree list. No more tab switching.

### Quick Cleanup

Delete worktrees with one click. Optionally delete the local branch too—no more orphaned branches cluttering your repo.

---

## Installation

**Manual Download**

Download the latest `.dmg` from [Releases](https://github.com/Maxymvs/worktree-manager/releases).

**Requirements:** macOS 10.15+ and Git installed.

---

## Development

```bash
# Clone and install
git clone https://github.com/Maxymvs/worktree-manager.git
cd worktree-manager
pnpm install

# Run dev server
pnpm tauri dev

# Build for production
pnpm tauri build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed development guide.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Rust, Tauri v2, git2, tokio |
| Frontend | React 19, TypeScript, Vite |
| Styling | TailwindCSS, Radix UI |
| Testing | Playwright |

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

Built with [Tauri](https://tauri.app/), [git2](https://github.com/rust-lang/git2-rs), and [Radix UI](https://www.radix-ui.com/).
