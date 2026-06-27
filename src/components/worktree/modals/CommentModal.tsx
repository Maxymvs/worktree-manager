import { useState, useEffect, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalTitle,
  ModalDescription,
  ModalBody,
  ModalFooter,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';

export interface CommentModalData {
  path: string;
  branch: string;
  initialComment: string;
}

interface CommentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: CommentModalData | null;
  saving: boolean;
  onSave: (comment: string) => void;
  onCancel: () => void;
}

export function CommentModal({
  open,
  onOpenChange,
  data,
  saving,
  onSave,
  onCancel,
}: CommentModalProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Sync the draft to the worktree's stored comment each time the modal opens
  // for a given worktree. Depend on primitives (not the `data` object) so the
  // parent re-rendering — e.g. the 4s dev-server poll — doesn't recreate `data`
  // and wipe what the user is typing.
  const dataPath = data?.path;
  const dataInitial = data?.initialComment;
  useEffect(() => {
    if (open && dataPath !== undefined) {
      setValue(dataInitial ?? '');
    }
  }, [open, dataPath, dataInitial]);

  const handleSave = () => onSave(value.trim());

  // Cmd/Ctrl+Enter saves, matching the platform convention for textareas.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent>
        {data && (
          <>
            <div className="modal-icon-container">
              <div className="modal-icon">
                <MessageSquare size={28} />
              </div>
            </div>
            <ModalHeader>
              <ModalTitle>Note for {data.branch}</ModalTitle>
            </ModalHeader>
            <ModalBody>
              <ModalDescription>
                Add a private note or reminder for this worktree. It's only shown
                here in Worktree Manager.
              </ModalDescription>
              <textarea
                ref={textareaRef}
                className="modal-textarea"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g. waiting on review, blocked by API change…"
                rows={4}
                autoFocus
              />
            </ModalBody>
            <ModalFooter>
              <Button variant="outline" size="sm" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </ModalFooter>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}
