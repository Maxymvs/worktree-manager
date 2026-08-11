import { useState, useEffect } from 'react';
import { flushSync } from 'react-dom';
import { Trash2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ConfirmModal } from '@/components/ui/confirm-modal';
import { AlertModal } from '@/components/ui/alert-modal';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import * as api from '@/lib/api';
import type { WorktreeDeleteRisk } from '@/lib/api';
import type { Worktree } from '@/types';

interface EditWorktreePageProps {
  worktree: Worktree;
  onBack: () => void;
  onSaved: () => void;
}

export function EditWorktreePage({ worktree, onBack, onSaved }: EditWorktreePageProps) {
  const [branchName, setBranchName] = useState(worktree.branch);
  const [issueNumber, setIssueNumber] = useState('');
  const [description, setDescription] = useState('');
  // Preserved as-is (edited via the row's comment modal, not this page).
  const [comment, setComment] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Delete modal state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteBranchToo, setDeleteBranchToo] = useState(false);
  const [stopProcesses, setStopProcesses] = useState(true);
  // Risk warning: only shown when a delete would discard real work.
  const [riskModalOpen, setRiskModalOpen] = useState(false);
  const [riskConfirming, setRiskConfirming] = useState(false);
  const [deleteRisk, setDeleteRisk] = useState<WorktreeDeleteRisk | null>(null);
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [errorModalMessage, setErrorModalMessage] = useState('');

  const originalBranch = worktree.branch;
  const repoPath = worktree.repoPath;

  useEffect(() => {
    loadMemo();
  }, [worktree.path]);

  const loadMemo = async () => {
    try {
      const memo = await api.getWorktreeMemo(worktree.path);
      setIssueNumber(memo.issue_number || '');
      setDescription(memo.description || '');
      setComment(memo.comment);
    } catch {
      // Ignore - use defaults
    }
  };

  const handleSave = async () => {
    // Force React to render loading state before starting operation
    flushSync(() => {
      setSaving(true);
      setError('');
    });

    try {
      // Rename branch if changed
      if (branchName.trim() !== originalBranch && repoPath) {
        await api.renameBranch(repoPath, originalBranch, branchName.trim());
      }

      // Save memo
      await api.setWorktreeMemo(worktree.path, {
        description: description.trim() || undefined,
        issue_number: issueNumber.trim() || undefined,
        comment,
      });

      onSaved();
      onBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl+Enter to save
  useKeyboardShortcut({ key: 'Enter', cmdOrCtrl: true }, handleSave, !saving && !!branchName.trim());

  const handleDelete = () => {
    if (!repoPath) return;
    setDeleteBranchToo(true);
    setDeleteRisk(null);
    setDeleteModalOpen(true);
  };

  // Confirm handler for the primary delete dialog: warn only if the delete
  // would discard real work, otherwise delete straight away.
  const handleConfirmDelete = async () => {
    if (!repoPath) return;

    flushSync(() => setDeleting(true));
    try {
      const risk = await api.getWorktreeDeleteRisk(
        worktree.path,
        worktree.branch,
        deleteBranchToo && !worktree.isDetached
      );
      // Commits that were squash-/rebase-merged only look unpushed (their SHAs
      // were rewritten); the backend's content check proves the work survives.
      if (
        risk.has_uncommitted_changes ||
        (risk.unpushed_commits > 0 && !risk.branch_content_merged)
      ) {
        setDeleting(false);
        setDeleteRisk(risk);
        setDeleteModalOpen(false);
        setRiskModalOpen(true);
        return;
      }
    } catch (err) {
      console.warn('Failed to assess delete risk:', err);
    }
    await performDelete(false);
  };

  // Always force-removes (the backend completes the removal and prunes stale
  // metadata) so untracked files / a just-stopped dev server can't leave the
  // worktree half-deleted. `fromRiskModal` only selects the loading state.
  const performDelete = async (fromRiskModal: boolean) => {
    if (!repoPath) return;

    flushSync(() => (fromRiskModal ? setRiskConfirming(true) : setDeleting(true)));

    try {
      // Stop dev servers / watchers first when requested — they're what keep
      // recreating files and cause "Directory not empty". A failure here must
      // not block the delete; fall through and let git try.
      if (stopProcesses) {
        try {
          await api.stopWorktreeProcesses(worktree.path);
        } catch (stopErr) {
          console.warn('Failed to stop worktree processes:', stopErr);
        }
      }

      await api.removeWorktree(repoPath, worktree.path, true, deleteBranchToo, worktree.branch);
      onSaved();
      onBack();
    } catch (err) {
      console.error('Failed to delete worktree:', err);
      const errorMessage = err instanceof Error ? err.message : String(err);
      setDeleteModalOpen(false);
      setRiskModalOpen(false);
      setErrorModalMessage(`Failed to delete worktree: ${errorMessage}`);
      setErrorModalOpen(true);
    } finally {
      setDeleting(false);
      setRiskConfirming(false);
    }
  };

  const isMainBranch = worktree.isMain;

  const riskDescription = (() => {
    const parts: string[] = [];
    if (deleteRisk?.has_uncommitted_changes) parts.push('uncommitted changes');
    if (deleteRisk && deleteRisk.unpushed_commits > 0) {
      const n = deleteRisk.unpushed_commits;
      parts.push(`${n} unpushed commit${n === 1 ? '' : 's'} on "${worktree.branch}"`);
    }
    const what = parts.length > 0 ? parts.join(' and ') : 'unsaved work';
    return `This worktree has ${what} that exist nowhere else.\n\nDeleting will permanently discard ${
      parts.length > 1 ? 'them' : 'it'
    }. This cannot be undone.`;
  })();

  return (
    <div className="h-full flex flex-col">
      {/* Header - drag area */}
      <div data-tauri-drag-region className="titlebar" />

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="page-wrapper">
          <div className="page-content">
            <h1 className="page-title">Edit Worktree</h1>

            <div className="settings-group mt-4">
              {/* Branch */}
              <div className="settings-item-full">
                <label className="settings-label">Branch</label>
                {isMainBranch ? (
                  <input
                    type="text"
                    className="settings-input settings-input-readonly font-mono"
                    value={branchName}
                    readOnly
                  />
                ) : (
                  <input
                    type="text"
                    className="settings-input font-mono"
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    placeholder="Branch name"
                  />
                )}
                {isMainBranch && (
                  <p className="settings-hint mt-1">Main branch cannot be renamed</p>
                )}
              </div>

              {/* Path (read-only) */}
              <div className="settings-item-full">
                <label className="settings-label">Directory</label>
                <input
                  type="text"
                  className="settings-input settings-input-readonly font-mono text-xs"
                  value={worktree.path}
                  readOnly
                />
              </div>

              {/* Issue Number */}
              <div className="settings-item-full">
                <label className="settings-label">Issue Number</label>
                <input
                  type="text"
                  className="settings-input font-mono"
                  value={issueNumber}
                  onChange={(e) => setIssueNumber(e.target.value)}
                  placeholder="e.g., PROJ-123"
                />
              </div>

              {/* Description */}
              <div className="settings-item-full">
                <label className="settings-label">Description</label>
                <input
                  type="text"
                  className="settings-input"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Brief description of this worktree"
                />
              </div>

              {error && <div className="text-xs text-red-500 mt-2">{error}</div>}
            </div>

            <div className="flex gap-2 mt-6">
              <button type="button" className="btn-secondary" onClick={onBack}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={handleSave}
                disabled={saving || (!branchName.trim())}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>

            {/* Danger Zone */}
            {!isMainBranch && (
              <div className="danger-zone mt-8">
                <h3 className="danger-zone-title">Danger Zone</h3>
                <div className="danger-zone-content">
                  <div className="danger-zone-item">
                    <div>
                      <div className="danger-zone-item-title">Delete Worktree</div>
                      <div className="danger-zone-item-desc">
                        Remove the worktree directory and its contents
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-danger"
                      onClick={handleDelete}
                    >
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </ScrollArea>

      {/* Delete Worktree Confirmation Modal */}
      <ConfirmModal
        open={deleteModalOpen}
        onOpenChange={setDeleteModalOpen}
        title="Delete Worktree"
        description={`Are you sure you want to delete the worktree "${worktree.branch}"?\n\nThis will remove the worktree directory and its contents.`}
        confirmLabel={deleteBranchToo ? 'Delete Worktree & Branch' : 'Delete'}
        variant="destructive"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteRisk(null)}
        loading={deleting}
        loadingLabel="Deleting..."
      >
        <label className="flex items-center gap-2 mt-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={deleteBranchToo}
            onChange={(e) => setDeleteBranchToo(e.target.checked)}
            className="w-4 h-4 rounded border-input bg-background text-primary focus:ring-primary focus:ring-offset-0"
          />
          <span className="text-sm text-foreground">Delete local branch</span>
        </label>
        <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={stopProcesses}
            onChange={(e) => setStopProcesses(e.target.checked)}
            className="w-4 h-4 rounded border-input bg-background text-primary focus:ring-primary focus:ring-offset-0"
          />
          <span className="text-sm text-foreground">Stop any processes running in this worktree</span>
        </label>
      </ConfirmModal>

      {/* Risk warning — only shown when the delete would discard real work. */}
      <ConfirmModal
        open={riskModalOpen}
        onOpenChange={setRiskModalOpen}
        title="Delete worktree with unsaved work?"
        description={riskDescription}
        confirmLabel={deleteBranchToo ? 'Delete Anyway & Branch' : 'Delete Anyway'}
        variant="destructive"
        onConfirm={() => performDelete(true)}
        onCancel={() => setDeleteRisk(null)}
        loading={riskConfirming}
        loadingLabel="Deleting..."
      >
        <label className="flex items-center gap-2 mt-4 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={deleteBranchToo}
            onChange={(e) => setDeleteBranchToo(e.target.checked)}
            className="w-4 h-4 rounded border-input bg-background text-primary focus:ring-primary focus:ring-offset-0"
          />
          <span className="text-sm text-foreground">Delete local branch</span>
        </label>
        <label className="flex items-center gap-2 mt-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={stopProcesses}
            onChange={(e) => setStopProcesses(e.target.checked)}
            className="w-4 h-4 rounded border-input bg-background text-primary focus:ring-primary focus:ring-offset-0"
          />
          <span className="text-sm text-foreground">Stop any processes running in this worktree</span>
        </label>
      </ConfirmModal>

      {/* Error Alert Modal */}
      <AlertModal
        open={errorModalOpen}
        onOpenChange={setErrorModalOpen}
        title="Error"
        description={errorModalMessage}
        variant="error"
      />
    </div>
  );
}
