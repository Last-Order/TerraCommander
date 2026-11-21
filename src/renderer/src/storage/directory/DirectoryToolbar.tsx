import type { ReactNode, RefObject } from 'react';
import { ActionIcon, Menu } from '@mantine/core';
import { FileUp, FolderPlus, FolderUp, Plus, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCurrentDirectory } from './current-directory-context';
import classes from './DirectoryListing.module.css';

interface DirectoryToolbarProps {
  createDirectoryDisabled: boolean;
  uploadDisabled: boolean;
  refreshDisabled: boolean;
  refreshButton: RefObject<HTMLButtonElement | null>;
  onCreateDirectory: () => void;
  onUploadFile: () => void;
  onUploadFolder: () => void;
  onRefresh: () => void;
  children: ReactNode;
}

export function DirectoryToolbar({
  createDirectoryDisabled,
  uploadDisabled,
  refreshDisabled,
  refreshButton,
  onCreateDirectory,
  onUploadFile,
  onUploadFolder,
  onRefresh,
  children,
}: DirectoryToolbarProps) {
  const { t } = useTranslation('storage');
  const { canCreateDirectory, canUpload } = useCurrentDirectory();
  const canAdd = canCreateDirectory || canUpload;

  return (
    <header className={classes.directoryHeader}>
      {children}
      <div className={classes.directoryActions}>
        {canAdd && (
          <AddButton
            createDirectoryDisabled={createDirectoryDisabled}
            uploadDisabled={uploadDisabled}
            onCreateDirectory={onCreateDirectory}
            onUploadFile={onUploadFile}
            onUploadFolder={onUploadFolder}
          />
        )}
        <ActionIcon
          ref={refreshButton}
          variant="subtle"
          color="gray"
          aria-label={t('refreshDirectory')}
          aria-keyshortcuts="F5"
          title={`${t('refreshDirectory')} (F5)`}
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
        </ActionIcon>
      </div>
    </header>
  );
}

interface AddButtonProps {
  createDirectoryDisabled: boolean;
  uploadDisabled: boolean;
  onCreateDirectory: () => void;
  onUploadFile: () => void;
  onUploadFolder: () => void;
}

function AddButton({
  createDirectoryDisabled,
  uploadDisabled,
  onCreateDirectory,
  onUploadFile,
  onUploadFolder,
}: AddButtonProps) {
  const { t } = useTranslation('storage');
  const { canCreateDirectory, canUpload, canUploadFolder } = useCurrentDirectory();
  const disabled =
    (!canCreateDirectory || createDirectoryDisabled) && (!canUpload || uploadDisabled);

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          type="button"
          variant="subtle"
          color="gray"
          aria-label={t('addEntry')}
          title={t('addEntry')}
          disabled={disabled}
        >
          <Plus size={16} strokeWidth={1.5} aria-hidden="true" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {canCreateDirectory && (
          <Menu.Item
            disabled={createDirectoryDisabled}
            aria-keyshortcuts="Control+Shift+N"
            leftSection={<FolderPlus size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={onCreateDirectory}
          >
            {t('newFolder')}
          </Menu.Item>
        )}
        {canCreateDirectory && canUpload && <Menu.Divider />}
        {canUpload && (
          <Menu.Item
            disabled={uploadDisabled}
            leftSection={<FileUp size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={onUploadFile}
          >
            {t('uploadFile')}
          </Menu.Item>
        )}
        {canUpload && canUploadFolder && (
          <Menu.Item
            disabled={uploadDisabled}
            leftSection={<FolderUp size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={onUploadFolder}
          >
            {t('uploadFolder')}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
