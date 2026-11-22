import { Menu } from '@mantine/core';
import { Copy, Download, Info, Scissors, SquarePen, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import type { EntryCapabilities } from './entry-capabilities';
import { useSelectionBusy } from './useDirectoryEffects';

interface DirectoryEntryMenuProps {
  opened: boolean;
  selectedEntries: readonly Entry[];
  capabilities: EntryCapabilities;
  onCopy: () => void;
  onCut: () => void;
  onDownload: () => void;
  onRename: () => void;
  onInformation: () => void;
  onDelete: () => void;
}

export function DirectoryEntryMenu({
  opened,
  selectedEntries,
  capabilities,
  onCopy,
  onCut,
  onDownload,
  onRename,
  onInformation,
  onDelete,
}: DirectoryEntryMenuProps) {
  const { t } = useTranslation('storage');
  const { canCopy, canCut, canDownload, canRename, canDelete } = capabilities;
  const selectionBusy = useSelectionBusy(selectedEntries, opened);
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
    </Menu.Dropdown>
  );
}
