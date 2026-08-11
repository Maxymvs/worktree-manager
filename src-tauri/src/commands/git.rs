use git2::{BranchType, Repository};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub is_main: bool,
    pub is_bare: bool,
    #[serde(default)]
    pub is_detached: bool,
    #[serde(default)]
    pub prunable: bool,
    /// Best-effort creation time (epoch milliseconds) of the worktree, derived
    /// from filesystem birthtime. `None` when it can't be determined — the
    /// pure parser never fills this in (see `worktree_created_at`).
    #[serde(default)]
    pub created_at_ms: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Branch {
    pub name: String,
    pub is_remote: bool,
    pub is_head: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeStatus {
    pub has_changes: bool,
    pub staged: i32,
    pub unstaged: i32,
    pub untracked: i32,
}

// ============ Worktree Commands ============

#[tauri::command]
pub fn get_worktrees(repo_path: String) -> Result<Vec<Worktree>, String> {
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut worktrees = parse_worktree_list(&stdout);

    // Enrich with filesystem-derived creation times. Kept out of the parser so
    // it stays pure/testable; every lookup here is best-effort.
    for wt in worktrees.iter_mut() {
        wt.created_at_ms = worktree_created_at(&repo_path, wt);
    }

    Ok(worktrees)
}

/// Convert a `SystemTime` into epoch milliseconds, or `None` for pre-epoch /
/// unrepresentable values.
fn system_time_to_ms(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

/// Birthtime (in epoch ms) of `path`, or `None` when unavailable (unsupported
/// filesystem, missing path, permission error).
fn created_at_ms_of(path: impl AsRef<Path>) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.created().ok())
        .and_then(system_time_to_ms)
}

/// Pure parser for the contents of a linked worktree's `.git` file, which looks
/// like `gitdir: /path/to/repo/.git/worktrees/<name>` (with a trailing newline).
/// Returns the admin directory path, or `None` if the line is missing/empty.
fn parse_gitdir_file(contents: &str) -> Option<&str> {
    contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))
        .map(str::trim)
        .filter(|p| !p.is_empty())
}

/// Best-effort creation time (epoch ms) for a worktree.
///
/// * Main worktree: birthtime of `<path>/.git`, falling back to `<path>`.
/// * Linked worktree: birthtime of its admin dir under
///   `<repo>/.git/worktrees/<name>` — resolved via the worktree's own `.git`
///   file, or (when the folder is gone, e.g. prunable entries) by scanning the
///   repo's `worktrees/*/gitdir` files for one pointing back at this worktree.
///   Falls back to the worktree path itself.
///
/// Never panics; any failure collapses to `None`.
fn worktree_created_at(repo_path: &str, wt: &Worktree) -> Option<u64> {
    let wt_path = Path::new(&wt.path);
    let dot_git = wt_path.join(".git");

    if wt.is_main {
        return created_at_ms_of(&dot_git).or_else(|| created_at_ms_of(wt_path));
    }

    // (a) Read the worktree's `.git` file to find its admin directory.
    if let Ok(contents) = std::fs::read_to_string(&dot_git) {
        if let Some(admin) = parse_gitdir_file(&contents) {
            if let Some(ms) = created_at_ms_of(admin) {
                return Some(ms);
            }
        }
    }

    // (b) Folder gone (prunable): scan the repo's worktree admin dirs for the
    // `gitdir` file that points back at this worktree's `.git`.
    if let Some(ms) = scan_admin_dirs_for(repo_path, &dot_git) {
        return Some(ms);
    }

    // (c) Last resort: the worktree directory itself.
    created_at_ms_of(wt_path)
}

/// Scan `<repo_path>/.git/worktrees/*/gitdir` for an entry whose recorded path
/// equals `target_dot_git`, returning that admin dir's birthtime in epoch ms.
fn scan_admin_dirs_for(repo_path: &str, target_dot_git: &Path) -> Option<u64> {
    let worktrees_dir = Path::new(repo_path).join(".git").join("worktrees");
    let entries = std::fs::read_dir(&worktrees_dir).ok()?;

    for entry in entries.flatten() {
        let admin_dir = entry.path();
        let Ok(recorded) = std::fs::read_to_string(admin_dir.join("gitdir")) else {
            continue;
        };
        let recorded = recorded.trim();
        if recorded.is_empty() {
            continue;
        }
        if Path::new(recorded) == target_dot_git {
            return created_at_ms_of(&admin_dir);
        }
    }

    None
}

/// Per-entry accumulator while parsing `git worktree list --porcelain` output.
#[derive(Default)]
struct WorktreeEntry {
    path: Option<String>,
    branch: Option<String>,
    sha: Option<String>,
    is_bare: bool,
    is_detached: bool,
    prunable: bool,
}

/// Pure parser for `git worktree list --porcelain` output.
///
/// Entries are separated by blank lines (or a new `worktree ` line). Recognized
/// fields: `worktree <path>`, `branch refs/heads/<name>`, `HEAD <sha>`, `bare`,
/// `detached`, `prunable <reason>`. Detached worktrees have no `branch` line, so
/// their branch is set to the short (7-char) SHA to avoid blank rows.
fn parse_worktree_list(stdout: &str) -> Vec<Worktree> {
    let mut worktrees: Vec<Worktree> = Vec::new();
    let mut current = WorktreeEntry::default();

    // Flush the accumulated entry (if any) into the result list.
    fn flush(worktrees: &mut Vec<Worktree>, entry: &mut WorktreeEntry) {
        let Some(path) = entry.path.take() else {
            *entry = WorktreeEntry::default();
            return;
        };

        let mut branch = entry.branch.take().unwrap_or_default();
        // Detached worktrees have no branch line; show the short SHA instead.
        if branch.is_empty() && entry.is_detached {
            if let Some(sha) = &entry.sha {
                branch = sha.chars().take(7).collect();
            }
        }

        worktrees.push(Worktree {
            path,
            branch,
            is_main: worktrees.is_empty(),
            is_bare: entry.is_bare,
            is_detached: entry.is_detached,
            prunable: entry.prunable,
            // Filesystem lookup happens in `get_worktrees`; the parser is pure.
            created_at_ms: None,
        });

        *entry = WorktreeEntry::default();
    }

    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            // New entry begins; flush the previous one.
            flush(&mut worktrees, &mut current);
            current.path = Some(path.to_string());
        } else if let Some(rest) = line.strip_prefix("branch ") {
            let branch = rest.strip_prefix("refs/heads/").unwrap_or(rest);
            current.branch = Some(branch.to_string());
        } else if let Some(sha) = line.strip_prefix("HEAD ") {
            current.sha = Some(sha.to_string());
        } else if line == "bare" {
            current.is_bare = true;
        } else if line == "detached" {
            current.is_detached = true;
        } else if line.starts_with("prunable") {
            current.prunable = true;
        }
    }

    // Flush the final entry.
    flush(&mut worktrees, &mut current);

    worktrees
}

