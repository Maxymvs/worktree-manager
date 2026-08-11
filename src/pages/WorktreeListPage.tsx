import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { flushSync, createPortal } from 'react-dom';
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
  ArrowUpDown,
  Check,
} from 'lucide-react';
import { message } from '@tauri-apps/plugin-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { getIDEInfo } from '@/lib/ide-config';
import * as api from '@/lib/api';
import type { WorktreeDeleteRisk } from '@/lib/api';
import type { Project, Worktree, IDEPreset, WorktreeSortMode } from '@/types';
import {
  WORKTREE_SORT_MODES,
  WORKTREE_SORT_LABELS,
  DEFAULT_WORKTREE_SORT,
  parseWorktreeSortMode,
} from '@/lib/worktree-sort';
import { SortableProjectCard } from '@/components/worktree/ProjectCard';
import type { WorktreeWithIntegrations } from '@/components/worktree/types';
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
  // Worktrees whose deletion is running in the background. The dialog closes as
  // soon as it's confirmed, so progress is reported inline on the row instead.
  const [deletingPaths, setDeletingPaths] = useState<Set<string>>(new Set());
  const [deleteModalData, setDeleteModalData] = useState<{
    worktree: WorktreeWithIntegrations;
    repoPath: string;
    // The project's default base branch, used to check whether the branch's
    // commits already landed there via a squash/rebase merge.
    baseBranch?: string;
  } | null>(null);
  const [deleteBranchToo, setDeleteBranchToo] = useState(false);
  const [stopProcesses, setStopProcesses] = useState(true);
  // Risk warning: only shown when a delete would discard real work.
  const [riskModalOpen, setRiskModalOpen] = useState(false);
  const [deleteRisk, setDeleteRisk] = useState<WorktreeDeleteRisk | null>(null);
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

  // ---- Worktree sort preference (global, persisted) ----
  const [sortMode, setSortMode] = useState<WorktreeSortMode>(DEFAULT_WORKTREE_SORT);
  const sortInitialized = useRef(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortMenuPos, setSortMenuPos] = useState<{ top: number; right: number }>({
    top: 0,
    right: 0,
  });
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);

  // Adopt the persisted preference once, when settings first arrive. Unknown
  // values (hand-edited settings.json) fall back to the default.
  useEffect(() => {
    if (!settings || sortInitialized.current) return;
    sortInitialized.current = true;
    setSortMode(parseWorktreeSortMode(settings.worktree_sort));
  }, [settings]);

  // Close the sort menu on outside click or Escape.
  useEffect(() => {
    if (!sortMenuOpen) return;

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        sortMenuRef.current && !sortMenuRef.current.contains(target) &&
        sortButtonRef.current && !sortButtonRef.current.contains(target)
      ) {
        setSortMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setSortMenuOpen(false);
        sortButtonRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [sortMenuOpen]);

  // Toggles the search bar, mirroring what ⌘F does. Closing also clears the
  // query so the list isn't left silently filtered by an invisible search.
  const handleSearchButtonClick = () => {
    if (searchActive) {
      setSearchQuery('');
      setSearchActive(false);
      return;
    }
    setSearchActive(true);
    // The input autofocuses on mount; this covers a re-focus if it's already
    // mounted but has lost focus.
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  const handleSortButtonClick = () => {
    if (!sortMenuOpen && sortButtonRef.current) {
      const rect = sortButtonRef.current.getBoundingClientRect();
      setSortMenuPos({
        top: rect.bottom + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setSortMenuOpen((open) => !open);
  };

  const handleSelectSort = async (mode: WorktreeSortMode) => {
    setSortMode(mode);
    setSortMenuOpen(false);
    try {
      await api.setWorktreeSort(mode);
    } catch (err) {
      // A failed persist must never break the list — the sort still applies.
      console.error('Failed to save worktree sort preference:', err);
    }
  };

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
    sortMode,
    serversByPath,
    modalOpen: ideModalOpen || deleteModalOpen || riskModalOpen || errorModalOpen || commentModalOpen,
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

  const handleDeleteWorktree = (
    worktree: WorktreeWithIntegrations,
    repoPath: string,
    baseBranch?: string
  ) => {
    setDeleteModalData({ worktree, repoPath, baseBranch });
    // For detached worktrees `branch` holds a SHA, not a real branch, so never
    // offer to delete it.
    setDeleteBranchToo(!worktree.isDetached);
    setStopProcesses(true);
    setDeleteRisk(null);
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

  // Confirm handler for the primary delete dialog. Checks whether the delete
  // would discard real work; if so it hands off to the risk-warning dialog,
  // otherwise it deletes straight away (the common, single-dialog path).
  const handleConfirmDelete = async () => {
    if (!deleteModalData) return;
    const { worktree, baseBranch } = deleteModalData;

    flushSync(() => setDeleting(true));
    try {
      const risk = await api.getWorktreeDeleteRisk(
        worktree.path,
        worktree.branch,
        deleteBranchToo && !worktree.isDetached,
        baseBranch
      );
      // `unpushed_commits` counts by SHA, so squash- and rebase-merged branches
      // always look unpushed. Two independent signals prove the work survives
      // the delete: the backend's content check, and a merged GitHub PR.
      const prMerged = worktree.prInfo?.merged === true;
      const commitsAtRisk =
        risk.unpushed_commits > 0 && !risk.branch_content_merged && !prMerged;
      // Uncommitted edits are always real, unmerged work — warn regardless.
      if (risk.has_uncommitted_changes || commitsAtRisk) {
        // Real work at stake — warn before deleting.
        setDeleting(false);
        setDeleteRisk(risk);
        setDeleteModalOpen(false);
        setRiskModalOpen(true);
        return;
      }
    } catch (err) {
      // If we can't assess risk, don't block — fall through and delete.
      console.warn('Failed to assess delete risk:', err);
    }
    await performDelete();
  };

  // Actually delete the worktree. Always uses git's `--force` (the backend
  // completes the removal and prunes stale metadata) so untracked files and a
  // just-stopped dev server can't leave it half-deleted.
  //
  // Stopping dev servers and `rm -rf`-ing a worktree takes seconds, so this
  // returns the user to the list immediately and reports progress inline on
  // the row instead of holding them in a modal. Everything the background work
  // needs is captured up front — `closeDeleteModals` resets the dialog state,
  // so reading it after the await would see cleared values.
  const performDelete = async () => {
    if (!deleteModalData) return;
    const { worktree, repoPath } = deleteModalData;
    // Detached worktrees have a SHA in `branch`, not a real branch — never ask
    // git to delete it. Matches the guard used for the risk check above.
    const alsoDeleteBranch = deleteBranchToo && !worktree.isDetached;
    const shouldStopProcesses =
      stopProcesses && (serversByPath[worktree.path]?.length ?? 0) > 0;

    closeDeleteModals();
    setDeletingPaths((prev) => new Set(prev).add(worktree.path));

    try {
      // Stop dev servers / watchers first when opted in — they're what keep
      // recreating files and cause "Directory not empty". A failure here must
      // not block the delete; fall through and let git try.
      if (shouldStopProcesses) {
        try {
          await api.stopWorktreeProcesses(worktree.path);
        } catch (stopErr) {
          console.warn('Failed to stop worktree processes:', stopErr);
        }
      }

      await api.removeWorktree(repoPath, worktree.path, true, alsoDeleteBranch, worktree.branch);
      reload();
    } catch (err) {
      console.error('Failed to delete worktree:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setErrorModalMessage(`Failed to delete worktree: ${errorMessage}`);
      setErrorModalOpen(true);
    } finally {
      // Drop the row out of the deleting state either way: on success `reload`
      // removes it entirely, on failure it returns to normal so it can be
      // retried.
      setDeletingPaths((prev) => {
        const next = new Set(prev);
        next.delete(worktree.path);
        return next;
      });
    }
  };

  const closeDeleteModals = () => {
    setDeleteModalOpen(false);
    setRiskModalOpen(false);
    setDeleteModalData(null);
    setDeleteBranchToo(false);
    setDeleteRisk(null);
    // The dialogs are the only consumer of this; clear it here so a dismissed
    // dialog never reopens still showing a spinner.
    setDeleting(false);
  };

  // Check if any worktree has data for optional columns
  const allWorktrees = projects.flatMap((p) => p.worktrees);
  const hasAnyDescription = allWorktrees.some((w) => w.description);
  // Only show integration columns if there's actual fetched data
  const hasAnyGitHub = hasGitHub && allWorktrees.some((w) => w.prInfo);
  const hasAnyJira = hasJira && allWorktrees.some((w) => w.jiraInfo || w.issueNumber);
  // The servers column also hosts the inline "Deleting…" badge, so it has to
  // render while a delete is in flight even if nothing is listening on a port.
  const hasAnyServers =
    deletingPaths.size > 0 ||
    allWorktrees.some((w) => (serversByPath[w.path]?.length ?? 0) > 0);

  return (
    <div className="h-full flex flex-col">
      {/* Titlebar drag area with actions */}
      <div data-tauri-drag-region className="titlebar">
        <div className="titlebar-spacer" />
        <span data-tauri-drag-region className="titlebar-title">
          Worktree Manager{import.meta.env.VITE_PREVIEW_WORKTREE && ` (${import.meta.env.VITE_PREVIEW_WORKTREE})`}
        </span>
        <div className="flex items-center gap-1 no-drag">
          <button
            className={`icon-button-sm${searchActive ? ' icon-button-sm-active' : ''}`}
            title="Search (⌘F)"
            aria-label="Search worktrees"
            aria-pressed={searchActive}
            onClick={handleSearchButtonClick}
          >
            <Search size={14} />
          </button>
          <button
            ref={sortButtonRef}
            className="icon-button-sm"
            title="Sort worktrees"
            aria-label="Sort worktrees"
            aria-haspopup="menu"
            aria-expanded={sortMenuOpen}
            onClick={handleSortButtonClick}
          >
            <ArrowUpDown size={14} />
          </button>
          {sortMenuOpen && createPortal(
            <div
              ref={sortMenuRef}
              className="sort-menu"
              role="menu"
              aria-label="Sort worktrees"
              style={{ top: sortMenuPos.top, right: sortMenuPos.right }}
            >
              {WORKTREE_SORT_MODES.map((mode) => (
                <button
                  key={mode}
                  role="menuitemradio"
                  aria-checked={sortMode === mode}
                  className={`sort-menu-item${
                    sortMode === mode ? ' sort-menu-item-active' : ''
                  }`}
                  onClick={() => handleSelectSort(mode)}
                >
                  <span className="sort-menu-check">
                    {sortMode === mode && <Check size={12} />}
                  </span>
                  <span>{WORKTREE_SORT_LABELS[mode]}</span>
                </button>
              ))}
            </div>,
            document.body
          )}
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
                  deletingPaths={deletingPaths}
                  jiraHost={jiraHost}
                  selectedPath={selectedPath}
                  searchQuery={searchQuery}
                  sortMode={sortMode}
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

      {/* Delete Worktree Modals (confirm + risk warning + error) */}
      <DeleteWorktreeModals
        data={deleteModalData}
        deleteBranchToo={deleteBranchToo}
        onDeleteBranchTooChange={setDeleteBranchToo}
        stopProcesses={stopProcesses}
        onStopProcessesChange={setStopProcesses}
        runningServers={
          deleteModalData ? (serversByPath[deleteModalData.worktree.path] ?? []) : []
        }
        deleteModalOpen={deleteModalOpen}
        onDeleteModalOpenChange={setDeleteModalOpen}
        deleting={deleting}
        onConfirmDelete={handleConfirmDelete}
        onCancelDelete={closeDeleteModals}
        riskModalOpen={riskModalOpen}
        onRiskModalOpenChange={setRiskModalOpen}
        deleteRisk={deleteRisk}
        // No `riskConfirming`: this flow closes the dialog on confirm and
        // reports progress inline on the row instead.
        onConfirmRiskDelete={() => performDelete()}
        onCancelRiskDelete={closeDeleteModals}
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

