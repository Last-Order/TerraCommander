import type { Entry } from '@shared/storage';
import { CreateDirectoryModal } from './CreateDirectoryModal';
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

interface DirectoryEntryModalsProps {
  modal: DirectoryModal | null;
  onClose: () => void;
}

export function DirectoryEntryModals({ modal, onClose }: DirectoryEntryModalsProps) {
  if (!modal) return null;
  switch (modal.kind) {
    case 'createDirectory':
      return <CreateDirectoryModal onClose={onClose} />;
    case 'rename':
      return <EntryRenameModal entry={modal.entry} onClose={onClose} />;
    case 'download':
      return <EntryDownloadModal entries={modal.entries} onClose={onClose} />;
    case 'delete':
      return <EntryDeleteModal entries={modal.entries} onClose={onClose} />;
    case 'information':
      return <EntryInformationModal entries={modal.entries} onClose={onClose} />;
  }
}
