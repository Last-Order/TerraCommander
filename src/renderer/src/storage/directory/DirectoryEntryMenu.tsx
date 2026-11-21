import { Menu } from '@mantine/core';
import { Copy, Download, Info, SquarePen, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DirectoryEntryMenuProps {
  canCopy: boolean;
  canDownload: boolean;
  downloadPending: boolean;
  canRename: boolean;
  renamePending: boolean;
  canDelete: boolean;
  deletePending: boolean;
  onCopy: () => void;
  onDownload: () => void;
  onRename: () => void;
  onInformation: () => void;
  onDelete: () => void;
}

export function DirectoryEntryMenu({
  canCopy,
  canDownload,
  downloadPending,
  canRename,
  renamePending,
  canDelete,
  deletePending,
  onCopy,
  onDownload,
  onRename,
  onInformation,
  onDelete,
}: DirectoryEntryMenuProps) {
  const { t } = useTranslation('storage');
  return (
    <Menu.Dropdown>
      {canCopy && (
        <Menu.Item
          aria-keyshortcuts="Control+C"
          leftSection={<Copy size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onCopy}
        >
          {t('copyEntry')}
        </Menu.Item>
      )}
      {canDownload && (
        <Menu.Item
          disabled={downloadPending}
          leftSection={<Download size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onDownload}
        >
          {t('downloadEntry')}
        </Menu.Item>
      )}
      {canRename && (
        <Menu.Item
          disabled={renamePending}
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
            disabled={deletePending}
            leftSection={<Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={onDelete}
          >
            {t('deleteEntry')}
          </Menu.Item>
        </>
      )}
    </Menu.Dropdown>
  );
}
