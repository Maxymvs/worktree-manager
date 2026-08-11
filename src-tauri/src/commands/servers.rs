use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunningServer {
    pub worktree_path: String,
    pub port: u16,
    pub pid: u32,
    pub process_name: String,
    /// The bind address the listener is bound to, as reported by lsof
    /// (e.g. "127.0.0.1", "*", "[::1]"). Lets the frontend tell apart a
    /// localhost-only server from one exposed on all interfaces.
    pub address: String,
    /// Process uptime in seconds, derived from `ps` etime. 0 when unknown
    /// (process gone, ps unavailable, or unparseable etime).
    pub uptime_secs: u64,
}

/// Parse the output of `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`.
///
/// Output is a stream of field lines, e.g.:
///   p982          -> pid
///   ccrapportd    -> command name
///   f15           -> fd (ignored)
///   n*:54137      -> address:port
///
/// Returns (pid, command, address, port) tuples, deduped on (pid, port) to
/// collapse IPv4/IPv6 duplicates that lsof emits for the same listener. The
/// address is the text BEFORE the last ':' of the `n` field
/// (e.g. "127.0.0.1", "*", "[::1]").
fn parse_lsof_listeners(output: &str) -> Vec<(u32, String, String, u16)> {
    let mut results: Vec<(u32, String, String, u16)> = Vec::new();
    let mut seen: HashSet<(u32, u16)> = HashSet::new();
    let mut current_pid: Option<u32> = None;
    let mut current_cmd: String = String::new();

    for line in output.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        // lsof field tags are single-byte ASCII; a non-ASCII first char (e.g. a
        // U+FFFD from lossy UTF-8 conversion) would make the byte slice below
        // panic on a char boundary.
        if !tag.is_ascii() {
            continue;
        }
        let value = &line[1..];
        match tag {
            'p' => {
                current_pid = value.parse::<u32>().ok();
                current_cmd = String::new();
            }
            'c' => {
                current_cmd = value.to_string();
            }
            'n' => {
                // Address forms: "*:5178", "127.0.0.1:6379", "[::1]:5432".
                // Port is the text after the LAST ':'; address is the rest.
                if let (Some(pid), Some(idx)) = (current_pid, value.rfind(':')) {
                    let address = &value[..idx];
                    let port_str = &value[idx + 1..];
                    if let Ok(port) = port_str.parse::<u16>() {
                        if seen.insert((pid, port)) {
                            results.push((pid, current_cmd.clone(), address.to_string(), port));
                        }
                    }
                    // Skip silently on port parse failure.
                }
            }
            _ => {}
        }
    }

    results
}

/// Parse the output of `ps -p <pids> -o pid=,etime=,comm=`.
///
/// Each line looks like:
///   38667 02:14:30 /opt/homebrew/Cellar/node/.../bin/node
///   8219 6-02:14:30 /usr/.../Python
///
/// Returns a map of pid -> (process_name_basename, uptime_secs). Putting comm
/// LAST keeps command paths-with-spaces safe (everything after the etime token
/// is the path). Lines that don't parse are skipped.
fn parse_ps(output: &str) -> HashMap<u32, (String, u64)> {
    let mut map: HashMap<u32, (String, u64)> = HashMap::new();

    for line in output.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid_str) = parts.next() else {
            continue;
        };
        let Some(etime_str) = parts.next() else {
            continue;
        };
        // The remaining tokens (joined with a single space) form the command
        // path, which may legitimately contain spaces.
        let comm: String = parts.collect::<Vec<_>>().join(" ");
        if comm.is_empty() {
            continue;
        }

        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        let Some(uptime_secs) = parse_etime(etime_str) else {
            continue;
        };

        // Basename: the last '/'-separated component of the command path.
        let basename = comm.rsplit('/').next().unwrap_or(&comm).to_string();

        map.insert(pid, (basename, uptime_secs));
    }

    map
}

