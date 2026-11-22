import { useCallback, useState } from 'react';
import type { Entry } from '@shared/storage';
import { useStorageWorkspace } from '../storage-workspace-context';
import type { EntryCapabilities } from './entry-capabilities';
import type { DirectoryModal } from './modals/DirectoryEntryModals';
import type { EntrySelection } from './modals/EntryInformationModal';

interface UseDirectoryEntryModalsOptions {
  selectedEntries: readonly Entry[];
  capabilities: EntryCapabilities;
  menuEntry: Entry | undefined;
  onOpenModal: () => void;
}

export function useDirectoryEntryModals({
  selectedEntries,
  capabilities,
  menuEntry,
  onOpenModal,
}: UseDirectoryEntryModalsOptions) {
  const { directoryEffects } = useStorageWorkspace();
  const [modal, setModal] = useState<DirectoryModal | null>(null);

  const showCreateDirectory = useCallback(() => {
    onOpenModal();
    setModal({ kind: 'createDirectory' });
  }, [onOpenModal]);

  const showInformation = () => {
    if (!menuEntry) return;
    const selection: EntrySelection = [menuEntry];
    for (const entry of selectedEntries) {
      if (entry !== menuEntry) selection.push(entry);
    }
    setModal({ kind: 'information', entries: selection });
  };

  const showRename = () => {
    const entry = capabilities.canRename ? selectedEntries[0] : undefined;
    if (!entry || directoryEffects.isBusy(entry.ref)) return;
    onOpenModal();
    setModal({ kind: 'rename', entry });
  };

  const showDelete = () => {
    if (!capabilities.canDelete || directoryEffects.hasBusyEntries(selectedEntries)) return;
    onOpenModal();
    setModal({ kind: 'delete', entries: [...selectedEntries] });
  };

  const showDownload = () => {
    if (!capabilities.canDownload || directoryEffects.hasBusyEntries(selectedEntries)) return;
    onOpenModal();
    setModal({ kind: 'download', entries: [...selectedEntries] });
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
