import { Button, Group, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorKey, resultOf } from '../storage/storage-client';
import classes from './Downloads.module.css';

const chooseDirectoryErrorNotification = 'choose-download-directory-error';

export function DownloadDirectoryInput({
  value,
  onChange,
  onDirectorySelected,
  onBlur,
  disabled,
  error,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  onDirectorySelected?: (value: string) => void;
  onBlur?: () => void;
  disabled?: boolean;
  error?: string | undefined;
  label: string;
}) {
  const { t } = useTranslation(['storage', 'errors']);
  const [choosing, setChoosing] = useState(false);
  async function browse() {
    setChoosing(true);
    try {
      const selected = await resultOf(window.desktop.downloads.chooseDirectory(value));
      if (selected !== null) (onDirectorySelected ?? onChange)(selected);
    } catch (failure) {
      notifications.show({
        id: chooseDirectoryErrorNotification,
        color: 'red',
        message: t(`errors:${errorKey(failure)}`),
      });
    } finally {
      setChoosing(false);
    }
  }
  return (
    <Group align="flex-start" wrap="nowrap" gap="xs">
      <TextInput
        className={classes.directory}
        label={label}
        value={value}
        disabled={disabled || choosing}
        maxLength={32_768}
        error={error}
        onBlur={() => onBlur?.()}
        onChange={(event) => {
          onChange(event.currentTarget.value);
        }}
      />
      <Button
        className={classes.browse}
        variant="default"
        disabled={disabled === true}
        loading={choosing}
        leftSection={<FolderOpen size={16} strokeWidth={1.5} aria-hidden="true" />}
        onClick={() => void browse()}
      >
        {t('browseDownloadDirectory')}
      </Button>
    </Group>
  );
}