/// Parse a `ps` etime field of the form `[[DD-]HH:]MM:SS` into total seconds.
/// Returns None for anything that doesn't parse.
fn parse_etime(etime: &str) -> Option<u64> {
    // Optional "DD-" day prefix.
    let (days, rest) = match etime.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, etime),
    };

    let fields: Vec<&str> = rest.split(':').collect();
    let (hours, minutes, seconds) = match fields.as_slice() {
        [h, m, s] => (h.parse::<u64>().ok()?, m.parse::<u64>().ok()?, s.parse::<u64>().ok()?),
        [m, s] => (0, m.parse::<u64>().ok()?, s.parse::<u64>().ok()?),
        _ => return None,
    };

    Some(((days * 24 + hours) * 60 + minutes) * 60 + seconds)
}

/// Parse the output of `lsof -a -nP -p <pids> -d cwd -Fn`.
///
/// Output:
///   p1769
///   fcwd
///   n/opt/homebrew/var/db/redis
///
/// Returns a map of pid -> cwd path.
fn parse_lsof_cwds(output: &str) -> HashMap<u32, PathBuf> {
    let mut map: HashMap<u32, PathBuf> = HashMap::new();
    let mut current_pid: Option<u32> = None;

    for line in output.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        if !tag.is_ascii() {
            continue;
        }
        let value = &line[1..];
        match tag {
            'p' => {
                current_pid = value.parse::<u32>().ok();
            }
            'n' => {
                if let Some(pid) = current_pid {
                    map.insert(pid, PathBuf::from(value));
                }
            }
            // 'f' (fcwd) lines are ignored; we only care about the path.
            _ => {}
        }
    }

    map
}

/// Match listening servers to worktrees by comparing each process's cwd to the
/// (canonicalized) worktree paths. A pid belongs to a worktree when its cwd is
/// the worktree dir or lives inside it. On nested worktrees, the longest match
/// wins. The ORIGINAL worktree path string is reported back.
fn match_servers_to_worktrees(
    listeners: &[(u32, String, String, u16)],
    cwds: &HashMap<u32, PathBuf>,
    ps_info: &HashMap<u32, (String, u64)>,
    worktree_paths: &[String],
) -> Vec<RunningServer> {
    // Canonicalize each worktree path once; fall back to the raw path on error
    // (e.g. the path no longer exists). Keep the original string for reporting.
    let canonical: Vec<(String, PathBuf)> = worktree_paths
        .iter()
        .map(|p| {
            let canon = std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
            (p.clone(), canon)
        })
        .collect();

    let mut results: Vec<RunningServer> = Vec::new();

    for (pid, cmd, address, port) in listeners {
        let Some(cwd) = cwds.get(pid) else {
            continue;
        };

        // Find the longest-matching worktree (handles nested worktrees).
        let mut best: Option<(&str, usize)> = None;
        for (original, canon) in &canonical {
            if cwd == canon || cwd.starts_with(canon) {
                let len = canon.as_os_str().len();
                if best.map(|(_, blen)| len > blen).unwrap_or(true) {
                    best = Some((original.as_str(), len));
                }
            }
        }

        if let Some((original, _)) = best {
            // Prefer the full process name + uptime from ps; fall back to the
            // (possibly truncated) lsof command and 0 uptime when absent.
            let (process_name, uptime_secs) = match ps_info.get(pid) {
                Some((name, secs)) => (name.clone(), *secs),
                None => (cmd.clone(), 0),
            };
            results.push(RunningServer {
                worktree_path: original.to_string(),
                port: *port,
                pid: *pid,
                process_name,
                address: address.clone(),
                uptime_secs,
            });
        }
    }

    // Sort by (worktree_path, port) for deterministic output.
    results.sort_by(|a, b| {
        a.worktree_path
            .cmp(&b.worktree_path)
            .then(a.port.cmp(&b.port))
    });

    results
}

