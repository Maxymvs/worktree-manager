import type { WorktreeDeleteRisk } from '@/lib/api';

/**
 * Build the risk-warning body shown before a delete that would discard real
 * work. Shared by the worktree list's delete dialogs and the edit page so both
 * describe the loss identically.
 *
 * `branch` names the branch the unpushed commits sit on; when it's missing the
 * copy falls back to "this branch".
 */
export function describeDeleteRisk(
  branch: string | null | undefined,
  risk: WorktreeDeleteRisk | null
): string {
  const branchLabel = branch ?? 'this branch';
  const parts: string[] = [];
  if (risk?.has_uncommitted_changes) {
    parts.push('uncommitted changes');
  }
  if (risk && risk.unpushed_commits > 0) {
    const n = risk.unpushed_commits;
    parts.push(`${n} unpushed commit${n === 1 ? '' : 's'} on "${branchLabel}"`);
  }
  const what = parts.length > 0 ? parts.join(' and ') : 'unsaved work';
  return `This worktree has ${what} that exist nowhere else.\n\nDeleting will permanently discard ${
    parts.length > 1 ? 'them' : 'it'
  }. This cannot be undone.`;
}
