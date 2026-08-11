import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { ProjectWithIntegrations } from '@/components/worktree/types';
import type { WorktreeSortMode } from '@/types';
import type { RunningServer } from '@/lib/api';
import { sortWorktrees } from '@/lib/worktree-sort';

interface UseWorktreeKeyboardNavOptions {
  projects: ProjectWithIntegrations[];
  expandedProjects: Set<string>;
  /** Must match the order rendered by ProjectCard so arrows follow the rows. */
  sortMode: WorktreeSortMode;
  serversByPath: Record<string, RunningServer[]>;
  /** True while any modal is open; keyboard navigation is suppressed. */
  modalOpen: boolean;
  /** Invoked when Enter opens the selected worktree in the IDE. */
  onOpenIde: (path: string, projectIde?: string) => void;
}

interface UseWorktreeKeyboardNavResult {
  selectedPath: string | null;
  searchQuery: string;
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
  searchActive: boolean;
  setSearchActive: React.Dispatch<React.SetStateAction<boolean>>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
}

/**
 * Keyboard navigation + search for the worktree list. Owns the selection and
 * search state, the visible-worktree memo (used for arrow navigation and
 * filtering), and the global keydown listener:
 *
 * - printable key starts search
 * - Cmd+F activates search
 * - Escape clears search
 * - arrows move the selection
 * - Enter opens the selected worktree
 */
export function useWorktreeKeyboardNav({
  projects,
  expandedProjects,
  sortMode,
  serversByPath,
  modalOpen,
  onOpenIde,
}: UseWorktreeKeyboardNavOptions): UseWorktreeKeyboardNavResult {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const onOpenIdeRef = useRef(onOpenIde);
  const selectionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep ref updated so the keyboard handler always calls the latest callback
  // without re-subscribing the global listener.
  onOpenIdeRef.current = onOpenIde;

  // Auto-clear selection after timeout (only when not in search mode)
  useEffect(() => {
    if (selectionTimeoutRef.current) {
      clearTimeout(selectionTimeoutRef.current);
    }

    if (selectedPath && !searchActive) {
      selectionTimeoutRef.current = setTimeout(() => {
        setSelectedPath(null);
      }, 3000);
    }

    return () => {
      if (selectionTimeoutRef.current) {
        clearTimeout(selectionTimeoutRef.current);
      }
    };
  }, [selectedPath, searchActive]);

  // Calculate visible worktrees for keyboard navigation
  const visibleWorktrees = useMemo(() => {
    const result: { path: string; projectIde?: string }[] = [];
    const query = searchQuery.toLowerCase();

    for (const project of projects) {
      if (!expandedProjects.has(project.repoPath)) continue;

      const sortedWorktrees = sortWorktrees(project.worktrees, sortMode, serversByPath);

      for (const worktree of sortedWorktrees) {
        // Filter by search query
        if (query) {
          const branchMatch = worktree.branch.toLowerCase().includes(query);
          const descMatch = worktree.description?.toLowerCase().includes(query);
          if (!branchMatch && !descMatch) continue;
        }
        result.push({ path: worktree.path, projectIde: project.ide });
      }
    }

    return result;
  }, [projects, expandedProjects, searchQuery, sortMode, serversByPath]);

  // Keyboard navigation handler
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Ignore if modal is open
    if (modalOpen) return;

    const target = e.target as HTMLElement;
    const isSearchInput = target === searchInputRef.current;
    const key = e.key;

    // Arrow navigation (works even when search input is focused)
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      e.preventDefault();
      if (visibleWorktrees.length === 0) return;

      const currentIndex = selectedPath
        ? visibleWorktrees.findIndex((w) => w.path === selectedPath)
        : -1;

      let nextIndex: number;
      if (key === 'ArrowDown') {
        nextIndex = currentIndex < visibleWorktrees.length - 1 ? currentIndex + 1 : 0;
      } else {
        nextIndex = currentIndex > 0 ? currentIndex - 1 : visibleWorktrees.length - 1;
      }

      setSelectedPath(visibleWorktrees[nextIndex].path);

      // Scroll into view
      setTimeout(() => {
        const escapedPath = globalThis.CSS.escape(visibleWorktrees[nextIndex].path);
        const selectedEl = document.querySelector(`[data-worktree-path="${escapedPath}"]`);
        selectedEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 0);
      return;
    }

    // Enter to open IDE
    if (key === 'Enter' && selectedPath) {
      e.preventDefault();
      const worktree = visibleWorktrees.find((w) => w.path === selectedPath);
      if (worktree) {
        onOpenIdeRef.current(worktree.path, worktree.projectIde);
      }
      return;
    }

    // Escape to clear search
    if (key === 'Escape') {
      if (searchActive || searchQuery) {
        e.preventDefault();
        setSearchQuery('');
        setSearchActive(false);
        searchInputRef.current?.blur();
      }
      return;
    }

    // Skip the rest if focused on other inputs
    if (!isSearchInput && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

    // Cmd+F to activate search
    if (key === 'f' && e.metaKey) {
      e.preventDefault();
      setSearchActive(true);
      setTimeout(() => searchInputRef.current?.focus(), 0);
      return;
    }

    // Printable characters to search (only when not in search input)
    if (!isSearchInput && key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      setSearchActive(true);
      setSearchQuery((prev) => prev + key);
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [visibleWorktrees, selectedPath, searchQuery, searchActive, modalOpen]);

  // Attach keyboard listener
  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Reset selection if it's no longer visible
  useEffect(() => {
    if (selectedPath && !visibleWorktrees.find((w) => w.path === selectedPath)) {
      setSelectedPath(visibleWorktrees[0]?.path || null);
    }
  }, [visibleWorktrees, selectedPath]);

  return {
    selectedPath,
    searchQuery,
    setSearchQuery,
    searchActive,
    setSearchActive,
    searchInputRef,
  };
}
