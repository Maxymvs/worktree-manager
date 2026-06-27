/**
 * Framework-agnostic, dependency-free TTL cache with in-flight promise dedup
 * for integration lookups (GitHub PRs, Jira issues, remote info).
 *
 * GitHub PR + Jira data is re-fetched on every page mount, refresh, and—in
 * `useWorktreeData`—twice per load (inline + background). This cache collapses
 * those duplicates: identical keys within the TTL window return the cached
 * value, and concurrent requests for the same key share a single in-flight
 * promise rather than firing duplicate backend calls.
 *
 * Kept React-free so it stays unit-testable and reusable.
 */
import * as api from '@/lib/api';
import type { PullRequestInfo, JiraIssueInfo, GitHubRemoteInfo } from '@/lib/api';

export const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// Resolved values, keyed by request key. `unknown` because the map is shared
// across heterogeneous value types; `cached<T>` narrows on the way out.
const resolved = new Map<string, CacheEntry<unknown>>();

// In-flight requests, keyed identically, so concurrent callers dedup.
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Returns a cached value for `key` if present and unexpired. Otherwise, if a
 * request for `key` is already in flight, returns that same promise (dedup).
 * Otherwise invokes `loader`, stores the in-flight promise, and on resolve
 * caches the value with `expiresAt = Date.now() + ttlMs`.
 *
 * On loader rejection the in-flight entry is cleared and nothing is cached, so
 * errors are not sticky; the rejection is rethrown to the caller.
 */
export async function cached<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const entry = resolved.get(key);
  // Treat entries at or after their expiry instant as stale (strict `>`).
  if (entry && entry.expiresAt > Date.now()) {
    return entry.value as T;
  }

  const pending = inFlight.get(key);
  if (pending) {
    return pending as Promise<T>;
  }

  const promise = (async () => {
    try {
      const value = await loader();
      // Only successful loads are cached; on rejection nothing is written, so
      // errors are not sticky.
      resolved.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } finally {
      // Clear the in-flight entry on both success and failure.
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

// ============ Typed wrappers ============

export function getCachedPullRequests(
  owner: string,
  repo: string,
  branch: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<PullRequestInfo[]> {
  return cached(`pr:${owner}/${repo}#${branch}`, ttlMs, () =>
    api.fetchPullRequests(owner, repo, branch),
  );
}

export function getCachedJiraIssue(
  issueKey: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<JiraIssueInfo | null> {
  return cached(`jira:${issueKey}`, ttlMs, () => api.fetchJiraIssue(issueKey));
}

export function getCachedRemoteInfo(
  repoPath: string,
  host?: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<GitHubRemoteInfo | null> {
  return cached(`remote:${repoPath}|${host ?? ''}`, ttlMs, () =>
    api.getGitHubRemoteInfo(repoPath, host),
  );
}

/**
 * Clears both the resolved and in-flight maps. Called by manual refresh so an
 * explicit user-initiated reload always re-fetches fresh data.
 */
export function invalidateIntegrationCache(): void {
  resolved.clear();
  inFlight.clear();
}
