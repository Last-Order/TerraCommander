import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import { CreateDirectoryModal } from './CreateDirectoryModal';
import { EntryDeleteModal } from './EntryDeleteModal';
import { EntryDownloadModal } from './EntryDownloadModal';
import { EntryInformationModal, type EntrySelection } from './EntryInformationModal';
import { EntryRenameModal } from './EntryRenameModal';
import { TransferOverwriteModal } from './TransferOverwriteModal';

export type DirectoryModal =
  | { kind: 'createDirectory' }
  | { kind: 'rename'; entry: Entry }
  | { kind: 'download'; entries: Entry[] }
  | { kind: 'delete'; entries: Entry[] }
  | { kind: 'information'; entries: EntrySelection };

export interface DirectoryTransferConflictModal {
  busy: boolean;
  conflicts?: readonly string[] | undefined;
  confirmLabel?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

export type DirectoryPasteConflictModal = DirectoryTransferConflictModal;

interface DirectoryEntryModalsProps {
  modal: DirectoryModal | null;
  transferConflict: DirectoryTransferConflictModal | null;
  onClose: () => void;
}

export function DirectoryEntryModals({
  modal,
  transferConflict,
  onClose,
}: DirectoryEntryModalsProps) {
  const { t } = useTranslation('storage');

  let entryModal = null;
  if (modal) {
    switch (modal.kind) {
      case 'createDirectory':
        entryModal = <CreateDirectoryModal onClose={onClose} />;
        break;
      case 'rename':
        entryModal = <EntryRenameModal entry={modal.entry} onClose={onClose} />;
        break;
      case 'download':
        entryModal = <EntryDownloadModal entries={modal.entries} onClose={onClose} />;
        break;
      case 'delete':
        entryModal = <EntryDeleteModal entries={modal.entries} onClose={onClose} />;
        break;
      case 'information':
        entryModal = <EntryInformationModal entries={modal.entries} onClose={onClose} />;
        break;
    }
  }

  return (
    <>
      {transferConflict && (
        <TransferOverwriteModal
          busy={transferConflict.busy}
          conflicts={transferConflict.conflicts}
          confirmLabel={transferConflict.confirmLabel ?? t('overwriteAndPaste')}
          onConfirm={transferConflict.onConfirm}
          onCancel={transferConflict.onCancel}
        />
      )}
      {entryModal}
    </>
  );
}
