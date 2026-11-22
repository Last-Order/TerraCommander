import type { ReactNode, RefObject } from 'react';
import { ActionIcon, Menu } from '@mantine/core';
import { Ellipsis, FileUp, FolderPlus, FolderUp, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useCurrentDirectory } from './current-directory-context';
import {
  DirectoryBlankMenuDropdown,
  type DirectoryBlankMenuDropdownProps,
} from './DirectoryBlankMenu';
import classes from './DirectoryListing.module.css';

interface DirectoryToolbarProps {
  createDirectoryDisabled: boolean;
  uploadDisabled: boolean;
  canPaste: boolean;
  refreshDisabled: boolean;
  moreButton: RefObject<HTMLButtonElement | null>;
  onCreateDirectory: () => void;
  onUploadFile: () => void;
  onUploadFolder: () => void;
  onPaste: () => void;
  onRefresh: () => void;
  children: ReactNode;
}

export function DirectoryToolbar({
  createDirectoryDisabled,
  uploadDisabled,
  canPaste,
  refreshDisabled,
  moreButton,
  onCreateDirectory,
  onUploadFile,
  onUploadFolder,
  onPaste,
  onRefresh,
  children,
}: DirectoryToolbarProps) {
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
        <MoreButton
          buttonRef={moreButton}
          canCreateDirectory={canCreateDirectory}
          createDirectoryEnabled={!createDirectoryDisabled}
          canPaste={canPaste}
          refreshDisabled={refreshDisabled}
          onCreateDirectory={onCreateDirectory}
          onPaste={onPaste}
          onRefresh={onRefresh}
        />
      </div>
    </header>
  );
}

interface MoreButtonProps extends DirectoryBlankMenuDropdownProps {
  buttonRef: RefObject<HTMLButtonElement | null>;
}

function MoreButton({ buttonRef, ...dropdownProps }: MoreButtonProps) {
  const { t } = useTranslation('storage');
  const { canCreateDirectory, createDirectoryEnabled, canPaste, refreshDisabled } = dropdownProps;
  const disabled = (!canCreateDirectory || !createDirectoryEnabled) && !canPaste && refreshDisabled;

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon
          ref={buttonRef}
          type="button"
          variant="subtle"
          color="gray"
          aria-label={t('moreActions')}
          title={t('moreActions')}
          disabled={disabled}
        >
          <Ellipsis size={16} strokeWidth={1.5} aria-hidden="true" />
        </ActionIcon>
      </Menu.Target>
      <DirectoryBlankMenuDropdown {...dropdownProps} />
    </Menu>
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
