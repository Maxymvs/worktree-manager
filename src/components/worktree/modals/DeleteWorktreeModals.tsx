import { ConfirmModal } from '@/components/ui/confirm-modal';
import { AlertModal } from '@/components/ui/alert-modal';
import type { Worktree } from '@/types';

interface DeleteModalData {
  worktree: Worktree;
  repoPath: string;
}

interface DeleteWorktreeModalsProps {
  data: DeleteModalData | null;
  deleteBranchToo: boolean;
  onDeleteBranchTooChange: (value: boolean) => void;

  // Normal delete
  deleteModalOpen: boolean;
  onDeleteModalOpenChange: (open: boolean) => void;
  deleting: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;

  // Force delete
  forceDeleteModalOpen: boolean;
  onForceDeleteModalOpenChange: (open: boolean) => void;
  forceDeleteError: string;
  forceDeleting: boolean;
  onConfirmForceDelete: () => void;
  onCancelForceDelete: () => void;

  // Error
  errorModalOpen: boolean;
  onErrorModalOpenChange: (open: boolean) => void;
  errorModalMessage: string;
}

// Shared "Also delete local branch" checkbox. Hidden for detached worktrees,
// where `branch` holds a SHA rather than a real branch.
function DeleteBranchCheckbox({
  data,
  deleteBranchToo,
  onDeleteBranchTooChange,
}: Pick<DeleteWorktreeModalsProps, 'data' | 'deleteBranchToo' | 'onDeleteBranchTooChange'>) {
  if (data?.worktree.isDetached) return null;
  return (
    <label className="flex items-center gap-2 mt-4 cursor-pointer select-none">
      <input
        type="checkbox"
        checked={deleteBranchToo}
        onChange={(e) => onDeleteBranchTooChange(e.target.checked)}
        className="w-4 h-4 rounded border-input bg-background text-primary focus:ring-primary focus:ring-offset-0"
      />
      <span className="text-sm text-foreground">Also delete local branch</span>
    </label>
  );
}

export function DeleteWorktreeModals({
  data,
  deleteBranchToo,
  onDeleteBranchTooChange,
  deleteModalOpen,
  onDeleteModalOpenChange,
  deleting,
  onConfirmDelete,
  onCancelDelete,
  forceDeleteModalOpen,
  onForceDeleteModalOpenChange,
  forceDeleteError,
  forceDeleting,
  onConfirmForceDelete,
  onCancelForceDelete,
  errorModalOpen,
  onErrorModalOpenChange,
  errorModalMessage,
}: DeleteWorktreeModalsProps) {
  return (
    <>
      {/* Delete Worktree Confirmation Modal */}
      <ConfirmModal
        open={deleteModalOpen}
        onOpenChange={onDeleteModalOpenChange}
        title="Delete Worktree"
        description={data ? `Are you sure you want to delete the worktree "${data.worktree.branch}"?\n\nThis will remove the worktree directory and its contents.` : ''}
        confirmLabel={deleteBranchToo ? 'Delete Worktree & Branch' : 'Delete'}
        variant="destructive"
        onConfirm={onConfirmDelete}
        onCancel={onCancelDelete}
        loading={deleting}
        loadingLabel="Deleting..."
      >
        <DeleteBranchCheckbox
          data={data}
          deleteBranchToo={deleteBranchToo}
          onDeleteBranchTooChange={onDeleteBranchTooChange}
        />
      </ConfirmModal>

      {/* Force Delete Confirmation Modal */}
      <ConfirmModal
        open={forceDeleteModalOpen}
        onOpenChange={onForceDeleteModalOpenChange}
        title="Force Delete Worktree"
        description={`The worktree could not be deleted normally:\n\n${forceDeleteError}\n\nDo you want to force delete it? This cannot be undone.`}
        confirmLabel={deleteBranchToo ? 'Force Delete & Branch' : 'Force Delete'}
        variant="destructive"
        onConfirm={onConfirmForceDelete}
        onCancel={onCancelForceDelete}
        loading={forceDeleting}
        loadingLabel="Deleting..."
      >
        <DeleteBranchCheckbox
          data={data}
          deleteBranchToo={deleteBranchToo}
          onDeleteBranchTooChange={onDeleteBranchTooChange}
        />
      </ConfirmModal>

      {/* Error Alert Modal */}
      <AlertModal
        open={errorModalOpen}
        onOpenChange={onErrorModalOpenChange}
        title="Error"
        description={errorModalMessage}
        variant="error"
      />
    </>
  );
}