#[tauri::command]
pub async fn create_worktree(
    repo_path: String,
    worktree_path: String,
    branch_name: String,
    base_branch: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["worktree", "add", "-b", &branch_name, &worktree_path, &base_branch])
            .current_dir(&repo_path)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        // When base_branch is a remote branch (e.g., origin/main), git automatically
        // sets up the new branch to track that remote branch. This causes pushes to
        // go to the base branch instead of origin/<new-branch>. Remove the upstream
        // tracking to fix this behavior.
        let _ = Command::new("git")
            .args(["branch", "--unset-upstream", &branch_name])
            .current_dir(&worktree_path)
            .output();

        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn create_worktree_existing_branch(
    repo_path: String,
    worktree_path: String,
    branch_name: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["worktree", "add", &worktree_path, &branch_name])
            .current_dir(&repo_path)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn remove_worktree(
    repo_path: String,
    worktree_path: String,
    force: bool,
    delete_branch: bool,
    branch_name: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&worktree_path);

        let output = Command::new("git")
            .args(&args)
            .current_dir(&repo_path)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            // A non-force removal that fails should surface the error so the
            // caller can offer a force delete instead.
            if !force {
                return Err(stderr);
            }

            // `git worktree remove` deletes its bookkeeping under
            // `.git/worktrees/<id>` *before* it removes the working directory.
            // If that directory removal fails part-way (commonly a running dev
            // server or file watcher is still writing inside it, surfacing as
            // "Directory not empty"), git has already forgotten the worktree —
            // so a `--force` retry aborts with "is not a working tree" and
            // leaves both the directory and the branch behind. When forcing,
            // finish the removal ourselves.
            force_cleanup_worktree(&repo_path, &worktree_path)
                .map_err(|cleanup_err| format!("{}\n{}", stderr.trim_end(), cleanup_err))?;
        }

        // Delete the branch after worktree removal if requested
        if delete_branch {
            if let Some(branch) = branch_name {
                // Use -D (force) since the branch may not be fully merged
                let flag = if force { "-D" } else { "-d" };
                let output = Command::new("git")
                    .args(["branch", flag, &branch])
                    .current_dir(&repo_path)
                    .output()
                    .map_err(|e| format!("Worktree removed but failed to delete branch: {}", e))?;

                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    // If soft delete fails, try force delete
                    if !force && stderr.contains("not fully merged") {
                        let output = Command::new("git")
                            .args(["branch", "-D", &branch])
                            .current_dir(&repo_path)
                            .output()
                            .map_err(|e| format!("Worktree removed but failed to force delete branch: {}", e))?;

                        if !output.status.success() {
                            return Err(format!(
                                "Worktree removed but failed to delete branch: {}",
                                String::from_utf8_lossy(&output.stderr)
                            ));
                        }
                    } else {
                        return Err(format!(
                            "Worktree removed but failed to delete branch: {}",
                            stderr
                        ));
                    }
                }
            }
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Decide whether `worktree_path` is safe to delete outright, and return the
/// canonical directory to hand to `remove_dir_all`.
///
/// `Ok(None)` means the directory is already gone, so there is nothing to
/// remove (the caller still prunes). Every comparison runs on *canonical*
/// paths, so a path stuffed with `..` segments or routed through a symlink
/// can't dodge the checks. Rejected outright:
///
/// - an empty path,
/// - a path with no parent, i.e. a filesystem root,
/// - a path that resolves to the repository itself,
/// - a path that *contains* the repository — deleting it would take the
///   repository with it.
fn resolve_force_delete_target(
    repo_path: &str,
    worktree_path: &str,
) -> Result<Option<PathBuf>, String> {
    if worktree_path.trim().is_empty() {
        return Err("refusing to force-delete an empty path".to_string());
    }

    let worktree_canon = match std::fs::canonicalize(worktree_path) {
        Ok(path) => path,
        // Already gone — the removal goal is achieved; let the caller prune.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "refusing to force-delete '{}': cannot resolve it: {}",
                worktree_path, e
            ))
        }
    };

    if worktree_canon.parent().is_none() {
        return Err(format!(
            "refusing to force-delete '{}': it is a filesystem root",
            worktree_path
        ));
    }

    let repo_canon = std::fs::canonicalize(repo_path).map_err(|e| {
        format!(
            "refusing to force-delete '{}': cannot resolve repository '{}': {}",
            worktree_path, repo_path, e
        )
    })?;

    if repo_canon == worktree_canon {
        return Err(format!(
            "refusing to force-delete '{}': it is the repository itself",
            worktree_path
        ));
    }

    // Component-wise, so a sibling directory sharing a name prefix
    // (`/a/repo-old` vs `/a/repo`) isn't mistaken for a parent.
    if repo_canon.starts_with(&worktree_canon) {
        return Err(format!(
            "refusing to force-delete '{}': the repository '{}' is inside it",
            worktree_path, repo_path
        ));
    }

    Ok(Some(worktree_canon))
}

