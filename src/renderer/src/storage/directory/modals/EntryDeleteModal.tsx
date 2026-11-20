import { useEffect, useRef } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Entry, EntryRef } from '@shared/storage';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';
import classes from './EntryDeleteModal.module.css';

interface EntryDeleteProps {
  entry: Entry;
  parent: EntryRef;
  directoryPath: string;
  onClose: () => void;
}

export function EntryDeleteModal({ entry, parent, directoryPath, onClose }: EntryDeleteProps) {
  const { t } = useTranslation(['storage', 'common']);
  const queue = useStorageTaskQueue();
  const submitted = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const deleteEntry = async () => {
    if (submitted.current) return;
    submitted.current = true;
    try {
      const admitted = await queue.enqueueDelete({ parent, entry, directoryPath });
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
      title={t('deleteEntry')}
      onClose={onClose}
      closeButtonProps={{ 'aria-label': t('common:close') }}
    >
      <Stack>
        <Text className={classes.confirmation}>
          {t('deleteEntryConfirmation', { name: entry.name })}
        </Text>
        <Group justify="flex-end">
          <Button data-autofocus variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            color="red"
            onClick={() => {
              void deleteEntry();
            }}
          >
            {t('deleteEntry')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
