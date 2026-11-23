import { useEffect, type RefObject } from 'react';
import { notifications } from '@mantine/notifications';
import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import { useKeyboardShortcuts } from '@renderer/shortcuts/useKeyboardShortcuts';
import { useStorageWorkspace } from '../storage-workspace-context';
import { useCurrentDirectory } from './current-directory-context';
import type { DirectoryBlankActions } from './DirectoryContextMenu';
import type { EntryCapabilities } from './entry-capabilities';
import type { DirectoryListingPhase } from './useDirectoryListing';

const selectAllLoadingNotification = 'directory-select-all-loading';

interface DirectoryCommandMenu {
  opened: boolean;
  closeMenu: () => void;
}

interface DirectoryCommandModals {
  showCreateDirectory: () => void;
  showRename: () => void;
  showDelete: () => void;
}

interface DirectoryCommandClipboard {
  canPaste: boolean;
  isCutActive: boolean;
  copy: (entries: readonly Entry[]) => void;
  cut: (entries: readonly Entry[]) => void;
  paste: () => Promise<void>;
  clear: () => void;
}

interface DirectoryCommandSearch {
  opened: boolean;
  open: () => void;
  close: () => void;
}

interface DirectoryCommandsOptions {
  phase: DirectoryListingPhase;
  refresh: () => void;
  selectAll: () => void;
  selectedEntries: readonly Entry[];
  capabilities: EntryCapabilities;
  menu: DirectoryCommandMenu;
  modals: DirectoryCommandModals;
  clipboard: DirectoryCommandClipboard;
  search: DirectoryCommandSearch;
  moreButton: RefObject<HTMLButtonElement | null>;
  onNavigateUp?: (() => void) | undefined;
}

export function useDirectoryCommands({
  phase,
  refresh,
  selectAll,
  selectedEntries,
  capabilities,
  menu,
  modals,
  clipboard,
  search,
  moreButton,
  onNavigateUp,
}: DirectoryCommandsOptions) {
  const { t } = useTranslation('storage');
  const { directoryEffects } = useStorageWorkspace();
  const { canCreateDirectory } = useCurrentDirectory();
  const loading = phase === 'loading' || phase === 'refreshing';
  const hasError = phase === 'error';

  const runAfterClosingMenu = (action: () => void) => () => {
    menu.closeMenu();
    action();
  };

  const reload = runAfterClosingMenu(refresh);
  const openSearch = runAfterClosingMenu(search.open);

  const closeSearch = () => {
    search.close();
    moreButton.current?.focus();
  };

  const selectAllEntries = () => {
    if (phase === 'ready') {
      menu.closeMenu();
      selectAll();
    } else if (loading) {
      notifications.show({
        id: selectAllLoadingNotification,
        color: 'yellow',
        message: t('selectAllWhileLoading'),
      });
    }
  };

  useEffect(() => {
    if (phase === 'ready') notifications.hide(selectAllLoadingNotification);
  }, [phase]);

  const createDirectoryEnabled = canCreateDirectory && !loading && !hasError;
  const openCreateDirectory = () => {
    if (!createDirectoryEnabled) return;
    modals.showCreateDirectory();
  };

  const copySelection = () => {
    if (!capabilities.canCopy) return;
    menu.closeMenu();
    clipboard.copy(selectedEntries);
  };

  const cutSelection = () => {
    if (!capabilities.canCut || directoryEffects.hasBusyEntries(selectedEntries)) return;
    menu.closeMenu();
    clipboard.cut(selectedEntries);
  };

  const pasteSelection = runAfterClosingMenu(() => {
    void clipboard.paste();
  });

  const navigateUp = () => {
    if (!onNavigateUp) return;
    menu.closeMenu();
    onNavigateUp();
  };
  const canNavigateUp = onNavigateUp !== undefined && !menu.opened;

  useKeyboardShortcuts([
    {
      key: 'Backspace',
      onTrigger: navigateUp,
      enabled: canNavigateUp,
    },
    {
      key: 'ArrowUp',
      altKey: true,
      onTrigger: navigateUp,
      enabled: canNavigateUp,
    },
    {
      key: 'n',
      ctrlKey: true,
      shiftKey: true,
      onTrigger: openCreateDirectory,
      enabled: createDirectoryEnabled,
    },
    {
      key: 'c',
      ctrlKey: true,
      onTrigger: copySelection,
      enabled: capabilities.canCopy,
    },
    {
      key: 'x',
      ctrlKey: true,
      onTrigger: cutSelection,
      enabled: capabilities.canCut,
    },
    {
      key: 'v',
      ctrlKey: true,
      onTrigger: pasteSelection,
      enabled: clipboard.canPaste,
    },
    {
      key: 'F2',
      onTrigger: modals.showRename,
      enabled: capabilities.canRename,
    },
    {
      key: 'Delete',
      onTrigger: modals.showDelete,
      enabled: capabilities.canDelete,
    },
    { key: 'F5', onTrigger: reload, enabled: !loading, allowInEditable: true },
    { key: 'f', ctrlKey: true, onTrigger: openSearch, allowInEditable: true },
    { key: 'a', ctrlKey: true, onTrigger: selectAllEntries, enabled: phase !== 'error' },
    ...(search.opened ? [{ key: 'Escape', onTrigger: closeSearch, allowInEditable: true }] : []),
    ...(!search.opened && clipboard.isCutActive
      ? [{ key: 'Escape', onTrigger: clipboard.clear }]
      : []),
  ]);

  const blankActions: DirectoryBlankActions = {
    createDirectoryEnabled,
    canPaste: clipboard.canPaste,
    refreshDisabled: loading,
    onCreateDirectory: openCreateDirectory,
    onPaste: pasteSelection,
    onRefresh: reload,
  };

  return {
    blankActions,
    reload,
    closeSearch,
    copySelection,
    cutSelection,
  };
}
