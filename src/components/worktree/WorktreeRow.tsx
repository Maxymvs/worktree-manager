import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  GitBranch,
  MoreHorizontal,
  Folder,
  Terminal,
  Pencil,
  ExternalLink,
  GitPullRequest,
  CircleDot,
  GitMerge,
  Trash2,
  ChevronDown,
  MessageSquare,
  MessageSquarePlus,
  Loader2,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import type { PullRequestInfo, RunningServer } from '@/lib/api';
import type { WorktreeWithIntegrations } from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** Long-form relative age for the server hover card, e.g. "12 days ago". */
function formatAgeLong(ms: number): string {
  const elapsed = Math.max(0, Date.now() - ms);
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
  if (elapsed < MINUTE_MS) return 'just now';
  if (elapsed < HOUR_MS) return plural(Math.floor(elapsed / MINUTE_MS), 'minute');
  if (elapsed < DAY_MS) return plural(Math.floor(elapsed / HOUR_MS), 'hour');
  if (elapsed < MONTH_MS) return plural(Math.floor(elapsed / DAY_MS), 'day');
  if (elapsed < YEAR_MS) return plural(Math.floor(elapsed / MONTH_MS), 'month');
  return plural(Math.floor(elapsed / YEAR_MS), 'year');
}

/** Absolute creation timestamp for the server hover card, e.g. "Jul 19, 2026 at 2:41 PM". */
function formatCreatedAt(ms: number): string {
  const date = new Date(ms);
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}

/** Compact human-readable uptime, e.g. "45s", "12m", "3h 5m", "2d 4h". */
function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Heuristic score for how likely a server is the web frontend you'd open in a
 * browser. The pill opens the highest-scoring server (ties → lowest port), so a
 * stray low-numbered API (e.g. :4747) doesn't get picked over the real Vite
 * dev server. The hover dropdown still lists every server regardless.
 */
function primaryServerScore(s: RunningServer): number {
  let score = 0;
  const p = s.port;
  if (p >= 5173 && p <= 5199) score += 100;                       // Vite default range
  else if (p >= 3000 && p <= 3010) score += 80;                   // Next/CRA/Remix/Nuxt
  else if (p === 4321 || p === 4200 || p === 5500 || p === 8080) score += 60; // Astro/Angular/Live Server
  const name = s.process_name.toLowerCase();
  if (name.includes('node') || name.includes('bun') || name.includes('deno')) score += 40; // JS runtime
  return score;
}

/** Human label for a listener's bind address. Returns '' when not meaningful. */
function bindScopeLabel(address: string): string {
  switch (address) {
    case '*':
    case '0.0.0.0':
      return 'all interfaces';
    case '127.0.0.1':
    case '::1':
    case '[::1]':
    case 'localhost':
      return 'localhost only';
    default:
      return address;
  }
}

interface WorktreeRowProps {
  worktree: WorktreeWithIntegrations;
  onOpenIde: (path: string) => void;
  onOpenFinder: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onEdit: () => void;
  onEditComment: () => void;
  onDelete: () => void;
  showDescription: boolean;
  showGitHub: boolean;
  showJira: boolean;
  showServers: boolean;
  servers: RunningServer[];
  jiraHost: string | null;
  isSelected: boolean;
  /** Deletion is running in the background for this worktree. */
  isDeleting: boolean;
}