/// Finish removing a worktree that `git worktree remove --force` could not.
///
/// `git worktree remove` deletes the administrative entry under
/// `.git/worktrees/<id>` before it removes the working-tree directory, so a
/// part-way failure (e.g. "Directory not empty" from a still-running dev
/// server) leaves git with no record of the worktree while the directory — and
/// its branch — remain. This best-effort cleanup deletes the leftover directory
/// itself and prunes any stale bookkeeping, so the caller's branch deletion can
/// still run and `git worktree list` stays consistent.
fn force_cleanup_worktree(repo_path: &str, worktree_path: &str) -> Result<(), String> {
    // Guard against nuking something that isn't a linked worktree directory.
    // `None` means the directory is already gone — nothing to remove, but the
    // prune below still runs so stale bookkeeping doesn't linger.
    let target = resolve_force_delete_target(repo_path, worktree_path)?;

    // Remove the leftover directory. Retry a few times: the usual cause of the
    // original failure is another process recreating files mid-delete, which is
    // often transient.
    let mut last_err = None;
    if let Some(target) = target.as_ref() {
        for attempt in 0..3 {
            match std::fs::remove_dir_all(target) {
                // Success, or already gone (git got it, or a prior attempt did).
                Ok(()) => {
                    last_err = None;
                    break;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    last_err = None;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
            }
        }
    }
    if let Some(e) = last_err {
        return Err(format!(
            "failed to delete worktree directory '{}': {} \
             — a process (e.g. a running dev server) may still be using it; \
             stop it and try again",
            worktree_path, e
        ));
    }

    // Prune the stale worktree metadata so `git worktree list` is consistent.
    let output = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(repo_path)
        .output()
        .map_err(|e| format!("failed to prune worktrees: {}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn prune_worktrees(repo_path: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn get_worktree_status(worktree_path: String) -> Result<WorktreeStatus, String> {
    let output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;

    for line in stdout.lines() {
        if line.len() < 2 {
            continue;
        }
        let index = line.chars().next().unwrap_or(' ');
        let worktree = line.chars().nth(1).unwrap_or(' ');

        if index == '?' {
            untracked += 1;
        } else {
            if index != ' ' {
                staged += 1;
            }
            if worktree != ' ' {
                unstaged += 1;
            }
        }
    }

    Ok(WorktreeStatus {
        has_changes: staged > 0 || unstaged > 0 || untracked > 0,
        staged,
        unstaged,
        untracked,
    })
}

/// What a delete would irreversibly discard. Used to decide whether to warn
/// before deleting: untracked files (build output, node_modules) are *not*
/// counted as risk — only uncommitted changes to tracked files and commits that
/// exist nowhere but locally.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WorktreeDeleteRisk {
    /// Tracked files with staged or unstaged modifications.
    pub has_uncommitted_changes: bool,
    /// Commits on the branch not reachable from any remote-tracking branch, so
    /// `git branch -D` would lose them. 0 when the branch isn't being deleted.
    pub unpushed_commits: i32,
    /// True when every file the branch changed is already byte-identical in the
    /// base branch — the work was squash- or rebase-merged, so the commits only
    /// *look* unpushed.
    pub branch_content_merged: bool,
}

/// Count commits on `branch` that aren't reachable from any remote-tracking
/// branch — i.e. commits that only exist locally and would be lost on delete.
/// Lenient: any failure returns 0 (don't block a delete on an unknowable state).
fn count_unpushed_commits(worktree_path: &str, branch: &str) -> i32 {
    let output = Command::new("git")
        // Trailing `--` so a branch name is never taken for a pathspec.
        .args(["rev-list", "--count", branch, "--not", "--remotes", "--"])
        .current_dir(worktree_path)
        .output();
    match output {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .trim()
            .parse::<i32>()
            .unwrap_or(0),
        _ => 0,
    }
}

/// Resolve the ref to compare the branch's *content* against, trying the most
/// specific source first. Returns the first candidate git can resolve to a
/// commit, or `None` when nothing usable exists.
///
/// 1. the branch's own upstream (`<branch>@{upstream}`),
/// 2. the caller-supplied base branch — as given (e.g. `origin/dev`) and, if
///    that doesn't resolve, prefixed with `origin/` (the setting often omits
///    the remote),
/// 3. `origin/HEAD`.
fn resolve_base_ref(worktree_path: &str, branch: &str, base_branch: Option<&str>) -> Option<String> {
    let mut candidates: Vec<String> = vec![format!("{}@{{upstream}}", branch)];
    if let Some(base) = base_branch {
        let base = base.trim();
        if !base.is_empty() {
            candidates.push(base.to_string());
            if !base.contains('/') {
                candidates.push(format!("origin/{}", base));
            }
        }
    }
    candidates.push("origin/HEAD".to_string());

    candidates
        .into_iter()
        .find(|candidate| ref_resolves(worktree_path, candidate))
}

/// True when `reference` names an existing commit in this repository.
fn ref_resolves(worktree_path: &str, reference: &str) -> bool {
    Command::new("git")
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("{}^{{commit}}", reference))
        .current_dir(worktree_path)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

/// True when merging `branch` into `base` would change nothing — every change
/// the branch carries is already present in `base`. This is the signature of a
/// squash or rebase merge: the commit SHAs differ, so reachability-based checks
/// report "unpushed" commits, but the content itself landed.
///
/// Uses `git merge-tree --write-tree` (git 2.38+), which performs a real merge
/// in memory and prints the resulting tree. If that tree equals the base's own
/// tree, the branch contributes nothing. Comparing individual files instead
/// would give the wrong answer as soon as `base` moves on and edits the same
/// files — which, on an active repo, is almost immediately.
///
/// Deliberately conservative: a merge conflict, a git too old to support
/// `--write-tree`, or any other failure returns `false` (i.e. keep warning)
/// rather than silently suppressing a real one.
fn branch_content_is_merged(worktree_path: &str, branch: &str, base: &str) -> bool {
    let merged_tree = match Command::new("git")
        .args(["merge-tree", "--write-tree", base, branch])
        .current_dir(worktree_path)
        .output()
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return false,
    };
    if merged_tree.is_empty() {
        return false;
    }

    let base_tree = match Command::new("git")
        .arg("rev-parse")
        .arg(format!("{}^{{tree}}", base))
        .current_dir(worktree_path)
        .output()
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return false,
    };

    !base_tree.is_empty() && merged_tree == base_tree
}

