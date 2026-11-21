import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import { CreateDirectoryModal } from './CreateDirectoryModal';
import { DownloadOverwriteModal } from './DownloadOverwriteModal';
import { EntryDeleteModal } from './EntryDeleteModal';
import { EntryDownloadModal } from './EntryDownloadModal';
import { EntryInformationModal, type EntrySelection } from './EntryInformationModal';
import { EntryRenameModal } from './EntryRenameModal';

export type DirectoryModal =
  | { kind: 'createDirectory' }
  | { kind: 'rename'; entry: Entry }
  | { kind: 'download'; entries: Entry[] }
  | { kind: 'delete'; entries: Entry[] }
  | { kind: 'information'; entries: EntrySelection };

export interface DirectoryPasteConflictModal {
  busy: boolean;
  conflicts?: readonly string[] | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}

interface DirectoryEntryModalsProps {
  modal: DirectoryModal | null;
  pasteConflict?: DirectoryPasteConflictModal | null | undefined;
  onClose: () => void;
}

export function DirectoryEntryModals({ modal, pasteConflict, onClose }: DirectoryEntryModalsProps) {
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
      {pasteConflict && (
        <DownloadOverwriteModal
          busy={pasteConflict.busy}
          conflicts={pasteConflict.conflicts}
          confirmLabel={t('overwriteAndPaste')}
          onConfirm={pasteConflict.onConfirm}
          onCancel={pasteConflict.onCancel}
        />
      )}
      {entryModal}
    </>
  );
}
