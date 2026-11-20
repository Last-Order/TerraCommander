import { useCallback, useState } from 'react';
import type { Entry } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import type { PendingEntryEffect } from '../tasks/pending-entry-effects';
import { canDeleteEntry } from './entry-deletion';
import type { EntrySelection } from './modals/EntryInformationModal';

interface UseDirectoryEntryActionsOptions {
  entries: ReadonlyMap<string, Entry>;
  selectedLocators: ReadonlySet<string>;
  pendingEntries: ReadonlyMap<string, PendingEntryEffect>;
  phase: string;
  selectForContextMenu: (locator: string) => void;
}

export function useDirectoryEntryActions({
  entries,
  selectedLocators,
  pendingEntries,
  phase,
  selectForContextMenu,
}: UseDirectoryEntryActionsOptions) {
  const [menuLocator, setMenuLocator] = useState<string | null>(null);
  const [informationEntries, setInformationEntries] = useState<EntrySelection | null>(null);
  const [renameEntry, setRenameEntry] = useState<Entry | null>(null);
  const [deleteEntries, setDeleteEntries] = useState<Entry[] | null>(null);
  const [downloadEntries, setDownloadEntries] = useState<Entry[] | null>(null);

  const menuEntry = menuLocator === null ? undefined : entries.get(menuLocator);
  if (phase === 'ready' && menuLocator !== null && !menuEntry) setMenuLocator(null);

  const [selectedLocator] = selectedLocators;
  const selectedEntry =
    selectedLocators.size === 1 && selectedLocator !== undefined
      ? entries.get(selectedLocator)
      : undefined;
  const renamableEntry =
    selectedEntry?.capabilities.rename?.support !== 'unsupported' ? selectedEntry : undefined;
  const renamePending =
    renamableEntry !== undefined && pendingEntries.get(renamableEntry.ref.locator)?.busy === true;
  const selectedEntries = [...selectedLocators].flatMap((locator) => {
    const entry = entries.get(locator);
    return entry ? [entry] : [];
  });
  const selectionBusy = selectedEntries.some(
    (entry) => pendingEntries.get(entry.ref.locator)?.busy === true,
  );
  const canDelete =
    selectedEntries.length > 0 && selectedEntries.every((entry) => canDeleteEntry(entry));
  const canDownload =
    selectedEntries.length > 0 &&
    selectedEntries.every(
      (entry) =>
        entry.ref.connectionId !== localConnectionId &&
        (entry.kind === 'file'
          ? entry.capabilities.read?.support !== 'unsupported'
          : entry.kind === 'directory' && entry.capabilities.list?.support !== 'unsupported'),
    );

  const closeMenu = useCallback(() => {
    setMenuLocator(null);
  }, []);

  const showEntryMenu = useCallback(
    ({ ref: { locator } }: Entry) => {
      selectForContextMenu(locator);
      setMenuLocator(locator);
    },
    [selectForContextMenu],
  );

  const showInformation = () => {
    if (!menuEntry) return;
    const selection: EntrySelection = [menuEntry];
    for (const locator of selectedLocators) {
      const entry = entries.get(locator);
      if (entry && entry !== menuEntry) selection.push(entry);
    }
    setInformationEntries(selection);
  };

  const showRename = () => {
    if (!renamableEntry || renamePending) return;
    setMenuLocator(null);
    setRenameEntry(renamableEntry);
  };

  const showDelete = () => {
    if (!canDelete || selectionBusy) return;
    setMenuLocator(null);
    setDeleteEntries(selectedEntries);
  };

  const showDownload = () => {
    if (!canDownload || selectionBusy) return;
    setMenuLocator(null);
    setDownloadEntries(selectedEntries);
  };

  return {
    menuOpened: menuEntry !== undefined,
    closeMenu,
    showEntryMenu,
    showInformation,
    showRename,
    showDelete,
    showDownload,
    canDownload,
    downloadPending: selectionBusy,
    canRename: renamableEntry !== undefined,
    renamePending,
    canDelete,
    deletePending: selectionBusy,
    renameEntry,
    closeRename: () => setRenameEntry(null),
    deleteEntries,
    closeDelete: () => setDeleteEntries(null),
    downloadEntries,
    closeDownload: () => setDownloadEntries(null),
    informationEntries,
    closeInformation: () => setInformationEntries(null),
  };
}
