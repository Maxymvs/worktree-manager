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
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { PullRequestInfo, RunningServer } from '@/lib/api';
import type { WorktreeWithIntegrations } from './types';

interface WorktreeRowProps {
  worktree: WorktreeWithIntegrations;
  onOpenIde: (path: string) => void;
  onOpenFinder: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  showDescription: boolean;
  showGitHub: boolean;
  showJira: boolean;
  showServers: boolean;
  servers: RunningServer[];
  jiraHost: string | null;
  isSelected: boolean;
}

export function WorktreeRow({
  worktree,
  onOpenIde,
  onOpenFinder,
  onOpenTerminal,
  onEdit,
  onDelete,
  showDescription,
  showGitHub,
  showJira,
  showServers,
  servers,
  jiraHost,
  isSelected,
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

  const handleRowClick = () => {
    if (!showActions) {
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
        // Use bottom positioning for upward opening
        setDropdownPos({
          bottom: window.innerHeight - rect.top + 2,
          left: rect.right - 160,
        });
      } else {
        setDropdownPos({
          top: rect.bottom + 2,
          left: rect.right - 160,
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

  const MAX_VISIBLE_PORTS = 3;
  const visiblePorts = serverPorts.slice(0, MAX_VISIBLE_PORTS);
  const overflowPorts = serverPorts.slice(MAX_VISIBLE_PORTS);

  return (
    <div
      className={`worktree-row ${isSelected ? 'worktree-row-selected' : ''}`}
      data-worktree-path={worktree.path}
      onClick={handleRowClick}
      onMouseLeave={() => setShowActions(false)}
    >
      {/* Branch */}
      <div className="worktree-col-branch">
        <GitBranch size={14} className="worktree-branch-icon" />
        {worktree.isDetached ? (
          <span className="worktree-branch-detached" title="Detached HEAD">
            (detached @ {worktree.branch})
          </span>
        ) : (
          <span className="worktree-branch-name">{worktree.branch}</span>
        )}
        {worktree.isMain && <span className="worktree-main-badge">main</span>}
        {worktree.prunable && (
          <span className="worktree-prunable-badge" title="This worktree can be pruned">
            prunable
          </span>
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

      {/* Running dev servers - port badges */}
      {showServers && (
        <div className="worktree-col-servers">
          {serverPorts.length > 0 && (
            <>
              <span className="server-pulse-dot" aria-hidden="true" />
              {visiblePorts.map((server) => (
                <button
                  key={server.port}
                  className="integration-badge-link status-running"
                  title={`${server.process_name} (pid ${server.pid}) — open http://localhost:${server.port}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openUrl(`http://localhost:${server.port}`);
                  }}
                >
                  <span className="badge-text">:{server.port}</span>
                </button>
              ))}
              {overflowPorts.length > 0 && (
                <span
                  className="integration-badge-link status-running"
                  title={`Also: ${overflowPorts.map((s) => `:${s.port}`).join(', ')}`}
                >
                  <span className="badge-text">+{overflowPorts.length}</span>
                </span>
              )}
            </>
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

      {/* Actions */}
      <div className="worktree-col-actions">
        <button
          ref={buttonRef}
          className="worktree-more"
          title="More actions"
          onClick={handleMoreClick}
        >
          <MoreHorizontal size={14} />
        </button>
        {showActions && createPortal(
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
    </div>
  );
}