#[tauri::command]
pub async fn get_running_servers(
    worktree_paths: Vec<String>,
) -> Result<Vec<RunningServer>, String> {
    tokio::task::spawn_blocking(move || {
        // Pass 1: find all listening TCP sockets.
        // NOTE: lsof exits non-zero whenever any fd is uninspectable or a pid
        // dies mid-scan, so we intentionally do NOT treat a non-zero exit as an
        // error. We parse stdout regardless; only a spawn failure is an error.
        let pass1 = Command::new("lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
            .output()
            .map_err(|e| format!("Failed to run lsof: {}", e))?;

        let pass1_stdout = String::from_utf8_lossy(&pass1.stdout);
        let listeners = parse_lsof_listeners(&pass1_stdout);

        if listeners.is_empty() {
            return Ok(Vec::new());
        }

        // Collect unique pids for pass 2.
        let mut pid_set: HashSet<u32> = HashSet::new();
        for (pid, _, _, _) in &listeners {
            pid_set.insert(*pid);
        }
        let pids_csv = pid_set
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(",");

        // Pass 2: resolve each pid's cwd.
        let pass2 = Command::new("lsof")
            .args(["-a", "-nP", "-p", &pids_csv, "-d", "cwd", "-Fn"])
            .output()
            .map_err(|e| format!("Failed to run lsof: {}", e))?;

        let pass2_stdout = String::from_utf8_lossy(&pass2.stdout);
        let cwds = parse_lsof_cwds(&pass2_stdout);

        // Pass 3 (enrichment): full process name + uptime via ps. Like lsof,
        // ps exits non-zero when some pids are gone, so we parse stdout
        // regardless. Unlike lsof, a spawn failure here is NON-fatal: we just
        // skip enrichment and fall back to the lsof command/0 uptime.
        let ps_info = match Command::new("ps")
            .args(["-p", &pids_csv, "-o", "pid=,etime=,comm="])
            .output()
        {
            Ok(ps) => parse_ps(&String::from_utf8_lossy(&ps.stdout)),
            Err(_) => HashMap::new(),
        };

        Ok(match_servers_to_worktrees(
            &listeners,
            &cwds,
            &ps_info,
            &worktree_paths,
        ))
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

/// A process that `stop_worktree_processes` terminated, for reporting back to
/// the UI.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StoppedProcess {
    pub pid: u32,
    pub process_name: String,
}

/// From a map of pid -> cwd, return the pids whose cwd is at or inside
/// `worktree_canon`, excluding `self_pid`. `Path::starts_with` matches on whole
/// path components, so "/w/feature-a" does not match a sibling "/w/feature-ab".
fn pids_with_cwd_in_worktree(
    cwds: &HashMap<u32, PathBuf>,
    worktree_canon: &Path,
    self_pid: u32,
) -> Vec<u32> {
    let mut pids: Vec<u32> = cwds
        .iter()
        .filter(|(pid, cwd)| {
            **pid != self_pid
                && **pid > 1
                && (cwd.as_path() == worktree_canon || cwd.starts_with(worktree_canon))
        })
        .map(|(pid, _)| *pid)
        .collect();
    pids.sort_unstable();
    pids
}

/// Send `signal` (e.g. "TERM", "KILL") to each pid via `kill`. Per-pid failures
/// (a pid that already exited) are ignored — the batch is best-effort.
fn signal_pids(signal: &str, pids: &[u32]) {
    if pids.is_empty() {
        return;
    }
    let mut args = vec![format!("-{}", signal)];
    args.extend(pids.iter().map(|p| p.to_string()));
    let _ = Command::new("kill").args(&args).output();
}

/// True if the process still exists (`kill -0` succeeds).
fn is_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Poll for the given pids to exit, up to `attempts` times sleeping
/// `interval_ms` between checks. Returns the pids still alive at the end.
fn wait_for_exit(pids: &[u32], attempts: u32, interval_ms: u64) -> Vec<u32> {
    let mut alive: Vec<u32> = pids.to_vec();
    for i in 0..attempts {
        alive.retain(|pid| is_alive(*pid));
        if alive.is_empty() {
            break;
        }
        if i + 1 < attempts {
            std::thread::sleep(std::time::Duration::from_millis(interval_ms));
        }
    }
    alive
}

/// True when `path` is a directory that holds a `.git` entry, i.e. the root of
/// a working tree. Both shapes count: a linked worktree has a `.git` *file*
/// pointing at `.git/worktrees/<id>`, the main worktree has a `.git`
/// *directory*. `exists()` covers either (and follows the link for a symlinked
/// `.git`).
fn looks_like_git_worktree(path: &Path) -> bool {
    path.is_dir() && path.join(".git").exists()
}

/// Terminate every process whose working directory is inside `worktree_path`.
///
/// This exists so the UI can free a worktree before deleting it: a running dev
/// server or file watcher keeps recreating files, which makes `git worktree
/// remove` fail with "Directory not empty". Matches processes the same way the
/// running-server detection does (by cwd), so it also catches watchers/build
/// steps that don't listen on a port. Sends SIGTERM first, then SIGKILL to any
/// stragglers, and returns what it stopped. macOS/Unix only.
#[tauri::command]
pub async fn stop_worktree_processes(
    worktree_path: String,
) -> Result<Vec<StoppedProcess>, String> {
    tokio::task::spawn_blocking(move || {
        // Canonicalize so cwd prefix comparisons line up with lsof's resolved
        // paths; fall back to the raw path if it's already gone.
        let worktree_canon =
            std::fs::canonicalize(&worktree_path).unwrap_or_else(|_| PathBuf::from(&worktree_path));

        // Safety: never operate on a root-ish path — that could sweep up the
        // whole session's processes.
        if worktree_canon.as_os_str().is_empty() || worktree_canon.parent().is_none() {
            return Err(format!("refusing to stop processes for '{}'", worktree_path));
        }

        // Safety: the path must actually look like a worktree. Without this, a
        // caller passing something broad (say `$HOME`) would kill every process
        // running anywhere beneath it.
        if !looks_like_git_worktree(&worktree_canon) {
            return Err(format!(
                "refusing to stop processes for '{}': it does not look like a git worktree",
                worktree_path
            ));
        }

        // List every process's cwd. Like the other lsof passes, non-zero exits
        // are expected (some fds are uninspectable), so parse stdout regardless.
        let output = Command::new("lsof")
            .args(["-nP", "-d", "cwd", "-Fpn"])
            .output()
            .map_err(|e| format!("Failed to run lsof: {}", e))?;
        let cwds = parse_lsof_cwds(&String::from_utf8_lossy(&output.stdout));

        let pids = pids_with_cwd_in_worktree(&cwds, &worktree_canon, std::process::id());
        if pids.is_empty() {
            return Ok(Vec::new());
        }

        // Capture names before killing (best-effort; ps may miss exited pids).
        let pids_csv = pids
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let names = match Command::new("ps")
            .args(["-p", &pids_csv, "-o", "pid=,etime=,comm="])
            .output()
        {
            Ok(ps) => parse_ps(&String::from_utf8_lossy(&ps.stdout)),
            Err(_) => HashMap::new(),
        };

        // Graceful terminate (~2s), then force-kill any survivors.
        signal_pids("TERM", &pids);
        let survivors = wait_for_exit(&pids, 20, 100);
        if !survivors.is_empty() {
            signal_pids("KILL", &survivors);
            let _ = wait_for_exit(&survivors, 10, 100);
        }

        let stopped = pids
            .iter()
            .map(|pid| StoppedProcess {
                pid: *pid,
                process_name: names
                    .get(pid)
                    .map(|(name, _)| name.clone())
                    .unwrap_or_else(|| "unknown".to_string()),
            })
            .collect();
        Ok(stopped)
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_listeners_basic() {
        let output = "p982\nccrapportd\nf15\nn*:54137\nf16\nn*:59900\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(
            listeners,
            vec![
                (982, "crapportd".to_string(), "*".to_string(), 54137),
                (982, "crapportd".to_string(), "*".to_string(), 59900),
            ]
        );
    }

    #[test]
    fn test_parse_listeners_ipv4_ipv6_dedup() {
        // redis-server listens on both 127.0.0.1:6379 and [::1]:6379.
        let output = "p1769\ncredis-server\nf6\nn127.0.0.1:6379\nf7\nn[::1]:6379\n";
        let listeners = parse_lsof_listeners(output);
        // Deduped on (pid, port) -> a single entry; first-seen address wins.
        assert_eq!(
            listeners,
            vec![(1769, "redis-server".to_string(), "127.0.0.1".to_string(), 6379)]
        );
    }

    #[test]
    fn test_parse_listeners_star_form() {
        let output = "p100\ncnode\nf3\nn*:5178\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(listeners, vec![(100, "node".to_string(), "*".to_string(), 5178)]);
    }

    #[test]
    fn test_parse_listeners_ipv6_address() {
        // The IPv6 bracket form is preserved verbatim as the address.
        let output = "p100\ncnode\nf3\nn[::1]:5432\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(listeners, vec![(100, "node".to_string(), "[::1]".to_string(), 5432)]);
    }

    #[test]
    fn test_parse_listeners_port_parse_failure() {
        // A malformed/non-numeric port is skipped.
        let output = "p100\ncnode\nf3\nn*:notaport\nf4\nn*:5178\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(listeners, vec![(100, "node".to_string(), "*".to_string(), 5178)]);
    }

    #[test]
    fn test_parse_listeners_command_with_spaces_and_parens() {
        let output = "p6867\ncGitHub Desktop Helper (Renderer\nf29\nn127.0.0.1:50405\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(
            listeners,
            vec![(
                6867,
                "GitHub Desktop Helper (Renderer".to_string(),
                "127.0.0.1".to_string(),
                50405
            )]
        );
    }

    #[test]
    fn test_parse_listeners_empty() {
        assert!(parse_lsof_listeners("").is_empty());
    }

    #[test]
    fn test_parse_listeners_non_ascii_line_does_not_panic() {
        // A line starting with a multi-byte char (e.g. U+FFFD from lossy UTF-8
        // conversion of binary garbage) must be skipped, not panic on slicing.
        let output = "p100\ncnode\n\u{FFFD}garbage\nf3\nn*:5178\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(listeners, vec![(100, "node".to_string(), "*".to_string(), 5178)]);
    }

    #[test]
    fn test_parse_ps_hms() {
        // HH:MM:SS form -> 2h 14m 30s = 8070 seconds.
        let output = "38667 02:14:30 /opt/homebrew/Cellar/node/24/bin/node\n";
        let info = parse_ps(output);
        assert_eq!(info.get(&38667), Some(&("node".to_string(), 8070)));
    }

    #[test]
    fn test_parse_ps_ms() {
        // MM:SS form -> 6m 5s = 365 seconds; comm has no path component.
        let output = "100 06:05 vite\n";
        let info = parse_ps(output);
        assert_eq!(info.get(&100), Some(&("vite".to_string(), 365)));
    }

    #[test]
    fn test_parse_ps_dhms() {
        // DD-HH:MM:SS form -> 6d 2h 14m 30s.
        let output = "8219 6-02:14:30 /usr/local/bin/Python\n";
        let info = parse_ps(output);
        let expected = ((6 * 24 + 2) * 60 + 14) * 60 + 30;
        assert_eq!(info.get(&8219), Some(&("Python".to_string(), expected)));
    }

    #[test]
    fn test_parse_ps_path_with_spaces() {
        // The command path legitimately contains spaces; everything after the
        // etime token is the path, and the basename is its last component.
        let output = "555 00:10 /Applications/My App.app/Contents/MacOS/my server\n";
        let info = parse_ps(output);
        assert_eq!(info.get(&555), Some(&("my server".to_string(), 10)));
    }

    #[test]
    fn test_parse_ps_malformed_skipped() {
        // A line with a non-numeric etime is skipped; a valid line is kept.
        let output = "100 not-a-time /usr/bin/node\n200 01:00 /usr/bin/python3.11\n";
        let info = parse_ps(output);
        assert_eq!(info.len(), 1);
        assert_eq!(info.get(&200), Some(&("python3.11".to_string(), 60)));
        assert!(info.get(&100).is_none());
    }

    #[test]
    fn test_parse_cwds_basic() {
        let output = "p1769\nfcwd\nn/opt/homebrew/var/db/redis\np1776\nfcwd\nn/opt/homebrew/var/postgresql@16\n";
        let cwds = parse_lsof_cwds(output);
        assert_eq!(cwds.len(), 2);
        assert_eq!(cwds.get(&1769), Some(&PathBuf::from("/opt/homebrew/var/db/redis")));
        assert_eq!(
            cwds.get(&1776),
            Some(&PathBuf::from("/opt/homebrew/var/postgresql@16"))
        );
    }

    #[test]
    fn test_match_basic() {
        let listeners = vec![(100, "node".to_string(), "127.0.0.1".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-a"));
        let mut ps_info = HashMap::new();
        ps_info.insert(100, ("python3.11".to_string(), 8130));
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &ps_info, &worktrees);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].worktree_path, "/tmp/wt/feature-a");
        assert_eq!(servers[0].port, 5178);
        assert_eq!(servers[0].pid, 100);
        // ps name + uptime win over the lsof command.
        assert_eq!(servers[0].process_name, "python3.11");
        assert_eq!(servers[0].address, "127.0.0.1");
        assert_eq!(servers[0].uptime_secs, 8130);
    }

    #[test]
    fn test_match_falls_back_to_lsof_command_without_ps() {
        // No ps entry for the pid: keep the lsof command, uptime 0.
        let listeners = vec![(100, "node".to_string(), "*".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-a"));
        let ps_info: HashMap<u32, (String, u64)> = HashMap::new();
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &ps_info, &worktrees);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].process_name, "node");
        assert_eq!(servers[0].uptime_secs, 0);
        assert_eq!(servers[0].address, "*");
    }

    #[test]
    fn test_match_cwd_inside_worktree() {
        // cwd is a subdirectory of the worktree.
        let listeners = vec![(100, "vite".to_string(), "127.0.0.1".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-a/packages/web"));
        let ps_info: HashMap<u32, (String, u64)> = HashMap::new();
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &ps_info, &worktrees);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].worktree_path, "/tmp/wt/feature-a");
    }

    #[test]
    fn test_match_pid_missing_from_cwd_map() {
        let listeners = vec![(100, "node".to_string(), "*".to_string(), 5178)];
        let cwds: HashMap<u32, PathBuf> = HashMap::new(); // pid 100 absent
        let ps_info: HashMap<u32, (String, u64)> = HashMap::new();
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &ps_info, &worktrees);
        assert!(servers.is_empty());
    }

    #[test]
    fn test_match_nested_longest_wins() {
        // cwd is inside the nested worktree, which is itself inside the parent.
        let listeners = vec![(100, "node".to_string(), "*".to_string(), 8004)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-a/nested/src"));
        let ps_info: HashMap<u32, (String, u64)> = HashMap::new();
        let worktrees = vec![
            "/tmp/wt/feature-a".to_string(),
            "/tmp/wt/feature-a/nested".to_string(),
        ];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &ps_info, &worktrees);
        assert_eq!(servers.len(), 1);
        // Longest match wins.
        assert_eq!(servers[0].worktree_path, "/tmp/wt/feature-a/nested");
    }

    #[test]
    fn test_match_canonicalize_fallback_nonexistent_path() {
        // A worktree path that does not exist on disk: canonicalize fails and we
        // fall back to the raw path, which still matches the cwd string.
        let listeners = vec![(100, "node".to_string(), "*".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/nonexistent/grovr/wt/feature-a"));
        let ps_info: HashMap<u32, (String, u64)> = HashMap::new();
        let worktrees = vec!["/nonexistent/grovr/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &ps_info, &worktrees);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].worktree_path, "/nonexistent/grovr/wt/feature-a");
    }

    #[test]
    fn test_match_sorted_output() {
        let listeners = vec![
            (101, "node".to_string(), "*".to_string(), 8004),
            (100, "vite".to_string(), "*".to_string(), 5178),
            (102, "python".to_string(), "*".to_string(), 3000),
        ];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/b"));
        cwds.insert(101, PathBuf::from("/tmp/wt/a"));
        cwds.insert(102, PathBuf::from("/tmp/wt/b"));
        let ps_info: HashMap<u32, (String, u64)> = HashMap::new();
        let worktrees = vec!["/tmp/wt/a".to_string(), "/tmp/wt/b".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &ps_info, &worktrees);
        // Sorted by (worktree_path, port): a:8004, b:3000, b:5178.
        assert_eq!(servers.len(), 3);
        assert_eq!((servers[0].worktree_path.as_str(), servers[0].port), ("/tmp/wt/a", 8004));
        assert_eq!((servers[1].worktree_path.as_str(), servers[1].port), ("/tmp/wt/b", 3000));
        assert_eq!((servers[2].worktree_path.as_str(), servers[2].port), ("/tmp/wt/b", 5178));
    }

    #[test]
    fn test_pids_with_cwd_in_worktree_matches_and_excludes_self() {
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-a")); // cwd == worktree
        cwds.insert(101, PathBuf::from("/tmp/wt/feature-a/packages/web")); // nested
        cwds.insert(102, PathBuf::from("/tmp/other")); // outside
        cwds.insert(200, PathBuf::from("/tmp/wt/feature-a")); // this is "self"

        let pids = pids_with_cwd_in_worktree(&cwds, Path::new("/tmp/wt/feature-a"), 200);
        assert_eq!(pids, vec![100, 101]);
    }

    #[test]
    fn test_pids_with_cwd_in_worktree_no_sibling_prefix_match() {
        // Component-wise: "/tmp/wt/feature-a" must NOT match "/tmp/wt/feature-ab".
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-ab"));
        let pids = pids_with_cwd_in_worktree(&cwds, Path::new("/tmp/wt/feature-a"), 0);
        assert!(pids.is_empty());
    }

    #[test]
    fn test_pids_with_cwd_in_worktree_skips_pid_1() {
        let mut cwds = HashMap::new();
        cwds.insert(1, PathBuf::from("/tmp/wt/feature-a"));
        let pids = pids_with_cwd_in_worktree(&cwds, Path::new("/tmp/wt/feature-a"), 999);
        assert!(pids.is_empty());
    }

    #[test]
    fn test_match_no_worktree() {
        // Process listening but cwd is outside all worktrees -> no match.
        let listeners = vec![(100, "node".to_string(), "*".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/some/other/place"));
        let ps_info: HashMap<u32, (String, u64)> = HashMap::new();
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &ps_info, &worktrees);
        assert!(servers.is_empty());
    }

    // ---- Guard for stop_worktree_processes ----

    #[test]
    fn test_looks_like_git_worktree_accepts_dot_git_dir_and_file() {
        let temp = tempfile::tempdir().expect("tempdir");

        // Main worktree: `.git` is a directory.
        let main = temp.path().join("main");
        std::fs::create_dir_all(main.join(".git")).expect("create .git dir");
        assert!(looks_like_git_worktree(&main));

        // Linked worktree: `.git` is a file pointing at the admin dir.
        let linked = temp.path().join("feature-a");
        std::fs::create_dir_all(&linked).expect("create worktree dir");
        std::fs::write(linked.join(".git"), "gitdir: /repo/.git/worktrees/feature-a\n")
            .expect("write .git file");
        assert!(looks_like_git_worktree(&linked));
    }

    #[test]
    fn test_looks_like_git_worktree_rejects_plain_dirs_and_missing_paths() {
        let temp = tempfile::tempdir().expect("tempdir");

        // A directory with no `.git` at all — e.g. a stray `$HOME`.
        let plain = temp.path().join("home");
        std::fs::create_dir_all(plain.join("Documents")).expect("create dirs");
        assert!(!looks_like_git_worktree(&plain));

        // Nonexistent path.
        assert!(!looks_like_git_worktree(&temp.path().join("gone")));

        // A file, not a directory, even though it exists.
        let file = temp.path().join("not-a-dir");
        std::fs::write(&file, "x").expect("write file");
        assert!(!looks_like_git_worktree(&file));

        // Filesystem root is not a worktree either (belt-and-braces: the
        // parent()-is-none guard also rejects it).
        assert!(!looks_like_git_worktree(Path::new("/")));
    }
}
