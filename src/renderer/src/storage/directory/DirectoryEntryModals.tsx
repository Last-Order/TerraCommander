import type { Entry, EntryRef } from '../../../../shared/storage';
import { EntryDeleteModal } from './EntryDeleteModal';
import { EntryDownloadModal } from './EntryDownloadModal';
import { EntryInformationModal, type EntrySelection } from './EntryInformationModal';
import { EntryRenameModal } from './EntryRenameModal';

interface DirectoryEntryModalsProps {
  parent: EntryRef;
  directoryPath: string;
  dateFormatter: Intl.DateTimeFormat;
  sizeFormatter: Intl.NumberFormat;
  onAuthRequired: () => void;
  renameEntry: Entry | null;
  onCloseRename: () => void;
  downloadEntries: Entry[] | null;
  onCloseDownload: () => void;
  deleteEntry: Entry | null;
  onCloseDelete: () => void;
  informationEntries: EntrySelection | null;
  onCloseInformation: () => void;
}

export function DirectoryEntryModals({
  parent,
  directoryPath,
  dateFormatter,
  sizeFormatter,
  onAuthRequired,
  renameEntry,
  onCloseRename,
  downloadEntries,
  onCloseDownload,
  deleteEntry,
  onCloseDelete,
  informationEntries,
  onCloseInformation,
}: DirectoryEntryModalsProps) {
  return (
    <>
      {renameEntry && (
        <EntryRenameModal
          entry={renameEntry}
          parent={parent}
          directoryPath={directoryPath}
          onClose={onCloseRename}
        />
      )}
      {downloadEntries && (
        <EntryDownloadModal
          entries={downloadEntries}
          parent={parent}
          directoryPath={directoryPath}
          onClose={onCloseDownload}
          onAuthRequired={onAuthRequired}
        />
      )}
      {deleteEntry && (
        <EntryDeleteModal
          entry={deleteEntry}
          parent={parent}
          directoryPath={directoryPath}
          onClose={onCloseDelete}
        />
      )}
      {informationEntries && (
        <EntryInformationModal
          entries={informationEntries}
          directoryPath={directoryPath}
          dateFormatter={dateFormatter}
          sizeFormatter={sizeFormatter}
          onAuthRequired={onAuthRequired}
          onClose={onCloseInformation}
        />
      )}
    </>
  );
}
