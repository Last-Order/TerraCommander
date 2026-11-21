import { Menu } from '@mantine/core';
import { Copy, Download, Info, Scissors, SquarePen, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface DirectoryEntryMenuProps {
  canCopy: boolean;
  canCut: boolean;
  cutPending: boolean;
  canDownload: boolean;
  downloadPending: boolean;
  canRename: boolean;
  renamePending: boolean;
  canDelete: boolean;
  deletePending: boolean;
  onCopy: () => void;
  onCut: () => void;
  onDownload: () => void;
  onRename: () => void;
  onInformation: () => void;
  onDelete: () => void;
}

export function DirectoryEntryMenu({
  canCopy,
  canCut,
  cutPending,
  canDownload,
  downloadPending,
  canRename,
  renamePending,
  canDelete,
  deletePending,
  onCopy,
  onCut,
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
      {canCut && (
        <Menu.Item
          disabled={cutPending}
          aria-keyshortcuts="Control+X"
          leftSection={<Scissors size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onCut}
        >
          {t('cutEntry')}
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
            aria-keyshortcuts="Delete"
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
