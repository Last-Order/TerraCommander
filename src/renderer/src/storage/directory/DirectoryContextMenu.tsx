import { Menu } from '@mantine/core';
import {
  ClipboardPaste,
  Copy,
  Download,
  FolderPlus,
  Info,
  RefreshCw,
  Scissors,
  SquarePen,
  Trash2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import { useCurrentDirectory } from './current-directory-context';
import type { EntryCapabilities } from './entry-capabilities';
import type { DirectoryContextMenuState } from './useDirectoryContextMenu';
import { useSelectionBusy } from './useDirectoryEffects';

export interface DirectoryBlankActions {
  createDirectoryEnabled: boolean;
  canPaste: boolean;
  refreshDisabled: boolean;
  onCreateDirectory: () => void;
  onPaste: () => void;
  onRefresh: () => void;
}

export interface DirectoryEntryActions {
  onCopy: () => void;
  onCut: () => void;
  onDownload: () => void;
  onRename: () => void;
  onInformation: () => void;
  onDelete: () => void;
}

function DirectoryBlankMenuItems({ actions }: { actions: DirectoryBlankActions }) {
  const { t } = useTranslation('storage');
  const { canCreateDirectory } = useCurrentDirectory();
  const {
    createDirectoryEnabled,
    canPaste,
    refreshDisabled,
    onCreateDirectory,
    onPaste,
    onRefresh,
  } = actions;

  return (
    <>
      {canCreateDirectory && (
        <Menu.Item
          disabled={!createDirectoryEnabled}
          aria-keyshortcuts="Control+Shift+N"
          leftSection={<FolderPlus size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onCreateDirectory}
        >
          {t('newFolder')}
        </Menu.Item>
      )}
      {canPaste && (
        <Menu.Item
          aria-keyshortcuts="Control+V"
          leftSection={<ClipboardPaste size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onPaste}
        >
          {t('pasteEntry')}
        </Menu.Item>
      )}
      {(canCreateDirectory || canPaste) && <Menu.Divider />}
      <Menu.Item
        disabled={refreshDisabled}
        aria-keyshortcuts="F5"
        leftSection={<RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={onRefresh}
      >
        {t('refreshDirectory')}
      </Menu.Item>
    </>
  );
}

export function DirectoryBlankMenuDropdown({ actions }: { actions: DirectoryBlankActions }) {
  return (
    <Menu.Dropdown>
      <DirectoryBlankMenuItems actions={actions} />
    </Menu.Dropdown>
  );
}

interface DirectoryEntryMenuItemsProps {
  selectedEntries: readonly Entry[];
  capabilities: EntryCapabilities;
  actions: DirectoryEntryActions;
}

function DirectoryEntryMenuItems({
  selectedEntries,
  capabilities,
  actions,
}: DirectoryEntryMenuItemsProps) {
  const { t } = useTranslation('storage');
  const { canCopy, canCut, canDownload, canRename, canDelete } = capabilities;
  const { onCopy, onCut, onDownload, onRename, onInformation, onDelete } = actions;
  const selectionBusy = useSelectionBusy(selectedEntries, true);

  return (
    <>
      {canCopy && (
        <Menu.Item
          aria-keyshortcuts="Control+C"
          leftSection={<Copy size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onCopy}
        >
          {t('copyEntry')}
        </Menu.Item>
      )}
      {canCut && (
        <Menu.Item
          disabled={selectionBusy}
          aria-keyshortcuts="Control+X"
          leftSection={<Scissors size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onCut}
        >
          {t('cutEntry')}
        </Menu.Item>
      )}
      {canDownload && (
        <Menu.Item
          disabled={selectionBusy}
          leftSection={<Download size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onDownload}
        >
          {t('downloadEntry')}
        </Menu.Item>
      )}
      {canRename && (
        <Menu.Item
          disabled={selectionBusy}
          aria-keyshortcuts="F2"
          leftSection={<SquarePen size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onRename}
        >
          {t('renameEntry')}
        </Menu.Item>
      )}
      <Menu.Item
        leftSection={<Info size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={onInformation}
      >
        {t('entryInformation')}
      </Menu.Item>
      {canDelete && (
        <>
          <Menu.Divider />
          <Menu.Item
            color="red"
            disabled={selectionBusy}
            aria-keyshortcuts="Delete"
            leftSection={<Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={onDelete}
          >
            {t('deleteEntry')}
          </Menu.Item>
        </>
      )}
    </>
  );
}

interface DirectoryContextMenuProps {
  menu: DirectoryContextMenuState | null;
  selectedEntries: readonly Entry[];
  capabilities: EntryCapabilities;
  entryActions: DirectoryEntryActions;
  blankActions: DirectoryBlankActions;
  onClose: () => void;
}

export function DirectoryContextMenu({
  menu,
  selectedEntries,
  capabilities,
  entryActions,
  blankActions,
  onClose,
}: DirectoryContextMenuProps) {
  return (
    <Menu
      opened={menu !== null}
      onChange={(opened) => {
        if (!opened) onClose();
      }}
      position="bottom-start"
      floatingStrategy="fixed"
      hideDetached={false}
      preventPositionChangeWhenVisible={false}
      transitionProps={{ duration: 0 }}
    >
      <Menu.Target>
        <div
          key={menu ? `${menu.kind}:${menu.x}:${menu.y}` : 'closed'}
          style={{
            position: 'fixed',
            left: menu?.x ?? 0,
            top: menu?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </Menu.Target>
      <Menu.Dropdown>
        {menu?.kind === 'entry' && (
          <DirectoryEntryMenuItems
            selectedEntries={selectedEntries}
            capabilities={capabilities}
            actions={entryActions}
          />
        )}
        {menu?.kind === 'blank' && <DirectoryBlankMenuItems actions={blankActions} />}
      </Menu.Dropdown>
    </Menu>
  );
}
