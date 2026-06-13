use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RunningServer {
    pub worktree_path: String,
    pub port: u16,
    pub pid: u32,
    pub process_name: String,
}

/// Parse the output of `lsof -nP -iTCP -sTCP:LISTEN -Fpcn`.
///
/// Output is a stream of field lines, e.g.:
///   p982          -> pid
///   ccrapportd    -> command name
///   f15           -> fd (ignored)
///   n*:54137      -> address:port
///
/// Returns (pid, command, port) tuples, deduped on (pid, port) to collapse
/// IPv4/IPv6 duplicates that lsof emits for the same listener.
fn parse_lsof_listeners(output: &str) -> Vec<(u32, String, u16)> {
    let mut results: Vec<(u32, String, u16)> = Vec::new();
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
                // Port is the text after the LAST ':'.
                if let (Some(pid), Some(idx)) = (current_pid, value.rfind(':')) {
                    let port_str = &value[idx + 1..];
                    if let Ok(port) = port_str.parse::<u16>() {
                        if seen.insert((pid, port)) {
                            results.push((pid, current_cmd.clone(), port));
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
    listeners: &[(u32, String, u16)],
    cwds: &HashMap<u32, PathBuf>,
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

    for (pid, cmd, port) in listeners {
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
            results.push(RunningServer {
                worktree_path: original.to_string(),
                port: *port,
                pid: *pid,
                process_name: cmd.clone(),
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
        for (pid, _, _) in &listeners {
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

        Ok(match_servers_to_worktrees(&listeners, &cwds, &worktree_paths))
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
                (982, "crapportd".to_string(), 54137),
                (982, "crapportd".to_string(), 59900),
            ]
        );
    }

    #[test]
    fn test_parse_listeners_ipv4_ipv6_dedup() {
        // redis-server listens on both 127.0.0.1:6379 and [::1]:6379.
        let output = "p1769\ncredis-server\nf6\nn127.0.0.1:6379\nf7\nn[::1]:6379\n";
        let listeners = parse_lsof_listeners(output);
        // Deduped on (pid, port) -> a single entry.
        assert_eq!(listeners, vec![(1769, "redis-server".to_string(), 6379)]);
    }

    #[test]
    fn test_parse_listeners_star_form() {
        let output = "p100\ncnode\nf3\nn*:5178\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(listeners, vec![(100, "node".to_string(), 5178)]);
    }

    #[test]
    fn test_parse_listeners_port_parse_failure() {
        // A malformed/non-numeric port is skipped.
        let output = "p100\ncnode\nf3\nn*:notaport\nf4\nn*:5178\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(listeners, vec![(100, "node".to_string(), 5178)]);
    }

    #[test]
    fn test_parse_listeners_command_with_spaces_and_parens() {
        let output = "p6867\ncGitHub Desktop Helper (Renderer\nf29\nn127.0.0.1:50405\n";
        let listeners = parse_lsof_listeners(output);
        assert_eq!(
            listeners,
            vec![(6867, "GitHub Desktop Helper (Renderer".to_string(), 50405)]
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
        assert_eq!(listeners, vec![(100, "node".to_string(), 5178)]);
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
        let listeners = vec![(100, "node".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-a"));
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &worktrees);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].worktree_path, "/tmp/wt/feature-a");
        assert_eq!(servers[0].port, 5178);
        assert_eq!(servers[0].pid, 100);
        assert_eq!(servers[0].process_name, "node");
    }

    #[test]
    fn test_match_cwd_inside_worktree() {
        // cwd is a subdirectory of the worktree.
        let listeners = vec![(100, "vite".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-a/packages/web"));
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &worktrees);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].worktree_path, "/tmp/wt/feature-a");
    }

    #[test]
    fn test_match_pid_missing_from_cwd_map() {
        let listeners = vec![(100, "node".to_string(), 5178)];
        let cwds: HashMap<u32, PathBuf> = HashMap::new(); // pid 100 absent
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &worktrees);
        assert!(servers.is_empty());
    }

    #[test]
    fn test_match_nested_longest_wins() {
        // cwd is inside the nested worktree, which is itself inside the parent.
        let listeners = vec![(100, "node".to_string(), 8004)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/feature-a/nested/src"));
        let worktrees = vec![
            "/tmp/wt/feature-a".to_string(),
            "/tmp/wt/feature-a/nested".to_string(),
        ];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &worktrees);
        assert_eq!(servers.len(), 1);
        // Longest match wins.
        assert_eq!(servers[0].worktree_path, "/tmp/wt/feature-a/nested");
    }

    #[test]
    fn test_match_canonicalize_fallback_nonexistent_path() {
        // A worktree path that does not exist on disk: canonicalize fails and we
        // fall back to the raw path, which still matches the cwd string.
        let listeners = vec![(100, "node".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/nonexistent/grovr/wt/feature-a"));
        let worktrees = vec!["/nonexistent/grovr/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &worktrees);
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].worktree_path, "/nonexistent/grovr/wt/feature-a");
    }

    #[test]
    fn test_match_sorted_output() {
        let listeners = vec![
            (101, "node".to_string(), 8004),
            (100, "vite".to_string(), 5178),
            (102, "python".to_string(), 3000),
        ];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/tmp/wt/b"));
        cwds.insert(101, PathBuf::from("/tmp/wt/a"));
        cwds.insert(102, PathBuf::from("/tmp/wt/b"));
        let worktrees = vec!["/tmp/wt/a".to_string(), "/tmp/wt/b".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &worktrees);
        // Sorted by (worktree_path, port): a:8004, b:3000, b:5178.
        assert_eq!(servers.len(), 3);
        assert_eq!((servers[0].worktree_path.as_str(), servers[0].port), ("/tmp/wt/a", 8004));
        assert_eq!((servers[1].worktree_path.as_str(), servers[1].port), ("/tmp/wt/b", 3000));
        assert_eq!((servers[2].worktree_path.as_str(), servers[2].port), ("/tmp/wt/b", 5178));
    }

    #[test]
    fn test_match_no_worktree() {
        // Process listening but cwd is outside all worktrees -> no match.
        let listeners = vec![(100, "node".to_string(), 5178)];
        let mut cwds = HashMap::new();
        cwds.insert(100, PathBuf::from("/some/other/place"));
        let worktrees = vec!["/tmp/wt/feature-a".to_string()];

        let servers = match_servers_to_worktrees(&listeners, &cwds, &worktrees);
        assert!(servers.is_empty());
    }
}
