import { useEffect, useRef } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';
import { useCurrentDirectory } from '../current-directory-context';
import classes from './EntryDeleteModal.module.css';

interface EntryDeleteProps {
  entries: readonly Entry[];
  onClose: () => void;
}

export function EntryDeleteModal({ entries, onClose }: EntryDeleteProps) {
  const { t } = useTranslation(['storage', 'common']);
  const queue = useStorageTaskQueue();
  const { ref: parent, path: directoryPath } = useCurrentDirectory();
  const submitted = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const deleteEntries = async () => {
    if (submitted.current || entries.length === 0) return;
    submitted.current = true;
    try {
      const admitted = await queue.enqueueDelete({ parent, entries, directoryPath });
      if (!active.current) return;
      if (admitted) onClose();
      else submitted.current = false;
    } catch {
      submitted.current = false;
    }
  };

  const confirmation =
    entries.length === 1
      ? t('deleteEntryConfirmation', { name: entries[0]!.name })
      : t('deleteEntriesConfirmation', { count: entries.length });

  return (
    <Modal
      opened
      centered
      title={t('deleteEntry')}
      onClose={onClose}
      closeButtonProps={{ 'aria-label': t('common:close') }}
    >
      <Stack>
        <Text className={classes.confirmation}>{confirmation}</Text>
        <Group justify="flex-end">
          <Button data-autofocus variant="default" onClick={onClose}>
            {t('common:cancel')}
          </Button>
          <Button
            color="red"
            onClick={() => {
              void deleteEntries();
            }}
          >
            {t('deleteEntry')}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
