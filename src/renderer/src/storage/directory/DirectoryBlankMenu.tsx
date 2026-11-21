import { Menu } from '@mantine/core';
import { ClipboardPaste, FolderPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DirectoryBlankMenuProps {
  position: { x: number; y: number } | null;
  canCreateDirectory: boolean;
  createDirectoryEnabled: boolean;
  canPaste: boolean;
  onCreateDirectory: () => void;
  onPaste: () => void;
  onClose: () => void;
}

export function DirectoryBlankMenu({
  position,
  canCreateDirectory,
  createDirectoryEnabled,
  canPaste,
  onCreateDirectory,
  onPaste,
  onClose,
}: DirectoryBlankMenuProps) {
  const { t } = useTranslation('storage');
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
      </Menu.Dropdown>
    </Menu>
  );
}
