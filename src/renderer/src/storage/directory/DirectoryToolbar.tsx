import { ActionIcon, Menu } from '@mantine/core';
import { Ellipsis, FileUp, FolderPlus, FolderUp, Plus } from 'lucide-react';
import type { ReactNode, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DirectoryBlankMenuDropdown,
  type DirectoryBlankActions,
} from './actions/DirectoryContextMenu';
import type { DirectoryUpload } from './actions/useDirectoryUpload';
import { useCurrentDirectory } from './current-directory-context';
import classes from './DirectoryListing.module.css';

type DirectoryToolbarUpload = Pick<DirectoryUpload, 'disabled' | 'uploadFile' | 'uploadFolder'>;

interface DirectoryToolbarProps {
  actions: DirectoryBlankActions;
  upload: DirectoryToolbarUpload;
  moreButton: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}

export function DirectoryToolbar({ actions, upload, moreButton, children }: DirectoryToolbarProps) {
  const { canCreateDirectory, canUpload } = useCurrentDirectory();
  const canAdd = canCreateDirectory || canUpload;

  return (
    <header className={classes.directoryHeader}>
      {children}
      <div className={classes.directoryActions}>
        {canAdd && (
          <AddButton
            createDirectoryEnabled={actions.createDirectoryEnabled}
            upload={upload}
            onCreateDirectory={actions.onCreateDirectory}
          />
        )}
        <MoreButton buttonRef={moreButton} actions={actions} />
      </div>
    </header>
  );
}

interface MoreButtonProps {
  buttonRef: RefObject<HTMLButtonElement | null>;
  actions: DirectoryBlankActions;
}

function MoreButton({ buttonRef, actions }: MoreButtonProps) {
  const { t } = useTranslation('storage');
  const disabled = !actions.createDirectoryEnabled && !actions.canPaste && actions.refreshDisabled;

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
      <DirectoryBlankMenuDropdown actions={actions} />
    </Menu>
  );
}

interface AddButtonProps {
  createDirectoryEnabled: boolean;
  upload: DirectoryToolbarUpload;
  onCreateDirectory: () => void;
}

function AddButton({ createDirectoryEnabled, upload, onCreateDirectory }: AddButtonProps) {
  const { t } = useTranslation('storage');
  const { canCreateDirectory, canUpload, canUploadFolder } = useCurrentDirectory();
  const disabled = !createDirectoryEnabled && (!canUpload || upload.disabled);

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
            disabled={!createDirectoryEnabled}
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
            disabled={upload.disabled}
            leftSection={<FileUp size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => void upload.uploadFile()}
          >
            {t('uploadFile')}
          </Menu.Item>
        )}
        {canUpload && canUploadFolder && (
          <Menu.Item
            disabled={upload.disabled}
            leftSection={<FolderUp size={16} strokeWidth={1.5} aria-hidden="true" />}
            onClick={() => void upload.uploadFolder()}
          >
            {t('uploadFolder')}
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
