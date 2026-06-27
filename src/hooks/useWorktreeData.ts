import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '@/lib/api';
import {
  getCachedPullRequests,
  getCachedJiraIssue,
  getCachedRemoteInfo,
  invalidateIntegrationCache,
} from '@/lib/integration-cache';
import type { IDEPreset } from '@/types';
import type { WorktreeWithIntegrations, ProjectWithIntegrations } from '@/components/worktree/types';

interface UseWorktreeDataOptions {
  expandedProjects: Set<string>;
  onExpandedProjectsChange: (expanded: Set<string>) => void;
}

interface UseWorktreeDataResult {
  projects: ProjectWithIntegrations[];
  setProjects: React.Dispatch<React.SetStateAction<ProjectWithIntegrations[]>>;
  settings: api.BackendAppSettings | null;
  setSettings: React.Dispatch<React.SetStateAction<api.BackendAppSettings | null>>;
  loading: boolean;
  hasGitHub: boolean;
  hasJira: boolean;
  jiraHost: string | null;
  reload: () => Promise<void>;
}

/**
 * Loads projects, worktrees, app settings, and integration configuration, then
 * hydrates GitHub PR and Jira issue info in the background.
 *
 * `reload` re-runs the full load (used by the refresh button and after
 * mutations) and first invalidates the integration cache so it always
 * re-fetches fresh PR/Jira data. GitHub PR, Jira, and remote-info lookups go
 * through `@/lib/integration-cache`, which dedups in-flight requests and serves
 * short-lived (5 min) cached values — collapsing the inline + background
 * double-fetch into a single backend call per key.
 */
