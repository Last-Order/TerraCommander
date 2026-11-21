import { useEffect, useRef, useState } from 'react';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';
import { useCurrentDirectory } from '../current-directory-context';

interface CreateDirectoryModalProps {
  onClose: () => void;
}

export function CreateDirectoryModal({ onClose }: CreateDirectoryModalProps) {
  const { t } = useTranslation(['storage', 'common']);
  const queue = useStorageTaskQueue();
  const { ref: parent, path: directoryPath } = useCurrentDirectory();
  const [name, setName] = useState('');
  const submitted = useRef(false);
  const active = useRef(true);
  const valid = name.trim().length > 0 && !name.includes('\0');

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const create = async () => {
    if (submitted.current || !valid) return;
    submitted.current = true;
    try {
      const admitted = await queue.enqueueCreateDirectory({ parent, name, directoryPath });
      if (!active.current) return;
      if (admitted) onClose();
      else submitted.current = false;
    } catch {
      submitted.current = false;
    }
  };

  return (
    <Modal
      opened
      centered
      title={t('newFolder')}
      onClose={onClose}
      closeButtonProps={{ 'aria-label': t('common:close') }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Stack>
          <TextInput
            data-autofocus
            label={t('folderName')}
            value={name}
            maxLength={32_768}
            error={!valid && name.length > 0 ? t('invalidEntryName') : undefined}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={!valid}>
              {t('common:create')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