export function WorktreeRow({
  worktree,
  onOpenIde,
  onOpenFinder,
  onOpenTerminal,
  onEdit,
  onEditComment,
  onDelete,
  showDescription,
  showGitHub,
  showJira,
  showServers,
  servers,
  jiraHost,
  isSelected,
  isDeleting,
}: WorktreeRowProps) {
  const [showActions, setShowActions] = useState(false);
  const [dropdownPos, setDropdownPos] = useState<{
    top?: number;
    bottom?: number;
    left: number;
  }>({ left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showActions) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        dropdownRef.current && !dropdownRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) {
        setShowActions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showActions]);

  // Deletion hides the trigger button, so an already-open menu would be left
  // floating with no way back to it — and every item acts on a directory that
  // is disappearing. Close it as soon as the delete starts.
  useEffect(() => {
    if (isDeleting) setShowActions(false);
  }, [isDeleting]);

  const handleRowClick = () => {
    // A row being deleted is inert — its directory is going away.
    if (!showActions && !isDeleting) {
      onOpenIde(worktree.path);
    }
  };

  const handleMoreClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!showActions && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      const dropdownHeight = 110;
      const spaceBelow = window.innerHeight - rect.bottom;
      const openUpward = spaceBelow < dropdownHeight + 10;

      if (openUpward) {
        // Use bottom positioning for upward opening. Button is now on the
        // left side of the row, so left-align the menu to the button.
        setDropdownPos({
          bottom: window.innerHeight - rect.top + 2,
          left: Math.max(8, rect.left),
        });
      } else {
        setDropdownPos({
          top: rect.bottom + 2,
          left: Math.max(8, rect.left),
        });
      }
    }
    setShowActions(!showActions);
  };

  const getPRStatusClass = (pr: PullRequestInfo) => {
    if (pr.merged) return 'status-merged';
    if (pr.draft) return 'status-draft';
    if (pr.state === 'open') return 'status-open';
    return 'status-closed';
  };

  const getPRIcon = (pr: PullRequestInfo) => {
    if (pr.merged) return <GitMerge size={10} className="badge-icon" />;
    return <GitPullRequest size={10} className="badge-icon" />;
  };

  const getJiraStatusClass = (category: string) => {
    switch (category) {
      case 'done':
        return 'status-done';
      case 'indeterminate':
        return 'status-in-progress';
      default:
        return 'status-todo';
    }
  };

  // Deduped, ascending ports for this worktree's running servers, plus a lookup
  // from port -> server (for pid/name in the badge tooltip).
  const serverPorts = useMemo(() => {
    const byPort = new Map<number, RunningServer>();
    for (const s of servers) {
      if (!byPort.has(s.port)) byPort.set(s.port, s);
    }
    return [...byPort.values()].sort((a, b) => a.port - b.port);
  }, [servers]);

  // The pill opens the most likely web frontend (see primaryServerScore);
  // the dropdown still lists every server in ascending-port order.
  const primary = useMemo(
    () =>
      [...serverPorts].sort(
        (a, b) => primaryServerScore(b) - primaryServerScore(a) || a.port - b.port
      )[0],
    [serverPorts]
  );
  const hasMultiple = serverPorts.length > 1;

  return (
    <div
      className={`worktree-row ${isSelected ? 'worktree-row-selected' : ''}${
        isDeleting ? ' worktree-row-deleting' : ''
      }`}
      data-worktree-path={worktree.path}
      aria-busy={isDeleting || undefined}
      onClick={handleRowClick}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Branch */}
      <div className="worktree-col-branch">
        <GitBranch size={14} className="worktree-branch-icon" />
        {worktree.isDetached ? (
          <>
            <span className="worktree-branch-detached">{worktree.branch}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="worktree-detached-badge" data-testid="detached-badge">
                  no branch
                </span>
              </TooltipTrigger>
              <TooltipContent>
                Detached HEAD — this worktree is checked out at commit {worktree.branch} instead
                of a branch. Usually leftover from a checkout or rebase; new commits here won't
                belong to any branch.
              </TooltipContent>
            </Tooltip>
          </>
        ) : (
          <span className="worktree-branch-name">{worktree.branch}</span>
        )}
        {worktree.isMain && <span className="worktree-main-badge">main</span>}
        {worktree.prunable && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="worktree-prunable-badge" data-testid="stale-badge">
                stale
              </span>
            </TooltipTrigger>
            <TooltipContent>
              Git can no longer find this worktree's folder — it was likely deleted or moved
              outside the app. The entry is safe to remove: use Delete to clean it up. (Git calls
              this "prunable".)
            </TooltipContent>
          </Tooltip>
        )}
        {/* No actions while the worktree is being removed — every one of them
            operates on a directory that is disappearing. */}
        {!isDeleting && (
          <button
            ref={buttonRef}
            className="worktree-more"
            title="More actions"
            onClick={handleMoreClick}
          >
            <MoreHorizontal size={14} />
          </button>
        )}
        {showActions && !isDeleting && createPortal(
          <div
            ref={dropdownRef}
            className="worktree-actions-dropdown-portal"
            style={{
              top: dropdownPos.top,
              bottom: dropdownPos.bottom,
              left: dropdownPos.left,
            }}
          >
            <button
              className="worktree-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
                setShowActions(false);
              }}
            >
              <Pencil size={14} />
              <span>Edit</span>
            </button>
            <button
              className="worktree-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                onOpenFinder(worktree.path);
                setShowActions(false);
              }}
            >
              <Folder size={14} />
              <span>Open in Finder</span>
            </button>
            <button
              className="worktree-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                onOpenTerminal(worktree.path);
                setShowActions(false);
              }}
            >
              <Terminal size={14} />
              <span>Open Terminal</span>
            </button>
            <button
              className="worktree-dropdown-item"
              onClick={(e) => {
                e.stopPropagation();
                onEditComment();
                setShowActions(false);
              }}
            >
              {worktree.comment ? <MessageSquare size={14} /> : <MessageSquarePlus size={14} />}
              <span>{worktree.comment ? 'Edit comment' : 'Add comment'}</span>
            </button>
            {!worktree.isMain && (
              <>
                <div className="worktree-dropdown-divider" />
                <button
                  className="worktree-dropdown-item worktree-dropdown-item-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowActions(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={14} />
                  <span>Delete</span>
                </button>
              </>
            )}
          </div>,
          document.body
        )}
      </div>

      {/* Description column doubles as the flexible spacer that right-aligns
          the server/GitHub/Jira/action columns, so the cell always renders;
          the text only appears when a description exists. */}
      <div className="worktree-col-description">
        {showDescription && (
          <span className="worktree-description">
            {worktree.description}
          </span>
        )}
      </div>

      {/* Running dev servers - single primary pill + hover dropdown */}
      {showServers && (
        <div className="worktree-col-servers">
          {/* While deleting, this slot reports progress instead of ports — the
              servers are being killed as part of the removal anyway. */}
          {isDeleting ? (
            <span className="worktree-deleting-badge" data-testid="deleting-badge">
              <Loader2 size={10} className="worktree-deleting-spinner" aria-hidden="true" />
              Deleting…
            </span>
          ) : (
            primary && (
            <HoverCard openDelay={150} closeDelay={100}>
              <HoverCardTrigger asChild>
                <button
                  className="integration-badge-link status-running server-pill"
                  onClick={(e) => {
                    e.stopPropagation();
                    openUrl(`http://localhost:${primary.port}`);
                  }}
                >
                  <span className="server-pulse-dot" aria-hidden="true" />
                  <span className="badge-text">:{primary.port}</span>
                  {hasMultiple && (
                    <ChevronDown size={10} className="server-pill-chevron" aria-hidden="true" />
                  )}
                </button>
              </HoverCardTrigger>
              <HoverCardContent className="server-hover-card">
                <div className="server-hover-list">
                  {serverPorts.map((server) => {
                    const scope = bindScopeLabel(server.address);
                    return (
                      <button
                        key={server.port}
                        className="server-hover-item"
                        onClick={(e) => {
                          e.stopPropagation();
                          openUrl(`http://localhost:${server.port}`);
                        }}
                      >
                        <span className="server-hover-item-head">
                          <span className="server-hover-name">{server.process_name}</span>
                          <span className="server-hover-port">:{server.port}</span>
                        </span>
                        {(server.uptime_secs > 0 || scope) && (
                          <span className="server-hover-meta">
                            {server.uptime_secs > 0 && <span>up {formatUptime(server.uptime_secs)}</span>}
                            {server.uptime_secs > 0 && scope && <span className="server-hover-sep">·</span>}
                            {scope && <span>{scope}</span>}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                <div className="server-hover-footer">
                  {/* The main worktree is the clone itself — it was never
                      created by `git worktree add`, so its birthtime is the
                      clone date and gets labelled as such. */}
                  {worktree.createdAtMs !== undefined && (
                    <div className="server-hover-created" data-testid="worktree-age">
                      {worktree.isMain ? 'Repo cloned' : 'Worktree created'}{' '}
                      {formatAgeLong(worktree.createdAtMs)} · {formatCreatedAt(worktree.createdAtMs)}
                    </div>
                  )}
                  <div>Click to open in browser</div>
                </div>
              </HoverCardContent>
            </HoverCard>
            )
          )}
        </div>
      )}

      {/* GitHub Status - badge style */}
      {showGitHub && (
        <div className="worktree-col-github">
          {worktree.prInfo ? (
            <button
              className={`integration-badge-link ${getPRStatusClass(worktree.prInfo)}`}
              onClick={(e) => {
                e.stopPropagation();
                openUrl(worktree.prInfo!.url);
              }}
            >
              {getPRIcon(worktree.prInfo)}
              <span className="badge-text">#{worktree.prInfo.number}</span>
              <ExternalLink size={8} className="badge-external" />
            </button>
          ) : null}
        </div>
      )}

      {/* Jira Status - badge style */}
      {showJira && (
        <div className="worktree-col-jira">
          {worktree.issueNumber && jiraHost ? (
            <button
              className={`integration-badge-link ${worktree.jiraInfo ? getJiraStatusClass(worktree.jiraInfo.status_category) : 'status-link-only'}`}
              onClick={(e) => {
                e.stopPropagation();
                const url = worktree.jiraInfo?.url || `https://${jiraHost}/browse/${worktree.issueNumber}`;
                openUrl(url);
              }}
            >
              <CircleDot size={10} className="badge-icon" />
              <span className="badge-text">
                {worktree.jiraInfo?.key || worktree.issueNumber}
              </span>
              <ExternalLink size={8} className="badge-external" />
            </button>
          ) : null}
        </div>
      )}

      {/* User note/reminder — full-width line under the row content */}
      {worktree.comment && (
        <div className="worktree-comment">
          <span className="worktree-comment-text">{worktree.comment}</span>
        </div>
      )}
    </div>
  );
}
