import { useState, useEffect, useMemo } from 'react';
import * as api from '@/lib/api';
import type { RunningServer } from '@/lib/api';

const SERVER_POLL_INTERVAL_MS = 4000;

/**
 * Poll for running dev servers across the given worktree paths.
 *
 * Pauses while the window is hidden (polling immediately again when it becomes
 * visible), guards against overlapping in-flight calls, and only updates state
 * when the serialized result actually changes (avoids 4s re-render churn).
 * Returns servers keyed by worktree path.
 */
export function useServerPolling(worktreePaths: string[]): Record<string, RunningServer[]> {
  // Running dev servers, keyed by worktree path.
  const [serversByPath, setServersByPath] = useState<Record<string, RunningServer[]>>({});

  // Stable string key avoids re-subscribing the effect when the array identity
  // changes but its contents don't.
  const worktreePathsKey = useMemo(
    () => [...worktreePaths].sort().join('\n'),
    [worktreePaths]
  );

  useEffect(() => {
    if (worktreePaths.length === 0) {
      setServersByPath((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      if (cancelled || inFlight) return;
      if (document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const servers = await api.getRunningServers(worktreePaths);
        if (cancelled) return;
        const grouped: Record<string, RunningServer[]> = {};
        for (const server of servers) {
          (grouped[server.worktree_path] ??= []).push(server);
        }
        setServersByPath((prev) =>
          JSON.stringify(prev) === JSON.stringify(grouped) ? prev : grouped
        );
      } catch (err) {
        // Keep previous state on error (e.g. lsof unavailable).
        console.error('Failed to poll running servers:', err);
      } finally {
        inFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        poll();
      }
    };

    // Immediate first poll, then on an interval.
    poll();
    intervalId = setInterval(poll, SERVER_POLL_INTERVAL_MS);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreePathsKey]);

  return serversByPath;
}
