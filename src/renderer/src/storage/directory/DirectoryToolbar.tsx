import type { ReactNode, RefObject } from 'react';
import { ActionIcon, Menu } from '@mantine/core';
import { FileUp, FolderUp, RefreshCw, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import classes from './DirectoryListing.module.css';

interface DirectoryToolbarProps {
  canUpload: boolean;
  canUploadFolder: boolean;
  uploadDisabled: boolean;
  refreshDisabled: boolean;
  refreshButton: RefObject<HTMLButtonElement | null>;
  onUploadFile: () => void;
  onUploadFolder: () => void;
  onRefresh: () => void;
  children: ReactNode;
}

export function DirectoryToolbar({
  canUpload,
  canUploadFolder,
  uploadDisabled,
  refreshDisabled,
  refreshButton,
  onUploadFile,
  onUploadFolder,
  onRefresh,
  children,
}: DirectoryToolbarProps) {
  const { t } = useTranslation('storage');

  return (
    <header className={classes.directoryHeader}>
      {children}
      <div className={classes.directoryActions}>
        {canUpload && (
          <UploadButton
            canUploadFolder={canUploadFolder}
            disabled={uploadDisabled}
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

interface UploadButtonProps {
  canUploadFolder: boolean;
  disabled: boolean;
  onUploadFile: () => void;
  onUploadFolder: () => void;
}

function UploadButton({
  canUploadFolder,
  disabled,
  onUploadFile,
  onUploadFolder,
}: UploadButtonProps) {
  const { t } = useTranslation('storage');
  const button = (
    <ActionIcon
      type="button"
      variant="subtle"
      color="gray"
      aria-label={t('upload')}
      title={t('upload')}
      disabled={disabled}
      onClick={canUploadFolder ? undefined : onUploadFile}
    >
      <Upload size={16} strokeWidth={1.5} aria-hidden="true" />
    </ActionIcon>
  );
  if (!canUploadFolder) return button;

  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>{button}</Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          leftSection={<FileUp size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onUploadFile}
        >
          {t('uploadFile')}
        </Menu.Item>
        <Menu.Item
          leftSection={<FolderUp size={16} strokeWidth={1.5} aria-hidden="true" />}
          onClick={onUploadFolder}
        >
          {t('uploadFolder')}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}
