import { Menu } from '@mantine/core';
import { ClipboardPaste, FolderPlus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCurrentDirectory } from './current-directory-context';

export interface DirectoryBlankActions {
  createDirectoryEnabled: boolean;
  canPaste: boolean;
  refreshDisabled: boolean;
  onCreateDirectory: () => void;
  onPaste: () => void;
  onRefresh: () => void;
}

export function DirectoryBlankMenuDropdown({ actions }: { actions: DirectoryBlankActions }) {
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
    <Menu.Dropdown>
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
      <Menu.Item
        disabled={!canPaste}
        aria-keyshortcuts="Control+V"
        leftSection={<ClipboardPaste size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={onPaste}
      >
        {t('pasteEntry')}
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item
        disabled={refreshDisabled}
        aria-keyshortcuts="F5"
        leftSection={<RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={onRefresh}
      >
        {t('refreshDirectory')}
      </Menu.Item>
    </Menu.Dropdown>
  );
}

interface DirectoryBlankMenuProps {
  position: { x: number; y: number } | null;
  actions: DirectoryBlankActions;
  onClose: () => void;
}

export function DirectoryBlankMenu({ position, actions, onClose }: DirectoryBlankMenuProps) {
  return (
    <Menu
      opened={position !== null}
      onChange={(opened) => {
        if (!opened) onClose();
      }}
      position="bottom-start"
      floatingStrategy="fixed"
      hideDetached={false}
      transitionProps={{ duration: 0 }}
    >
      <Menu.Target>
        <div
          style={{
            position: 'fixed',
            left: position?.x ?? 0,
            top: position?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </Menu.Target>
      <DirectoryBlankMenuDropdown actions={actions} />
    </Menu>
  );
}