/// Report what deleting this worktree (and optionally its branch) would
/// irreversibly discard, so the UI can warn only when real work is at risk.
///
/// `base_branch` is the project's configured base (e.g. `origin/dev`); it's
/// used only to verify, by content, whether "unpushed" commits were actually
/// squash- or rebase-merged already.
#[tauri::command]
pub async fn get_worktree_delete_risk(
    worktree_path: String,
    branch: Option<String>,
    check_branch: bool,
    base_branch: Option<String>,
) -> Result<WorktreeDeleteRisk, String> {
    tokio::task::spawn_blocking(move || {
        compute_worktree_delete_risk(worktree_path, branch, check_branch, base_branch)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// Synchronous body of [`get_worktree_delete_risk`]. Shells out to git several
/// times, so the command wraps it in `spawn_blocking` rather than running it on
/// the async runtime.
fn compute_worktree_delete_risk(
    worktree_path: String,
    branch: Option<String>,
    check_branch: bool,
    base_branch: Option<String>,
) -> Result<WorktreeDeleteRisk, String> {
    let status = get_worktree_status(worktree_path.clone())?;

    let branch = match (check_branch, branch) {
        (true, Some(branch)) => Some(branch),
        _ => None,
    };

    let unpushed_commits = match &branch {
        Some(branch) => count_unpushed_commits(&worktree_path, branch),
        None => 0,
    };

    // Only worth the extra git work when the SHA-based count claims risk.
    let branch_content_merged = match (&branch, unpushed_commits > 0) {
        (Some(branch), true) => resolve_base_ref(&worktree_path, branch, base_branch.as_deref())
            .map(|base| branch_content_is_merged(&worktree_path, branch, &base))
            .unwrap_or(false),
        _ => false,
    };

    Ok(WorktreeDeleteRisk {
        has_uncommitted_changes: status.staged > 0 || status.unstaged > 0,
        unpushed_commits,
        branch_content_merged,
    })
}

// ============ Branch Commands ============

#[tauri::command]
pub fn get_branches(repo_path: String, include_remote: bool) -> Result<Vec<Branch>, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let mut branches_vec = Vec::new();

    // Get local branches
    let local_branches = repo.branches(Some(BranchType::Local)).map_err(|e| e.to_string())?;
    for branch_result in local_branches {
        let (branch, _) = branch_result.map_err(|e| e.to_string())?;
        let name = branch.name().map_err(|e| e.to_string())?;
        if let Some(name) = name {
            branches_vec.push(Branch {
                name: name.to_string(),
                is_remote: false,
                is_head: branch.is_head(),
            });
        }
    }

    // Get remote branches if requested
    if include_remote {
        let remote_branches = repo.branches(Some(BranchType::Remote)).map_err(|e| e.to_string())?;
        for branch_result in remote_branches {
            let (branch, _) = branch_result.map_err(|e| e.to_string())?;
            let name = branch.name().map_err(|e| e.to_string())?;
            if let Some(name) = name {
                branches_vec.push(Branch {
                    name: name.to_string(),
                    is_remote: true,
                    is_head: false,
                });
            }
        }
    }

    Ok(branches_vec)
}

#[tauri::command]
pub fn get_current_branch(repo_path: String) -> Result<String, String> {
    let repo = Repository::open(&repo_path).map_err(|e| e.to_string())?;
    let head = repo.head().map_err(|e| e.to_string())?;

    if head.is_branch() {
        head.shorthand()
            .map(|s| s.to_string())
            .ok_or_else(|| "Could not get branch name".to_string())
    } else {
        Err("HEAD is not a branch".to_string())
    }
}

#[tauri::command]
pub fn get_default_branch(repo_path: String) -> Result<String, String> {
    // Try to find origin/HEAD or origin/main or origin/master
    let output = Command::new("git")
        .args(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(branch);
    }

    // Fallback: check if origin/main exists
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "origin/main"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        return Ok("origin/main".to_string());
    }

    // Fallback: check if origin/master exists
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "origin/master"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if output.status.success() {
        return Ok("origin/master".to_string());
    }

    Err("Could not determine default branch".to_string())
}

#[tauri::command]
pub fn delete_branch(repo_path: String, branch_name: String, force: bool) -> Result<(), String> {
    let flag = if force { "-D" } else { "-d" };

    let output = Command::new("git")
        .args(["branch", flag, &branch_name])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn rename_branch(repo_path: String, old_name: String, new_name: String) -> Result<(), String> {
    let output = Command::new("git")
        .args(["branch", "-m", &old_name, &new_name])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }

    Ok(())
}

// ============ Git Operations ============

#[tauri::command]
pub async fn git_fetch(repo_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["fetch", "--all", "--prune"])
            .current_dir(&repo_path)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[tauri::command]
pub async fn git_pull(worktree_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let output = Command::new("git")
            .args(["pull"])
            .current_dir(&worktree_path)
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(())
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

// ============ Remote Info ============

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GitHubRemoteInfo {
    pub owner: String,
    pub repo: String,
}

#[tauri::command]
pub fn get_github_remote_info(repo_path: String, github_host: Option<String>) -> Result<Option<GitHubRemoteInfo>, String> {
    let output = Command::new("git")
        .args(["remote", "get-url", "origin"])
        .current_dir(&repo_path)
        .output()
        .map_err(|e| format!("Failed to run git: {}", e))?;

    if !output.status.success() {
        return Ok(None);
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();

    let hosts: Vec<&str> = match github_host.as_deref() {
        Some(h) if !h.is_empty() && h != "github.com" => vec!["github.com", h],
        _ => vec!["github.com"],
    };

    // Parse SSH (git@{host}:owner/repo.git) or HTTPS (https://{host}/owner/repo[.git])
    let parsed = hosts.iter().find_map(|host| {
        let path = if let Some(rest) = url.strip_prefix(&format!("git@{}:", host)) {
            Some(rest)
        } else {
            url.split(&format!("{}/", host)).nth(1)
        };

        path.and_then(|s| s.strip_suffix(".git").or(Some(s)))
            .and_then(|s| {
                let parts: Vec<&str> = s.split('/').collect();
                if parts.len() >= 2 {
                    Some(GitHubRemoteInfo { owner: parts[0].to_string(), repo: parts[1].to_string() })
                } else {
                    None
                }
            })
    });

    Ok(parsed)
}

// ============ IDE/File Operations ============

#[tauri::command]
pub fn open_ide(path: String, ide_preset: String, custom_command: Option<String>) -> Result<(), String> {
    let is_custom = ide_preset == "custom";
    let command = match ide_preset.as_str() {
        "code" => "code",
        "cursor" => "cursor",
        "idea" => "idea",
        "webstorm" => "webstorm",
        "pycharm" => "pycharm",
        "goland" => "goland",
        "custom" => custom_command.as_deref().ok_or("No custom command provided")?,
        _ => return Err(format!("Unknown IDE preset: {}", ide_preset)),
    };

    // Use login shell to access user's PATH environment
    // GUI apps don't inherit terminal PATH, so we need -l flag to load shell profile
    let shell_cmd = format!("{} \"{}\"", command, path);

    #[cfg(target_os = "macos")]
    let shell = "/bin/zsh";
    #[cfg(not(target_os = "macos"))]
    let shell = "sh";

    if is_custom {
        // For custom commands, wait for completion and check status
        let output = Command::new(shell)
            .args(["-l", "-c", &shell_cmd])
            .output()
            .map_err(|e| format!("Failed to run custom command: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let error_msg = if !stderr.is_empty() {
                stderr.to_string()
            } else if !stdout.is_empty() {
                stdout.to_string()
            } else {
                format!("Command exited with status: {}", output.status)
            };
            return Err(error_msg);
        }
    } else {
        // For preset IDEs, spawn without waiting (they stay open)
        Command::new(shell)
            .args(["-l", "-c", &shell_cmd])
            .spawn()
            .map_err(|e| format!("Failed to open IDE: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn open_in_finder(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Finder: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open Explorer: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| format!("Failed to open file manager: {}", e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn open_terminal(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal", &path])
            .spawn()
            .map_err(|e| format!("Failed to open Terminal: {}", e))?;
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/c", "start", "cmd", "/k", &format!("cd /d {}", path)])
            .spawn()
            .map_err(|e| format!("Failed to open Command Prompt: {}", e))?;
    }

    #[cfg(target_os = "linux")]
    {
        // Try common terminal emulators
        let terminals = ["gnome-terminal", "konsole", "xterm"];
        for term in terminals {
            if Command::new("which")
                .arg(term)
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
            {
                Command::new(term)
                    .arg("--working-directory")
                    .arg(&path)
                    .spawn()
                    .map_err(|e| format!("Failed to open terminal: {}", e))?;
                return Ok(());
            }
        }
        return Err("No supported terminal emulator found".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn copy_paths_to_worktree(
    source_path: String,
    target_path: String,
    paths: Vec<String>,
) -> Result<(), String> {
    for rel_path in paths {
        let src = Path::new(&source_path).join(&rel_path);
        let dst = Path::new(&target_path).join(&rel_path);

        if !src.exists() {
            continue; // Skip if source doesn't exist
        }

        // Create parent directory if needed
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;

    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn setup_test_repo() -> (TempDir, String) {
        let temp_dir = TempDir::new().expect("Failed to create temp dir");
        let repo_path = temp_dir.path().join("repo");
        fs::create_dir_all(&repo_path).expect("Failed to create repo dir");

        // Initialize git repo
        Command::new("git")
            .args(["init"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to init git repo");

        Command::new("git")
            .args(["config", "user.email", "test@test.com"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to set git email");

        Command::new("git")
            .args(["config", "user.name", "Test User"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to set git name");

        // Create initial commit
        fs::write(repo_path.join("README.md"), "# Test").expect("Failed to write README");
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to git add");
        Command::new("git")
            .args(["commit", "-m", "Initial commit"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to git commit");

        let repo_path_str = repo_path.to_string_lossy().to_string();
        (temp_dir, repo_path_str)
    }

    #[test]
    fn test_get_worktrees_initial() {
        let (_temp_dir, repo_path) = setup_test_repo();

        let worktrees = get_worktrees(repo_path).expect("Failed to get worktrees");

        assert_eq!(worktrees.len(), 1);
        assert!(worktrees[0].is_main);
    }

    #[tokio::test]
    async fn test_create_and_get_worktree() {
        let (temp_dir, repo_path) = setup_test_repo();
        let worktree_path = temp_dir.path().join("worktrees/feature-test");

        // Create worktree
        create_worktree(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            "feature-test".to_string(),
            "main".to_string(),
        )
        .await
        .expect("Failed to create worktree");

        // Verify worktree exists
        let worktrees = get_worktrees(repo_path).expect("Failed to get worktrees");
        assert_eq!(worktrees.len(), 2);

        let feature_wt = worktrees.iter().find(|w| w.branch == "feature-test");
        assert!(feature_wt.is_some());
        assert!(!feature_wt.unwrap().is_main);
    }

    #[tokio::test]
    async fn test_create_worktree_existing_branch() {
        let (temp_dir, repo_path) = setup_test_repo();

        // Create a branch first
        Command::new("git")
            .args(["branch", "existing-branch"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to create branch");

        let worktree_path = temp_dir.path().join("worktrees/existing-branch");

        // Create worktree from existing branch
        create_worktree_existing_branch(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            "existing-branch".to_string(),
        )
        .await
        .expect("Failed to create worktree from existing branch");

        // Verify
        let worktrees = get_worktrees(repo_path).expect("Failed to get worktrees");
        assert_eq!(worktrees.len(), 2);

        let existing_wt = worktrees.iter().find(|w| w.branch == "existing-branch");
        assert!(existing_wt.is_some());
    }

    #[tokio::test]
    async fn test_remove_worktree() {
        let (temp_dir, repo_path) = setup_test_repo();
        let worktree_path = temp_dir.path().join("worktrees/to-delete");

        // Create worktree
        create_worktree(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            "to-delete".to_string(),
            "main".to_string(),
        )
        .await
        .expect("Failed to create worktree");

        // Verify it exists
        let worktrees = get_worktrees(repo_path.clone()).expect("Failed to get worktrees");
        assert_eq!(worktrees.len(), 2);

        // Remove worktree
        remove_worktree(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            false,
            false,
            None,
        )
        .await
        .expect("Failed to remove worktree");

        // Verify it's gone
        let worktrees = get_worktrees(repo_path).expect("Failed to get worktrees");
        assert_eq!(worktrees.len(), 1);
    }

    #[tokio::test]
    async fn test_remove_worktree_force() {
        let (temp_dir, repo_path) = setup_test_repo();
        let worktree_path = temp_dir.path().join("worktrees/dirty-wt");

        // Create worktree
        create_worktree(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            "dirty-wt".to_string(),
            "main".to_string(),
        )
        .await
        .expect("Failed to create worktree");

        // Make it dirty (uncommitted changes)
        fs::write(worktree_path.join("dirty.txt"), "uncommitted").expect("Failed to write dirty file");

        // Try to remove without force - should fail
        let result = remove_worktree(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            false,
            false,
            None,
        )
        .await;
        assert!(result.is_err());

        // Remove with force - should succeed
        remove_worktree(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            true,
            false,
            None,
        )
        .await
        .expect("Failed to force remove worktree");

        // Verify it's gone
        let worktrees = get_worktrees(repo_path).expect("Failed to get worktrees");
        assert_eq!(worktrees.len(), 1);
    }

    // Reproduces the partial-failure state that used to dead-end a force delete:
    // `git worktree remove` deletes its `.git/worktrees/<id>` bookkeeping before
    // it removes the working directory, so a mid-delete failure ("Directory not
    // empty") leaves git with no record of the worktree while the directory and
    // branch remain. A `--force` retry then failed with "is not a working tree".
    // The force path must recover: remove the leftover directory and the branch.
    #[tokio::test]
    async fn test_force_remove_worktree_with_missing_metadata() {
        let (temp_dir, repo_path) = setup_test_repo();
        let worktree_path = temp_dir.path().join("worktrees/orphaned-wt");

        create_worktree(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            "orphaned-wt".to_string(),
            "main".to_string(),
        )
        .await
        .expect("Failed to create worktree");

        // Simulate git's partial removal: drop the admin metadata, keep the dir.
        let git_link =
            fs::read_to_string(worktree_path.join(".git")).expect("Failed to read .git file");
        let gitdir = git_link
            .trim()
            .strip_prefix("gitdir:")
            .expect("unexpected .git file format")
            .trim();
        fs::remove_dir_all(gitdir).expect("Failed to remove worktree metadata");

        // git no longer tracks it, but the directory and branch remain.
        let worktrees = get_worktrees(repo_path.clone()).expect("Failed to get worktrees");
        assert_eq!(worktrees.len(), 1, "worktree metadata should be gone");
        assert!(worktree_path.exists(), "leftover directory should remain");

        // A plain --force retry can't work here — confirm the precondition.
        let retry = Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&worktree_path)
            .current_dir(&repo_path)
            .output()
            .expect("Failed to run git");
        assert!(!retry.status.success(), "plain --force should fail here");

        // Force delete (with branch) must now recover instead of dead-ending.
        remove_worktree(
            repo_path.clone(),
            worktree_path.to_string_lossy().to_string(),
            true,
            true,
            Some("orphaned-wt".to_string()),
        )
        .await
        .expect("Force delete should recover from missing metadata");

        assert!(
            !worktree_path.exists(),
            "leftover directory should be removed"
        );

        // The branch should be deleted too.
        let output = Command::new("git")
            .args(["branch", "--list", "orphaned-wt"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to list branches");
        let branches = String::from_utf8_lossy(&output.stdout);
        assert!(
            branches.trim().is_empty(),
            "branch should be deleted, got: {:?}",
            branches
        );
    }

    // ---- Guard on the force-cleanup removal target ----

    #[test]
    fn test_resolve_force_delete_target_accepts_a_sibling_worktree() {
        let (temp_dir, repo_path) = setup_test_repo();
        let worktree_path = temp_dir.path().join("worktrees/feature-a");
        fs::create_dir_all(&worktree_path).expect("Failed to create worktree dir");

        let target = resolve_force_delete_target(&repo_path, &worktree_path.to_string_lossy())
            .expect("a sibling directory should be accepted")
            .expect("directory exists, so a target is expected");
        assert_eq!(
            target,
            std::fs::canonicalize(&worktree_path).expect("canonicalize")
        );
    }

    #[test]
    fn test_resolve_force_delete_target_missing_dir_yields_no_target() {
        let (temp_dir, repo_path) = setup_test_repo();
        let gone = temp_dir.path().join("worktrees/already-gone");

        // Already gone: not an error (the removal goal is met), just nothing to
        // remove — the caller still prunes.
        let target = resolve_force_delete_target(&repo_path, &gone.to_string_lossy())
            .expect("a missing directory is not an error");
        assert!(target.is_none());
    }

    #[test]
    fn test_resolve_force_delete_target_rejects_empty_and_root() {
        let (_temp_dir, repo_path) = setup_test_repo();

        assert!(resolve_force_delete_target(&repo_path, "").is_err());
        assert!(resolve_force_delete_target(&repo_path, "   ").is_err());
        assert!(resolve_force_delete_target(&repo_path, "/").is_err());
    }

    #[test]
    fn test_resolve_force_delete_target_rejects_the_repo_itself() {
        let (_temp_dir, repo_path) = setup_test_repo();

        let err = resolve_force_delete_target(&repo_path, &repo_path)
            .expect_err("deleting the repo itself must be refused");
        assert!(err.contains("repository itself"), "got: {}", err);

        // Same path dressed up with `.` / `..` segments must be refused too —
        // the checks run on canonical paths.
        let sneaky = format!("{}/../repo", repo_path);
        let err = resolve_force_delete_target(&repo_path, &sneaky)
            .expect_err("a '..' detour must not bypass the guard");
        assert!(err.contains("repository itself"), "got: {}", err);
    }

    #[test]
    fn test_resolve_force_delete_target_rejects_an_ancestor_of_the_repo() {
        let (temp_dir, repo_path) = setup_test_repo();

        // The repo lives inside temp_dir — deleting temp_dir would take the
        // repository with it.
        let parent = temp_dir.path().to_string_lossy().to_string();
        let err = resolve_force_delete_target(&repo_path, &parent)
            .expect_err("deleting a parent of the repo must be refused");
        assert!(err.contains("is inside it"), "got: {}", err);
    }

    #[test]
    fn test_get_worktree_status_clean() {
        let (_temp_dir, repo_path) = setup_test_repo();

        let status = get_worktree_status(repo_path).expect("Failed to get status");

        assert!(!status.has_changes);
        assert_eq!(status.staged, 0);
        assert_eq!(status.unstaged, 0);
        assert_eq!(status.untracked, 0);
    }

    #[test]
    fn test_get_worktree_status_dirty() {
        let (_temp_dir, repo_path) = setup_test_repo();

        // Create untracked file
        fs::write(Path::new(&repo_path).join("untracked.txt"), "untracked").expect("Failed to write");

        // Create modified file
        fs::write(Path::new(&repo_path).join("README.md"), "# Modified").expect("Failed to modify");

        let status = get_worktree_status(repo_path).expect("Failed to get status");

        assert!(status.has_changes);
        assert_eq!(status.untracked, 1);
        assert_eq!(status.unstaged, 1);
    }

    #[test]
    fn test_delete_risk_untracked_files_are_not_a_risk() {
        let (_temp_dir, repo_path) = setup_test_repo();

        // Untracked files (think node_modules/build output) must NOT be flagged.
        fs::write(Path::new(&repo_path).join("untracked.txt"), "junk").expect("Failed to write");

        let risk = compute_worktree_delete_risk(repo_path, None, false, None).expect("Failed to get risk");
        assert!(!risk.has_uncommitted_changes);
        assert_eq!(risk.unpushed_commits, 0);
        assert!(!risk.branch_content_merged);
    }

    #[test]
    fn test_delete_risk_flags_uncommitted_tracked_changes() {
        let (_temp_dir, repo_path) = setup_test_repo();

        // Modifying a tracked file IS a risk.
        fs::write(Path::new(&repo_path).join("README.md"), "# Modified").expect("Failed to modify");

        let risk = compute_worktree_delete_risk(repo_path, None, false, None).expect("Failed to get risk");
        assert!(risk.has_uncommitted_changes);
    }

    #[test]
    fn test_delete_risk_flags_local_only_commits() {
        let (_temp_dir, repo_path) = setup_test_repo();

        // A local commit with no remotes at all is unreachable from any remote
        // ref, so it counts as at-risk.
        Command::new("git")
            .args(["checkout", "-b", "feature-x"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to create branch");
        fs::write(Path::new(&repo_path).join("new.txt"), "work").expect("Failed to write");
        Command::new("git")
            .args(["add", "-A"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to add");
        Command::new("git")
            .args(["commit", "-m", "local work"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to commit");

        // check_branch=false → not inspected, so no risk reported.
        let ignored = compute_worktree_delete_risk(repo_path.clone(), Some("feature-x".to_string()), false, None)
            .expect("Failed to get risk");
        assert_eq!(ignored.unpushed_commits, 0);

        // check_branch=true → the local-only commit is flagged.
        let risk = compute_worktree_delete_risk(repo_path, Some("feature-x".to_string()), true, None)
            .expect("Failed to get risk");
        assert!(risk.unpushed_commits >= 1);
    }

    // ---- Content-based merge detection (squash / rebase merges) ----

    /// True when a usable `git` binary is on PATH. These tests shell out, so
    /// they skip rather than fail on machines without git.
    fn git_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    /// Run git in `repo` with deterministic identity/config so the result never
    /// depends on the developer's global git config.
    fn git_in(repo: &str, args: &[&str]) -> std::process::Output {
        Command::new("git")
            .args(["-c", "user.email=test@test.com", "-c", "user.name=Test User"])
            .args(args)
            .current_dir(repo)
            .env("GIT_AUTHOR_NAME", "Test User")
            .env("GIT_AUTHOR_EMAIL", "test@test.com")
            .env("GIT_COMMITTER_NAME", "Test User")
            .env("GIT_COMMITTER_EMAIL", "test@test.com")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .expect("Failed to run git")
    }

    /// Name of the repo's initial branch (init.defaultBranch varies by machine).
    fn current_branch(repo: &str) -> String {
        let out = git_in(repo, &["rev-parse", "--abbrev-ref", "HEAD"]);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn test_branch_content_is_merged_detects_squash_merge() {
        if !git_available() {
            return;
        }
        let (_temp_dir, repo_path) = setup_test_repo();
        let base = current_branch(&repo_path);

        // Branch off and do real work across two commits.
        git_in(&repo_path, &["checkout", "-b", "feat"]);
        fs::write(Path::new(&repo_path).join("a.txt"), "one").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "add a"]);
        fs::write(Path::new(&repo_path).join("b.txt"), "two").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "add b"]);

        // Squash-merge it into base: same content, brand-new SHA.
        git_in(&repo_path, &["checkout", &base]);
        git_in(&repo_path, &["merge", "--squash", "feat"]);
        git_in(&repo_path, &["commit", "-m", "squashed feat"]);

        assert!(
            branch_content_is_merged(&repo_path, "feat", &base),
            "squash-merged branch should be recognized as content-merged"
        );
    }

    #[test]
    fn test_branch_content_is_merged_false_for_unmerged_branch() {
        if !git_available() {
            return;
        }
        let (_temp_dir, repo_path) = setup_test_repo();
        let base = current_branch(&repo_path);

        git_in(&repo_path, &["checkout", "-b", "feat"]);
        fs::write(Path::new(&repo_path).join("a.txt"), "only on feat").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "add a"]);
        git_in(&repo_path, &["checkout", &base]);

        assert!(
            !branch_content_is_merged(&repo_path, "feat", &base),
            "genuinely unmerged work must keep warning"
        );
    }

    /// The case that a file-by-file comparison gets wrong: after the squash
    /// merge, the base keeps moving and edits the very same file. The branch
    /// still contributes nothing, so it must not warn — on an active repo this
    /// is the common case, not an edge case.
    #[test]
    fn test_branch_content_is_merged_when_base_advances_after_squash() {
        if !git_available() {
            return;
        }
        let (_temp_dir, repo_path) = setup_test_repo();
        let base = current_branch(&repo_path);

        // The file already exists before the branch diverges, so the later
        // edits are ordinary modifications rather than an add/add collision.
        let file = Path::new(&repo_path).join("shared.txt");
        fs::write(&file, "top\nmiddle\nbottom\n").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "seed shared"]);

        git_in(&repo_path, &["checkout", "-b", "feat"]);
        fs::write(&file, "TOP FROM BRANCH\nmiddle\nbottom\n").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "branch edits the top"]);

        git_in(&repo_path, &["checkout", &base]);
        git_in(&repo_path, &["merge", "--squash", "feat"]);
        git_in(&repo_path, &["commit", "-m", "squashed feat"]);

        // Base moves on, editing a different region of the same file.
        fs::write(&file, "TOP FROM BRANCH\nmiddle\nBOTTOM FROM BASE\n").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "base edits the bottom"]);

        assert!(
            branch_content_is_merged(&repo_path, "feat", &base),
            "a squash-merged branch stays merged after the base moves on"
        );
    }

    #[test]
    fn test_branch_content_is_merged_false_when_partially_merged() {
        if !git_available() {
            return;
        }
        let (_temp_dir, repo_path) = setup_test_repo();
        let base = current_branch(&repo_path);

        git_in(&repo_path, &["checkout", "-b", "feat"]);
        fs::write(Path::new(&repo_path).join("a.txt"), "merged").expect("write");
        fs::write(Path::new(&repo_path).join("b.txt"), "not merged").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "add a and b"]);

        // Base picks up only a.txt — b.txt would still be lost.
        git_in(&repo_path, &["checkout", &base]);
        fs::write(Path::new(&repo_path).join("a.txt"), "merged").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "cherry a"]);

        assert!(
            !branch_content_is_merged(&repo_path, "feat", &base),
            "partially merged work must keep warning"
        );
    }

    #[test]
    fn test_resolve_base_ref_falls_through_to_supplied_base() {
        if !git_available() {
            return;
        }
        let (_temp_dir, repo_path) = setup_test_repo();
        let base = current_branch(&repo_path);

        git_in(&repo_path, &["checkout", "-b", "feat"]);

        // No upstream and no remotes, so the supplied base branch is the only
        // candidate that can resolve.
        let resolved = resolve_base_ref(&repo_path, "feat", Some(&base));
        assert_eq!(resolved.as_deref(), Some(base.as_str()));

        // Nothing resolvable at all → None (caller stays conservative).
        assert_eq!(resolve_base_ref(&repo_path, "feat", Some("nope-not-a-branch")), None);
    }

    #[test]
    fn test_delete_risk_reports_content_merged_after_squash() {
        if !git_available() {
            return;
        }
        let (_temp_dir, repo_path) = setup_test_repo();
        let base = current_branch(&repo_path);

        git_in(&repo_path, &["checkout", "-b", "feat"]);
        fs::write(Path::new(&repo_path).join("a.txt"), "work").expect("write");
        git_in(&repo_path, &["add", "-A"]);
        git_in(&repo_path, &["commit", "-m", "work"]);
        git_in(&repo_path, &["checkout", &base]);
        git_in(&repo_path, &["merge", "--squash", "feat"]);
        git_in(&repo_path, &["commit", "-m", "squashed"]);
        git_in(&repo_path, &["checkout", "feat"]);

        let risk = compute_worktree_delete_risk(
            repo_path,
            Some("feat".to_string()),
            true,
            Some(base.clone()),
        )
        .expect("Failed to get risk");

        // The SHA-based count still sees the commit as unpushed…
        assert!(risk.unpushed_commits >= 1);
        // …but the content check proves it already landed on the base.
        assert!(risk.branch_content_merged);
    }

    #[test]
    fn test_get_branches() {
        let (_temp_dir, repo_path) = setup_test_repo();

        // Create additional branches
        Command::new("git")
            .args(["branch", "feature-1"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to create branch");
        Command::new("git")
            .args(["branch", "feature-2"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to create branch");

        let branches = get_branches(repo_path, false).expect("Failed to get branches");

        assert!(branches.len() >= 3); // main + feature-1 + feature-2
        assert!(branches.iter().any(|b| b.name == "main" || b.name == "master"));
        assert!(branches.iter().any(|b| b.name == "feature-1"));
        assert!(branches.iter().any(|b| b.name == "feature-2"));
    }

    #[test]
    fn test_rename_branch() {
        let (_temp_dir, repo_path) = setup_test_repo();

        // Create a branch
        Command::new("git")
            .args(["branch", "old-name"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to create branch");

        // Rename it
        rename_branch(repo_path.clone(), "old-name".to_string(), "new-name".to_string())
            .expect("Failed to rename branch");

        // Verify
        let branches = get_branches(repo_path, false).expect("Failed to get branches");
        assert!(!branches.iter().any(|b| b.name == "old-name"));
        assert!(branches.iter().any(|b| b.name == "new-name"));
    }

    #[test]
    fn test_parse_worktree_list_normal() {
        let porcelain = "\
worktree /home/user/repo
HEAD abc1234567890abcdef
branch refs/heads/main

worktree /home/user/repo.worktrees/feature
HEAD def4567890abcdef1234
branch refs/heads/feature-x
";
        let worktrees = parse_worktree_list(porcelain);
        assert_eq!(worktrees.len(), 2);

        assert_eq!(worktrees[0].path, "/home/user/repo");
        assert_eq!(worktrees[0].branch, "main");
        assert!(worktrees[0].is_main);
        assert!(!worktrees[0].is_bare);
        assert!(!worktrees[0].is_detached);
        assert!(!worktrees[0].prunable);

        assert_eq!(worktrees[1].path, "/home/user/repo.worktrees/feature");
        assert_eq!(worktrees[1].branch, "feature-x");
        assert!(!worktrees[1].is_main);
    }

    #[test]
    fn test_parse_worktree_list_bare() {
        let porcelain = "\
worktree /home/user/repo.git
bare

worktree /home/user/repo.worktrees/main
HEAD abc1234567890abcdef
branch refs/heads/main
";
        let worktrees = parse_worktree_list(porcelain);
        assert_eq!(worktrees.len(), 2);
        assert!(worktrees[0].is_bare);
        assert!(worktrees[0].is_main);
        assert_eq!(worktrees[0].branch, "");
        assert!(!worktrees[1].is_bare);
        assert_eq!(worktrees[1].branch, "main");
    }

    #[test]
    fn test_parse_worktree_list_detached() {
        let porcelain = "\
worktree /home/user/repo
HEAD abc1234567890abcdef
branch refs/heads/main

worktree /home/user/repo.worktrees/detached
HEAD 1a2b3c4d5e6f7890abcdef
detached
";
        let worktrees = parse_worktree_list(porcelain);
        assert_eq!(worktrees.len(), 2);

        let detached = &worktrees[1];
        assert!(detached.is_detached);
        // Branch falls back to the short (7-char) SHA so the row is not blank.
        assert_eq!(detached.branch, "1a2b3c4");
        assert!(!detached.prunable);
    }

    #[test]
    fn test_parse_worktree_list_prunable() {
        let porcelain = "\
worktree /home/user/repo
HEAD abc1234567890abcdef
branch refs/heads/main

worktree /home/user/repo.worktrees/gone
HEAD 9876543210fedcba
branch refs/heads/old-feature
prunable gitdir file points to non-existent location
";
        let worktrees = parse_worktree_list(porcelain);
        assert_eq!(worktrees.len(), 2);

        let prunable = &worktrees[1];
        assert!(prunable.prunable);
        assert_eq!(prunable.branch, "old-feature");
        assert!(!prunable.is_detached);
    }

    #[test]
    fn test_parse_worktree_list_empty() {
        assert!(parse_worktree_list("").is_empty());
    }

    #[test]
    fn test_parse_worktree_list_leaves_created_at_unset() {
        // The parser is pure — no filesystem access, so no creation time.
        let porcelain = "\
worktree /home/user/repo
HEAD abc1234567890abcdef
branch refs/heads/main
";
        let worktrees = parse_worktree_list(porcelain);
        assert_eq!(worktrees.len(), 1);
        assert!(worktrees[0].created_at_ms.is_none());
    }

    #[test]
    fn test_parse_gitdir_file() {
        assert_eq!(
            parse_gitdir_file("gitdir: /home/user/repo/.git/worktrees/feat\n"),
            Some("/home/user/repo/.git/worktrees/feat")
        );
        // No trailing newline.
        assert_eq!(
            parse_gitdir_file("gitdir: /a/b/.git/worktrees/x"),
            Some("/a/b/.git/worktrees/x")
        );
        // Extra surrounding whitespace / CRLF.
        assert_eq!(
            parse_gitdir_file("  gitdir:   /a/b/.git/worktrees/x  \r\n"),
            Some("/a/b/.git/worktrees/x")
        );
        // Not a gitdir file (e.g. a real .git directory read as text).
        assert_eq!(parse_gitdir_file("ref: refs/heads/main\n"), None);
        assert_eq!(parse_gitdir_file(""), None);
        // Present but empty path.
        assert_eq!(parse_gitdir_file("gitdir:   \n"), None);
    }

    #[tokio::test]
    async fn test_worktree_created_at_is_populated() {
        let (temp_dir, repo_path) = setup_test_repo();
        let wt_path = temp_dir.path().join("wt-age");
        let wt_path_str = wt_path.to_string_lossy().to_string();

        create_worktree(
            repo_path.clone(),
            wt_path_str.clone(),
            "age-branch".to_string(),
            "HEAD".to_string(),
        )
        .await
        .expect("Failed to create worktree");

        let worktrees = get_worktrees(repo_path).expect("Failed to get worktrees");
        assert_eq!(worktrees.len(), 2);

        // macOS/APFS reports birthtime; other platforms may not. Only assert
        // sanity when a value is available so the test stays portable.
        for wt in &worktrees {
            if let Some(ms) = wt.created_at_ms {
                assert!(ms > 0, "creation time should be a positive epoch value");
                let now_ms = system_time_to_ms(SystemTime::now()).unwrap();
                assert!(ms <= now_ms + 5_000, "creation time should not be in the future");
            }
        }
    }

    #[test]
    fn test_scan_admin_dirs_for_missing_worktree_folder() {
        // Simulate a prunable worktree: the admin dir still exists and its
        // `gitdir` file points at a `.git` file that has been deleted.
        let temp = TempDir::new().expect("temp dir");
        let repo = temp.path().join("repo");
        let admin = repo.join(".git").join("worktrees").join("gone");
        fs::create_dir_all(&admin).expect("create admin dir");

        let missing_wt_dot_git = temp.path().join("worktrees").join("gone").join(".git");
        fs::write(
            admin.join("gitdir"),
            format!("{}\n", missing_wt_dot_git.display()),
        )
        .expect("write gitdir");

        let found = scan_admin_dirs_for(&repo.to_string_lossy(), &missing_wt_dot_git);
        // Only assert the match logic when the platform reports birthtimes.
        if created_at_ms_of(&admin).is_some() {
            assert!(found.is_some(), "should resolve the admin dir by gitdir match");
        }

        // A non-matching target must not resolve.
        let other = temp.path().join("worktrees").join("other").join(".git");
        assert!(scan_admin_dirs_for(&repo.to_string_lossy(), &other).is_none());
    }

    #[test]
    fn test_delete_branch() {
        let (_temp_dir, repo_path) = setup_test_repo();

        // Create a branch
        Command::new("git")
            .args(["branch", "to-delete"])
            .current_dir(&repo_path)
            .output()
            .expect("Failed to create branch");

        // Verify it exists
        let branches = get_branches(repo_path.clone(), false).expect("Failed to get branches");
        assert!(branches.iter().any(|b| b.name == "to-delete"));

        // Delete it
        delete_branch(repo_path.clone(), "to-delete".to_string(), false)
            .expect("Failed to delete branch");

        // Verify it's gone
        let branches = get_branches(repo_path, false).expect("Failed to get branches");
        assert!(!branches.iter().any(|b| b.name == "to-delete"));
    }
}
