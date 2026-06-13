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
import { getIDEInfo } from '@/lib/ide-config';
import type { IDEPreset } from '@/types';

interface IdeModalData {
  path: string;
  preset: IDEPreset;
  customCommand?: string;
  folderName: string;
}

interface IdeConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: IdeModalData | null;
  dontAskAgain: boolean;
  onDontAskAgainChange: (value: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function IdeConfirmModal({
  open,
  onOpenChange,
  data,
  dontAskAgain,
  onDontAskAgainChange,
  onConfirm,
  onCancel,
}: IdeConfirmModalProps) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent>
        {data && (() => {
          const ideInfo = getIDEInfo(data.preset);
          return (
            <>
              <div className="modal-icon-container">
                <div className="modal-icon">
                  <img src={ideInfo.icon} alt={ideInfo.name} />
                </div>
              </div>
              <ModalHeader>
                <ModalTitle>Open in {ideInfo.name}</ModalTitle>
              </ModalHeader>
              <ModalBody>
                <ModalDescription>
                  Open "<span className="font-medium" style={{ color: 'hsl(var(--foreground))' }}>{data.folderName}</span>" in {ideInfo.name}?
                </ModalDescription>
                <div className="modal-checkbox-wrapper">
                  <input
                    type="checkbox"
                    id="dont-ask-again"
                    className="modal-checkbox"
                    checked={dontAskAgain}
                    onChange={(e) => onDontAskAgainChange(e.target.checked)}
                  />
                  <label htmlFor="dont-ask-again" className="modal-checkbox-label">
                    Don't ask again
                  </label>
                </div>
              </ModalBody>
              <ModalFooter>
                <Button variant="outline" size="sm" onClick={onCancel}>
                  Cancel
                </Button>
                <Button size="sm" onClick={onConfirm} autoFocus>
                  Open
                </Button>
              </ModalFooter>
            </>
          );
        })()}
      </ModalContent>
    </Modal>
  );
}