export function useWorktreeData({
  expandedProjects,
  onExpandedProjectsChange,
}: UseWorktreeDataOptions): UseWorktreeDataResult {
  const [projects, setProjects] = useState<ProjectWithIntegrations[]>([]);
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<api.BackendAppSettings | null>(null);
  const [hasGitHub, setHasGitHub] = useState(false);
  const [hasJira, setHasJira] = useState(false);
  const [jiraHost, setJiraHost] = useState<string | null>(null);

  // Helper to update a single worktree with integration data
  const updateWorktree = useCallback((repoPath: string, worktreePath: string, data: Partial<WorktreeWithIntegrations>) => {
    setProjects(prev => prev.map(p =>
      p.repoPath === repoPath
        ? { ...p, worktrees: p.worktrees.map(w =>
            w.path === worktreePath ? { ...w, ...data } : w
          )}
        : p
    ));
  }, []);

  // Load integration data in background (non-blocking)
  const loadIntegrationData = useCallback(async (
    projectsWithWorktrees: ProjectWithIntegrations[],
    githubConfig: { id?: string; host?: string } | null,
    jiraConfig: { host?: string; email?: string } | null
  ) => {
    for (const project of projectsWithWorktrees) {
      const remoteInfo = await getCachedRemoteInfo(project.repoPath, githubConfig?.host).catch(() => null);

      for (const worktree of project.worktrees) {
        // Load Jira info if configured and issue number exists
        if (jiraConfig?.host && worktree.issueNumber) {
          console.log('[Jira Debug] Fetching issue:', worktree.issueNumber, 'host:', jiraConfig.host);
          getCachedJiraIssue(worktree.issueNumber)
            .then(jiraInfo => {
              console.log('[Jira Debug] Result for', worktree.issueNumber, ':', jiraInfo);
              if (jiraInfo) {
                updateWorktree(project.repoPath, worktree.path, { jiraInfo });
              }
            })
            .catch(err => {
              console.error('[Jira Debug] Failed to fetch Jira issue:', worktree.issueNumber, err);
            });
        }

        // Load PR info if GitHub configured
        if (githubConfig?.id && remoteInfo && !worktree.isMain) {
          getCachedPullRequests(remoteInfo.owner, remoteInfo.repo, worktree.branch)
            .then(prs => {
              if (prs.length > 0) {
                updateWorktree(project.repoPath, worktree.path, { prInfo: prs[0] });
              }
            })
            .catch(err => {
              console.error('Failed to fetch PRs:', worktree.branch, err);
            });
        }
      }
    }
  }, [updateWorktree]);

  const loadData = async (opts?: { forceFresh?: boolean }) => {
    try {
      // Explicit refreshes drop all cached integration data so they always
      // re-fetch; the initial mount load keeps any warm cache.
      if (opts?.forceFresh) {
        invalidateIntegrationCache();
      }
      setLoading(true);
      const [settingsData, projectsData, githubConfig, jiraConfig] = await Promise.all([
        api.getSettings(),
        api.getProjects(),
        api.getGitHubConfig().catch(() => null),
        api.getJiraConfig().catch(() => null),
      ]);
      setSettings(settingsData);
      // Check if integrations are configured (by metadata presence, not token)
      setHasGitHub(!!githubConfig?.id);
      setHasJira(!!jiraConfig?.host);
      setJiraHost(jiraConfig?.host || null);

      // Load worktrees with memos only (local data - fast)
      const projectsWithWorktrees: ProjectWithIntegrations[] = await Promise.all(
        projectsData.map(async (p) => {
          try {
            const worktrees = await api.getWorktrees(p.repo_path);
            const remoteInfo = await getCachedRemoteInfo(p.repo_path, githubConfig?.host).catch(() => null);

            // Load memos only (local data)
            const worktreesWithMemos: WorktreeWithIntegrations[] = await Promise.all(
              worktrees.map(async (w) => {
                const result: WorktreeWithIntegrations = {
                  path: w.path,
                  branch: w.branch,
                  isMain: w.is_main,
                  isDetached: w.is_detached,
                  prunable: w.prunable,
                };

                // Load memo (local data)
                try {
                  const memo = await api.getWorktreeMemo(w.path);
                  result.description = memo.description;
                  result.issueNumber = memo.issue_number;
                  result.comment = memo.comment;
                } catch {
                  // Ignore
                }

                // Load Jira info if configured and issue number exists
                if (jiraConfig?.host && result.issueNumber) {
                  try {
                    const jiraInfo = await getCachedJiraIssue(result.issueNumber);
                    if (jiraInfo) {
                      result.jiraInfo = jiraInfo;
                    }
                  } catch {
                    // Ignore - Jira fetch failed
                  }
                }

                // Load PR info if GitHub configured
                if (githubConfig?.id && remoteInfo && !w.is_main) {
                  try {
                    const prs = await getCachedPullRequests(remoteInfo.owner, remoteInfo.repo, w.branch);
                    if (prs.length > 0) {
                      // Get the most recent/relevant PR
                      result.prInfo = prs[0];
                    }
                  } catch {
                    // Ignore - PR fetch failed
                  }
                }

                return result;
              })
            );

            return {
              name: p.name,
              repoPath: p.repo_path,
              defaultBaseBranch: p.default_base_branch,
              ide: p.ide?.preset as IDEPreset | undefined,
              worktrees: worktreesWithMemos,
            };
          } catch {
            return {
              name: p.name,
              repoPath: p.repo_path,
              defaultBaseBranch: p.default_base_branch,
              ide: p.ide?.preset as IDEPreset | undefined,
              worktrees: [],
            };
          }
        })
      );

      setProjects(projectsWithWorktrees);
      // Only auto-expand all if no expansion state exists
      if (expandedProjects.size === 0) {
        onExpandedProjectsChange(new Set(projectsWithWorktrees.map((p) => p.repoPath)));
      }

      // UI is now ready - stop loading indicator
      setLoading(false);

      // Load integration data in background (non-blocking)
      loadIntegrationData(projectsWithWorktrees, githubConfig, jiraConfig);
    } catch (err) {
      console.error('Failed to load data:', err);
      setLoading(false);
    }
  };

  // Run the initial load once on mount, matching the original closure which
  // captured the initial (empty) expansion state.
  const loadDataRef = useRef(loadData);
  loadDataRef.current = loadData;
  useEffect(() => {
    loadDataRef.current();
  }, []);

  return {
    projects,
    setProjects,
    settings,
    setSettings,
    loading,
    hasGitHub,
    hasJira,
    jiraHost,
    reload: () => loadData({ forceFresh: true }),
  };
}
