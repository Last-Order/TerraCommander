import { Menu } from '@mantine/core';
import { Download, Info, SquarePen, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DirectoryEntryMenuProps {
  canDownload: boolean;
  downloadPending: boolean;
  canRename: boolean;
  renamePending: boolean;
  canDelete: boolean;
  deletePending: boolean;
  onDownload: () => void;
  onRename: () => void;
  onInformation: () => void;
  onDelete: () => void;
}

export function DirectoryEntryMenu({
  canDownload,
  downloadPending,
  canRename,
  renamePending,
  canDelete,
  deletePending,
  onDownload,
  onRename,
  onInformation,
  onDelete,
}: DirectoryEntryMenuProps) {
  const { t } = useTranslation('storage');
  return (
    <Menu.Dropdown>
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
