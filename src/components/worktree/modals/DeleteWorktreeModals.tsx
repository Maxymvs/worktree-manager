import { ConfirmModal } from '@/components/ui/confirm-modal';
import { AlertModal } from '@/components/ui/alert-modal';
import type { RunningServer, WorktreeDeleteRisk } from '@/lib/api';
import type { WorktreeWithIntegrations } from '@/components/worktree/types';

interface DeleteModalData {
  worktree: WorktreeWithIntegrations;
  repoPath: string;
}

interface DeleteWorktreeModalsProps {
  data: DeleteModalData | null;
  deleteBranchToo: boolean;
  onDeleteBranchTooChange: (value: boolean) => void;

  // "Stop running processes" option. `runningServers` are the dev servers
  // detected for this worktree (empty when none/unknown).
  stopProcesses: boolean;
  onStopProcessesChange: (value: boolean) => void;
  runningServers: RunningServer[];

  // Primary delete confirmation.
  deleteModalOpen: boolean;
  onDeleteModalOpenChange: (open: boolean) => void;
  deleting: boolean;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;

  // Risk warning — shown only when the delete would discard real work
  // (uncommitted tracked changes or unpushed commits).
  riskModalOpen: boolean;
  onRiskModalOpenChange: (open: boolean) => void;
  deleteRisk: WorktreeDeleteRisk | null;
  riskConfirming: boolean;
  onConfirmRiskDelete: () => void;
  onCancelRiskDelete: () => void;

  // Error
  errorModalOpen: boolean;
  onErrorModalOpenChange: (open: boolean) => void;
  errorModalMessage: string;
}

// Shared "Delete local branch" checkbox. Hidden for detached worktrees, where
// `branch` holds a SHA rather than a real branch.
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
      <span className="text-sm text-foreground">Delete local branch</span>
    </label>
  );
}

// "Stop running processes" checkbox. Stopping a worktree's dev server / file
// watcher before deleting avoids the "Directory not empty" failure they cause.
// Lists the detected servers so the user knows what gets stopped.
function StopProcessesCheckbox({
  stopProcesses,
  onStopProcessesChange,
  servers,
}: Pick<DeleteWorktreeModalsProps, 'stopProcesses' | 'onStopProcessesChange'> & {
  servers: RunningServer[];
}) {
  if (servers.length === 0) return null;
  return (
    <div className="mt-3">
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={stopProcesses}
          onChange={(e) => onStopProcessesChange(e.target.checked)}
          className="w-4 h-4 rounded border-input bg-background text-primary focus:ring-primary focus:ring-offset-0"
        />
        <span className="text-sm text-foreground">
          Stop {servers.length} running {servers.length === 1 ? 'dev server' : 'dev servers'}
        </span>
      </label>
      <ul className="mt-1.5 ml-6 space-y-0.5">
        {servers.map((s) => (
          <li key={`${s.pid}-${s.port}`} className="text-xs text-muted-foreground">
            {s.process_name} · port {s.port}
            <span className="opacity-60"> (pid {s.pid})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Informational note for the primary dialog: a merged PR means this branch's
// work already lives in the base branch, so the delete is safe even though its
// local commits look "unpushed" (a squash merge rewrote their SHAs). Shown here
// rather than in the risk dialog because the PR info is already in memory when
// the dialog opens, while the risk check only runs on confirm.
function PrMergedNote({ data }: Pick<DeleteWorktreeModalsProps, 'data'>) {
  const pr = data?.worktree.prInfo;
  if (!pr?.merged) return null;
  return (
    <p data-testid="pr-merged-note" className="mt-3 text-sm text-muted-foreground">
      PR #{pr.number} was merged — this branch&rsquo;s work is already in the base branch.
    </p>
  );
}

// Build the risk-warning body from what the delete would discard.
function riskDescription(data: DeleteModalData | null, risk: WorktreeDeleteRisk | null): string {
  const branch = data?.worktree.branch ?? 'this branch';
  const parts: string[] = [];
  if (risk?.has_uncommitted_changes) {
    parts.push('uncommitted changes');
  }
  if (risk && risk.unpushed_commits > 0) {
    const n = risk.unpushed_commits;
    parts.push(`${n} unpushed commit${n === 1 ? '' : 's'} on "${branch}"`);
  }
  const what = parts.length > 0 ? parts.join(' and ') : 'unsaved work';
  return `This worktree has ${what} that exist nowhere else.\n\nDeleting will permanently discard ${
    parts.length > 1 ? 'them' : 'it'
  }. This cannot be undone.`;
}

export function DeleteWorktreeModals({
  data,
  deleteBranchToo,
  onDeleteBranchTooChange,
  stopProcesses,
  onStopProcessesChange,
  runningServers,
  deleteModalOpen,
  onDeleteModalOpenChange,
  deleting,
  onConfirmDelete,
  onCancelDelete,
  riskModalOpen,
  onRiskModalOpenChange,
  deleteRisk,
  riskConfirming,
  onConfirmRiskDelete,
  onCancelRiskDelete,
  errorModalOpen,
  onErrorModalOpenChange,
  errorModalMessage,
}: DeleteWorktreeModalsProps) {
  return (
    <>
      {/* Primary delete confirmation. For a clean worktree this is the only
          dialog — confirming here starts the delete and closes immediately;
          the only thing it waits on is the check for work that would be lost,
          hence the "Checking..." label. */}
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
        loadingLabel="Checking..."
      >
        <PrMergedNote data={data} />
        <DeleteBranchCheckbox
          data={data}
          deleteBranchToo={deleteBranchToo}
          onDeleteBranchTooChange={onDeleteBranchTooChange}
        />
        {/* Stopping detected dev servers up front avoids the "Directory not
            empty" failure they'd otherwise cause. */}
        <StopProcessesCheckbox
          stopProcesses={stopProcesses}
          onStopProcessesChange={onStopProcessesChange}
          servers={runningServers}
        />
      </ConfirmModal>

      {/* Risk warning — only shown when the delete would discard real work. */}
      <ConfirmModal
        open={riskModalOpen}
        onOpenChange={onRiskModalOpenChange}
        title="Delete worktree with unsaved work?"
        description={riskDescription(data, deleteRisk)}
        confirmLabel={deleteBranchToo ? 'Delete Anyway & Branch' : 'Delete Anyway'}
        variant="destructive"
        onConfirm={onConfirmRiskDelete}
        onCancel={onCancelRiskDelete}
        loading={riskConfirming}
        loadingLabel="Deleting..."
      >
        <DeleteBranchCheckbox
          data={data}
          deleteBranchToo={deleteBranchToo}
          onDeleteBranchTooChange={onDeleteBranchTooChange}
        />
        <StopProcessesCheckbox
          stopProcesses={stopProcesses}
          onStopProcessesChange={onStopProcessesChange}
          servers={runningServers}
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
