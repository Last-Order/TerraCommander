import { Button, Group, TextInput } from '@mantine/core';
import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorKey, resultOf } from '../storage/storage-client';
import classes from './Downloads.module.css';

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
  const [failure, setFailure] = useState<string>();
  async function browse() {
    setChoosing(true);
    setFailure(undefined);
    try {
      const selected = await resultOf(window.desktop.downloads.chooseDirectory(value));
      if (selected !== null) (onDirectorySelected ?? onChange)(selected);
    } catch (error) {
      setFailure(t(`errors:${errorKey(error)}`));
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
        error={error ?? failure}
        onBlur={() => onBlur?.()}
        onChange={(event) => {
          setFailure(undefined);
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
