import { useCallback, useState } from 'react';
import type { Entry } from '@shared/storage';
import type { EntryCapabilities } from './entry-capabilities';
import type { DirectoryModal } from './modals/DirectoryEntryModals';
import type { EntrySelection } from './modals/EntryInformationModal';

interface UseDirectoryEntryModalsOptions {
  entries: ReadonlyMap<string, Entry>;
  selectedLocators: ReadonlySet<string>;
  capabilities: EntryCapabilities;
  menuEntry: Entry | undefined;
  onOpenModal: () => void;
}

export function useDirectoryEntryModals({
  entries,
  selectedLocators,
  capabilities,
  menuEntry,
  onOpenModal,
}: UseDirectoryEntryModalsOptions) {
  const [modal, setModal] = useState<DirectoryModal | null>(null);

  const showCreateDirectory = useCallback(() => {
    onOpenModal();
    setModal({ kind: 'createDirectory' });
  }, [onOpenModal]);

  const showInformation = () => {
    if (!menuEntry) return;
    const selection: EntrySelection = [menuEntry];
    for (const locator of selectedLocators) {
      const entry = entries.get(locator);
      if (entry && entry !== menuEntry) selection.push(entry);
    }
    setModal({ kind: 'information', entries: selection });
  };

  const showRename = () => {
    if (!capabilities.renamableEntry || capabilities.renamePending) return;
    onOpenModal();
    setModal({ kind: 'rename', entry: capabilities.renamableEntry });
  };

  const showDelete = () => {
    if (!capabilities.canDelete || capabilities.selectionBusy) return;
    onOpenModal();
    setModal({ kind: 'delete', entries: capabilities.selectedEntries });
  };

  const showDownload = () => {
    if (!capabilities.canDownload || capabilities.selectionBusy) return;
    onOpenModal();
    setModal({ kind: 'download', entries: capabilities.selectedEntries });
  };

  const closeModal = useCallback(() => {
    setModal(null);
  }, []);

  return {
    modal,
    closeModal,
    showCreateDirectory,
    showInformation,
    showRename,
    showDelete,
    showDownload,
  };
}
