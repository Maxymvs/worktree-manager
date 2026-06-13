import type { Project, Worktree } from '@/types';
import type { PullRequestInfo, JiraIssueInfo } from '@/lib/api';

// Extended worktree with PR and Jira info
export interface WorktreeWithIntegrations extends Worktree {
  prInfo?: PullRequestInfo;
  jiraInfo?: JiraIssueInfo;
}

export interface ProjectWithIntegrations extends Omit<Project, 'worktrees'> {
  worktrees: WorktreeWithIntegrations[];
}
