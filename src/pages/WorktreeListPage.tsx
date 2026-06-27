import { useState, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import {
  Settings,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { message } from '@tauri-apps/plugin-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getIDEInfo } from '@/lib/ide-config';
import * as api from '@/lib/api';
import type { Project, Worktree, IDEPreset } from '@/types';
import { SortableProjectCard } from '@/components/worktree/ProjectCard';
import { IdeConfirmModal } from '@/components/worktree/modals/IdeConfirmModal';
import { DeleteWorktreeModals } from '@/components/worktree/modals/DeleteWorktreeModals';
import { CommentModal } from '@/components/worktree/modals/CommentModal';
import { useServerPolling } from '@/hooks/useServerPolling';
import { useWorktreeData } from '@/hooks/useWorktreeData';
import { useWorktreeKeyboardNav } from '@/hooks/useWorktreeKeyboardNav';

interface WorktreeListPageProps {
  onOpenSettings: () => void;
  onOpenProjectSettings: (project: Project) => void;
  onAddProject: () => void;
  onCreateWorktree: (project: Project) => void;
  onEditWorktree: (worktree: Worktree, repoPath: string) => void;
  expandedProjects: Set<string>;
  onExpandedProjectsChange: (expanded: Set<string>) => void;
}


export function WorktreeListPage({
  onOpenSettings,
  onOpenProjectSettings,
  onAddProject,
  onCreateWorktree,
  onEditWorktree,
  expandedProjects,
  onExpandedProjectsChange,
}: WorktreeListPageProps) {
  const {
    projects,
    setProjects,
    settings,
    setSettings,
    loading,
    hasGitHub,
    hasJira,
    jiraHost,
    reload,
  } = useWorktreeData({ expandedProjects, onExpandedProjectsChange });

  // IDE confirmation modal state
  const [ideModalOpen, setIdeModalOpen] = useState(false);
  const [ideModalData, setIdeModalData] = useState<{
    path: string;
    preset: IDEPreset;
    customCommand?: string;
    folderName: string;
  } | null>(null);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Delete worktree modal state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteModalData, setDeleteModalData] = useState<{
    worktree: Worktree;
    repoPath: string;
  } | null>(null);
  const [deleteBranchToo, setDeleteBranchToo] = useState(false);
  const [forceDeleteModalOpen, setForceDeleteModalOpen] = useState(false);
  const [forceDeleting, setForceDeleting] = useState(false);
  const [forceDeleteError, setForceDeleteError] = useState('');
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorModalMessage, setErrorModalMessage] = useState('');

  // Comment/note modal state
  const [commentModalOpen, setCommentModalOpen] = useState(false);
  const [savingComment, setSavingComment] = useState(false);
  const [commentTarget, setCommentTarget] = useState<{
    worktree: Worktree;
    repoPath: string;
  } | null>(null);

  const scrollAreaRef = useRef<HTMLDivElement>(null);

  // Drag and drop sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = projects.findIndex((p) => p.repoPath === active.id);
      const newIndex = projects.findIndex((p) => p.repoPath === over.id);

      const newProjects = arrayMove(projects, oldIndex, newIndex);
      setProjects(newProjects);

      // Save new order to backend
      try {
        await api.reorderProjects(newProjects.map((p) => p.repoPath));
      } catch (err) {
        console.error('Failed to save project order:', err);
        // Revert on error
        setProjects(projects);
      }
    }
  };

  // Flat list of all worktree paths, used as the polling input.
  const allWorktreePaths = useMemo(
    () => projects.flatMap((p) => p.worktrees.map((w) => w.path)),
    [projects]
  );

  // Poll for running dev servers, keyed by worktree path.
  const serversByPath = useServerPolling(allWorktreePaths);

  const toggleProject = (repoPath: string) => {
    const next = new Set(expandedProjects);
    if (next.has(repoPath)) {
      next.delete(repoPath);
    } else {
      next.add(repoPath);
    }
    onExpandedProjectsChange(next);
  };

  const executeOpenIde = useCallback(async (path: string, preset: IDEPreset, customCommand?: string) => {
    try {
      await api.openIde(path, preset, customCommand);
    } catch (err) {
      console.error('Failed to open IDE:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      const ideInfo = getIDEInfo(preset);
      await message(
        `Failed to open ${ideInfo.name}.\n\nMake sure the IDE is installed and the command is available in your PATH.\n\nError: ${errorMessage}`,
        { title: 'IDE Error', kind: 'error' }
      );
    }
  }, []);

  const handleOpenIde = useCallback(async (path: string, projectIde?: string) => {
    // Use project IDE override if set, otherwise use global settings
    const preset = (projectIde || settings?.ide?.preset || 'code') as IDEPreset;
    const customCommand = settings?.ide?.custom_command;
    const skipConfirm = settings?.skip_open_ide_confirm ?? false;

    // Show confirmation modal unless skip is enabled
    if (!skipConfirm) {
      const folderName = path.split('/').pop() || path;
      setIdeModalData({ path, preset, customCommand, folderName });
      setDontAskAgain(false);
      setIdeModalOpen(true);
      return;
    }

    // Direct open if skip is enabled
    await executeOpenIde(path, preset, customCommand);
  }, [settings, executeOpenIde]);

  // Keyboard navigation and search
  const {
    selectedPath,
    searchQuery,
    setSearchQuery,
    searchActive,
    setSearchActive,
    searchInputRef,
  } = useWorktreeKeyboardNav({
    projects,
    expandedProjects,
    modalOpen: ideModalOpen || deleteModalOpen || forceDeleteModalOpen || errorModalOpen || commentModalOpen,
    onOpenIde: handleOpenIde,
  });

  const handleIdeModalConfirm = async () => {
    if (!ideModalData) return;

    // Capture data before closing modal
    const { path, preset, customCommand } = ideModalData;

    // Save "don't ask again" preference if checked
    if (dontAskAgain) {
      try {
        await api.setSkipOpenIdeConfirm(true);
        setSettings((prev) =>
          prev ? { ...prev, skip_open_ide_confirm: true } : prev
        );
      } catch (err) {
        console.error('Failed to save skip confirm preference:', err);
      }
    }

    // Close modal and clear data together to prevent empty modal flash
    setIdeModalOpen(false);
    setIdeModalData(null);

    await executeOpenIde(path, preset, customCommand);
  };

  const handleIdeModalCancel = () => {
    setIdeModalOpen(false);
    setIdeModalData(null);
  };

  const handleOpenFinder = async (path: string) => {
    try {
      await api.openInFinder(path);
    } catch (err) {
      console.error('Failed to open Finder:', err);
    }
  };

  const handleOpenTerminal = async (path: string) => {
    try {
      await api.openTerminal(path);
    } catch (err) {
      console.error('Failed to open Terminal:', err);
    }
  };

  const handleDeleteWorktree = (worktree: Worktree, repoPath: string) => {
    setDeleteModalData({ worktree, repoPath });
    // For detached worktrees `branch` holds a SHA, not a real branch, so never
    // offer to delete it.
    setDeleteBranchToo(!worktree.isDetached);
    setDeleteModalOpen(true);
  };

  const handleEditComment = (worktree: Worktree, repoPath: string) => {
    setCommentTarget({ worktree, repoPath });
    setCommentModalOpen(true);
  };

  const handleSaveComment = async (comment: string) => {
    if (!commentTarget) return;
    const { worktree, repoPath } = commentTarget;
    const next = comment || undefined;

    flushSync(() => setSavingComment(true));
    try {
      // setWorktreeMemo replaces the whole memo, so preserve the other fields.
      await api.setWorktreeMemo(worktree.path, {
        description: worktree.description,
        issue_number: worktree.issueNumber,
        comment: next,
      });
      // Update local state so the note appears without a full reload.
      setProjects((prev) =>
        prev.map((p) =>
          p.repoPath === repoPath
            ? {
                ...p,
                worktrees: p.worktrees.map((w) =>
                  w.path === worktree.path ? { ...w, comment: next } : w
                ),
              }
            : p
        )
      );
      setCommentModalOpen(false);
      setCommentTarget(null);
    } catch (err) {
      console.error('Failed to save comment:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setCommentModalOpen(false);
      setCommentTarget(null);
      setErrorModalMessage(`Failed to save comment: ${errorMessage}`);
      setErrorModalOpen(true);
    } finally {
      setSavingComment(false);
    }
  };

  const handleCancelComment = () => {
    setCommentModalOpen(false);
    setCommentTarget(null);
  };

  const executeDeleteWorktree = async (force: boolean = false) => {
    if (!deleteModalData) return;
    const { worktree, repoPath } = deleteModalData;

    // Force React to render loading state before starting operation
    flushSync(() => {
      if (force) {
        setForceDeleting(true);
      } else {
        setDeleting(true);
      }
    });

    try {
      await api.removeWorktree(repoPath, worktree.path, force, deleteBranchToo, worktree.branch);
      setDeleteModalOpen(false);
      setForceDeleteModalOpen(false);
      setDeleteModalData(null);
      setDeleteBranchToo(false);
      reload();
    } catch (err) {
      console.error('Failed to delete worktree:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (!force) {
        // If normal delete fails, offer force delete
        setDeleteModalOpen(false);
        setForceDeleteError(errorMessage);
        setForceDeleteModalOpen(true);
      } else {
        // Force delete also failed
        setForceDeleteModalOpen(false);
        setErrorModalMessage(`Failed to force delete worktree: ${errorMessage}`);
        setErrorModalOpen(true);
        setDeleteModalData(null);
      }
    } finally {
      setDeleting(false);
      setForceDeleting(false);
    }
  };

  // Check if any worktree has data for optional columns
  const allWorktrees = projects.flatMap((p) => p.worktrees);
  const hasAnyDescription = allWorktrees.some((w) => w.description);
  // Only show integration columns if there's actual fetched data
  const hasAnyGitHub = hasGitHub && allWorktrees.some((w) => w.prInfo);
  const hasAnyJira = hasJira && allWorktrees.some((w) => w.jiraInfo || w.issueNumber);
  const hasAnyServers = allWorktrees.some((w) => (serversByPath[w.path]?.length ?? 0) > 0);

  return (
    <div className="h-full flex flex-col">
      {/* Titlebar drag area with actions */}
      <div data-tauri-drag-region className="titlebar">
        <div className="titlebar-spacer" />
        <span data-tauri-drag-region className="titlebar-title">
          Worktree Manager{import.meta.env.VITE_PREVIEW_WORKTREE && ` (${import.meta.env.VITE_PREVIEW_WORKTREE})`}
        </span>
        <div className="flex items-center gap-1 no-drag">
          <button className="icon-button-sm" onClick={reload} title="Refresh">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button className="icon-button-sm" title="Add Project" onClick={onAddProject}>
            <Plus size={14} />
          </button>
          <button className="icon-button-sm" onClick={onOpenSettings} title="Settings">
            <Settings size={14} />
          </button>
        </div>
      </div>

      {/* Search Bar */}
      {searchActive && (
        <div className="search-bar">
          <Search size={12} className="search-bar-icon" />
          <input
            ref={searchInputRef}
            type="text"
            className="search-bar-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Type to search..."
            autoFocus
          />
          <button
            className="search-bar-clear"
            onClick={() => {
              setSearchQuery('');
              setSearchActive(false);
            }}
            title="Clear search (Esc)"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* Content */}
      <ScrollArea className="flex-1" ref={scrollAreaRef}>
        <div className="pl-2 pr-3 pt-1 pb-2 space-y-0">
          {projects.length === 0 && !loading && (
            <div className="empty-state">
              <div className="empty-state-icon">📁</div>
              <h3 className="empty-state-title">No projects yet</h3>
              <p className="empty-state-description">
                Add your first project to start managing worktrees
              </p>
              <button className="btn-secondary" onClick={onAddProject}>
                <Plus size={14} />
                <span>Add Project</span>
              </button>
            </div>
          )}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={projects.map((p) => p.repoPath)}
              strategy={verticalListSortingStrategy}
            >
              {projects.map((project) => (
                <SortableProjectCard
                  key={project.repoPath}
                  project={project}
                  expanded={expandedProjects.has(project.repoPath)}
                  onToggle={() => toggleProject(project.repoPath)}
                  onOpenProjectSettings={onOpenProjectSettings}
                  onOpenIde={handleOpenIde}
                  onOpenFinder={handleOpenFinder}
                  onOpenTerminal={handleOpenTerminal}
                  onCreateWorktree={() => onCreateWorktree(project)}
                  onEditWorktree={onEditWorktree}
                  onEditComment={handleEditComment}
                  onDeleteWorktree={handleDeleteWorktree}
                  showDescription={hasAnyDescription}
                  showGitHub={hasAnyGitHub}
                  showJira={hasAnyJira}
                  showServers={hasAnyServers}
                  serversByPath={serversByPath}
                  jiraHost={jiraHost}
                  selectedPath={selectedPath}
                  searchQuery={searchQuery}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </ScrollArea>

      {/* IDE Confirmation Modal */}
      <IdeConfirmModal
        open={ideModalOpen}
        onOpenChange={setIdeModalOpen}
        data={ideModalData}
        dontAskAgain={dontAskAgain}
        onDontAskAgainChange={setDontAskAgain}
        onConfirm={handleIdeModalConfirm}
        onCancel={handleIdeModalCancel}
      />

      {/* Delete Worktree Modals (normal + force + error) */}
      <DeleteWorktreeModals
        data={deleteModalData}
        deleteBranchToo={deleteBranchToo}
        onDeleteBranchTooChange={setDeleteBranchToo}
        deleteModalOpen={deleteModalOpen}
        onDeleteModalOpenChange={setDeleteModalOpen}
        deleting={deleting}
        onConfirmDelete={() => executeDeleteWorktree(false)}
        onCancelDelete={() => setDeleteModalData(null)}
        forceDeleteModalOpen={forceDeleteModalOpen}
        onForceDeleteModalOpenChange={setForceDeleteModalOpen}
        forceDeleteError={forceDeleteError}
        forceDeleting={forceDeleting}
        onConfirmForceDelete={() => executeDeleteWorktree(true)}
        onCancelForceDelete={() => {
          setForceDeleteModalOpen(false);
          setDeleteModalData(null);
          setDeleteBranchToo(false);
        }}
        errorModalOpen={errorModalOpen}
        onErrorModalOpenChange={setErrorModalOpen}
        errorModalMessage={errorModalMessage}
      />

      {/* Worktree comment/note modal */}
      <CommentModal
        open={commentModalOpen}
        onOpenChange={setCommentModalOpen}
        data={
          commentTarget
            ? {
                path: commentTarget.worktree.path,
                branch: commentTarget.worktree.branch,
                initialComment: commentTarget.worktree.comment ?? '',
              }
            : null
        }
        saving={savingComment}
        onSave={handleSaveComment}
        onCancel={handleCancelComment}
      />
    </div>
  );
}

