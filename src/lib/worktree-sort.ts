import type { WorktreeSortMode } from '@/types';
import type { RunningServer } from '@/lib/api';

/** The sort modes, in the order they're presented in the sort menu. */
export const WORKTREE_SORT_MODES: readonly WorktreeSortMode[] = [
  'name',
  'name-desc',
  'newest',
  'oldest',
  'uptime',
] as const;

/** Human labels for the sort menu. */
export const WORKTREE_SORT_LABELS: Record<WorktreeSortMode, string> = {
  name: 'Name (A–Z)',
  'name-desc': 'Name (Z–A)',
  newest: 'Newest first',
  oldest: 'Oldest first',
  uptime: 'Longest running',
};

export const DEFAULT_WORKTREE_SORT: WorktreeSortMode = 'name';

/**
 * Narrows an arbitrary persisted string to a known sort mode. A hand-edited
 * settings.json holding garbage must not break the list, so anything
 * unrecognized (or null/undefined) falls back to the default.
 */
export function parseWorktreeSortMode(value: unknown): WorktreeSortMode {
  return typeof value === 'string' &&
    (WORKTREE_SORT_MODES as readonly string[]).includes(value)
    ? (value as WorktreeSortMode)
    : DEFAULT_WORKTREE_SORT;
}

interface SortableWorktree {
  path: string;
  branch: string;
  createdAtMs?: number;
}

/** Deterministic tie-break so rows never jitter between renders. */
function byBranchThenPath(a: SortableWorktree, b: SortableWorktree): number {
  return a.branch.localeCompare(b.branch) || a.path.localeCompare(b.path);
}

/** Highest uptime across every server detected in this worktree (0 if none). */
function maxUptime(
  worktree: SortableWorktree,
  serversByPath: Record<string, RunningServer[]>
): number {
  const servers = serversByPath[worktree.path];
  if (!servers || servers.length === 0) return 0;
  return servers.reduce((max, s) => (s.uptime_secs > max ? s.uptime_secs : max), 0);
}

/**
 * Orders a project's worktrees for display. Pure: the input array is copied
 * before sorting. The main worktree is not pinned — it sorts like any other
 * row (the `main` badge still identifies it).
 *
 * Worktrees with an unknown `createdAtMs` always sort last in both date modes:
 * "unknown" is not the same as "old".
 */
export function sortWorktrees<T extends SortableWorktree>(
  worktrees: T[],
  mode: WorktreeSortMode,
  serversByPath: Record<string, RunningServer[]>
): T[] {
  const copy = [...worktrees];

  switch (mode) {
    case 'name-desc':
      return copy.sort((a, b) => -byBranchThenPath(a, b));

    case 'newest':
    case 'oldest': {
      const dir = mode === 'newest' ? -1 : 1;
      return copy.sort((a, b) => {
        const aKnown = a.createdAtMs !== undefined;
        const bKnown = b.createdAtMs !== undefined;
        if (!aKnown || !bKnown) {
          if (aKnown !== bKnown) return aKnown ? -1 : 1; // unknown last
          return byBranchThenPath(a, b);
        }
        return dir * (a.createdAtMs! - b.createdAtMs!) || byBranchThenPath(a, b);
      });
    }

    case 'uptime':
      return copy.sort((a, b) => {
        const diff = maxUptime(b, serversByPath) - maxUptime(a, serversByPath);
        return diff || byBranchThenPath(a, b);
      });

    case 'name':
    default:
      return copy.sort(byBranchThenPath);
  }
}
