import { useMemo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Settings,
  ChevronRight,
  ChevronDown,
  GitBranchPlus,
  GripVertical,
} from 'lucide-react';
import type { Project, Worktree } from '@/types';
import type { RunningServer } from '@/lib/api';
import { WorktreeRow } from './WorktreeRow';
import type { ProjectWithIntegrations } from './types';

interface ProjectCardProps {
  project: ProjectWithIntegrations;
  expanded: boolean;
  onToggle: () => void;
  onOpenProjectSettings: (project: Project) => void;
  onOpenIde: (path: string, projectIde?: string) => void;
  jiraHost: string | null;
  onOpenFinder: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onCreateWorktree: () => void;
  onEditWorktree: (worktree: Worktree, repoPath: string) => void;
  onDeleteWorktree: (worktree: Worktree, repoPath: string) => void;
  showDescription: boolean;
  showGitHub: boolean;
  showJira: boolean;
  showServers: boolean;
  serversByPath: Record<string, RunningServer[]>;
  selectedPath: string | null;
  searchQuery: string;
}

export function SortableProjectCard(props: ProjectCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.project.repoPath });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <ProjectCard {...props} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

interface ProjectCardInternalProps extends ProjectCardProps {
  dragHandleProps?: Record<string, unknown>;
}

export function ProjectCard({
  project,
  expanded,
  onToggle,
  onOpenProjectSettings,
  onOpenIde,
  onOpenFinder,
  onOpenTerminal,
  onCreateWorktree,
  onEditWorktree,
  onDeleteWorktree,
  showDescription,
  showGitHub,
  showJira,
  showServers,
  serversByPath,
  jiraHost,
  selectedPath,
  searchQuery,
  dragHandleProps,
}: ProjectCardInternalProps) {
  // Filter worktrees by search query
  const filteredWorktrees = useMemo(() => {
    const query = searchQuery.toLowerCase();
    const sorted = [...project.worktrees].sort((a, b) => {
      if (a.isMain && !b.isMain) return -1;
      if (!a.isMain && b.isMain) return 1;
      return a.branch.localeCompare(b.branch);
    });

    if (!query) return sorted;

    return sorted.filter((w) => {
      const branchMatch = w.branch.toLowerCase().includes(query);
      const descMatch = w.description?.toLowerCase().includes(query);
      return branchMatch || descMatch;
    });
  }, [project.worktrees, searchQuery]);
  return (
    <div className="project-section">
      {/* Project Header */}
      <div className="project-header">
        <button
          className="project-drag-handle"
          title="Drag to reorder"
          {...dragHandleProps}
        >
          <GripVertical size={14} />
        </button>
        <button className="project-toggle" onClick={onToggle}>
          <span className="project-name">{project.name}</span>
          {expanded ? (
            <ChevronDown size={14} className="project-chevron" />
          ) : (
            <ChevronRight size={14} className="project-chevron" />
          )}
        </button>
        <div className="project-actions">
          <button
            className="project-action"
            title="New Worktree"
            onClick={(e) => {
              e.stopPropagation();
              onCreateWorktree();
            }}
          >
            <GitBranchPlus size={14} />
          </button>
          <button
            className="project-settings"
            title="Project Settings"
            onClick={(e) => {
              e.stopPropagation();
              onOpenProjectSettings(project);
            }}
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Worktree Table */}
      {expanded && (
        <div
          className="worktree-table"
          style={{
            gridTemplateColumns: [
              'auto',
              // Always-present flexible spacer: holds the description when one
              // exists, and otherwise right-aligns the status/server/action
              // columns against the panel edge regardless of branch length.
              'minmax(0, 1fr)',
              showServers ? 'auto' : null,
              showGitHub ? '80px' : null,
              showJira ? '80px' : null,
              '44px',
            ].filter(Boolean).join(' '),
          }}
        >
          {filteredWorktrees.length === 0 ? (
            <div className="text-muted text-sm py-2 px-3">
              {project.worktrees.length === 0 ? 'No worktrees found' : 'No matching worktrees'}
            </div>
          ) : (
            filteredWorktrees.map((worktree) => (
              <WorktreeRow
                key={worktree.path}
                worktree={worktree}
                onOpenIde={(path) => onOpenIde(path, project.ide)}
                onOpenFinder={onOpenFinder}
                onOpenTerminal={onOpenTerminal}
                onEdit={() => onEditWorktree(worktree, project.repoPath)}
                onDelete={() => onDeleteWorktree(worktree, project.repoPath)}
                showDescription={showDescription}
                showGitHub={showGitHub}
                showJira={showJira}
                showServers={showServers}
                servers={serversByPath[worktree.path] ?? []}
                jiraHost={jiraHost}
                isSelected={selectedPath === worktree.path}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
