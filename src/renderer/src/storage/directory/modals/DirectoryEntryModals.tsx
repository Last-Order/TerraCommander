import type { Entry } from '@shared/storage';
import { CreateDirectoryModal } from './CreateDirectoryModal';
import { EntryDeleteModal } from './EntryDeleteModal';
import { EntryDownloadModal } from './EntryDownloadModal';
import { EntryInformationModal, type EntrySelection } from './EntryInformationModal';
import { EntryRenameModal } from './EntryRenameModal';

interface DirectoryEntryModalsProps {
  dateFormatter: Intl.DateTimeFormat;
  sizeFormatter: Intl.NumberFormat;
  onAuthRequired: () => void;
  createDirectoryOpened: boolean;
  onCloseCreateDirectory: () => void;
  renameEntry: Entry | null;
  onCloseRename: () => void;
  downloadEntries: Entry[] | null;
  onCloseDownload: () => void;
  deleteEntries: Entry[] | null;
  onCloseDelete: () => void;
  informationEntries: EntrySelection | null;
  onCloseInformation: () => void;
}

export function DirectoryEntryModals({
  dateFormatter,
  sizeFormatter,
  onAuthRequired,
  createDirectoryOpened,
  onCloseCreateDirectory,
  renameEntry,
  onCloseRename,
  downloadEntries,
  onCloseDownload,
  deleteEntries,
  onCloseDelete,
  informationEntries,
  onCloseInformation,
}: DirectoryEntryModalsProps) {
  return (
    <>
      {createDirectoryOpened && <CreateDirectoryModal onClose={onCloseCreateDirectory} />}
      {renameEntry && <EntryRenameModal entry={renameEntry} onClose={onCloseRename} />}
      {downloadEntries && (
        <EntryDownloadModal
          entries={downloadEntries}
          onClose={onCloseDownload}
          onAuthRequired={onAuthRequired}
        />
      )}
      {deleteEntries && <EntryDeleteModal entries={deleteEntries} onClose={onCloseDelete} />}
      {informationEntries && (
        <EntryInformationModal
          entries={informationEntries}
          dateFormatter={dateFormatter}
          sizeFormatter={sizeFormatter}
          onAuthRequired={onAuthRequired}
          onClose={onCloseInformation}
        />
      )}
    </>
  );
}
