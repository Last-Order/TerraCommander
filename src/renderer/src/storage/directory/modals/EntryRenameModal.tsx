import { useEffect, useRef, useState } from 'react';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Entry, EntryRef } from '@shared/storage';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';

interface EntryRenameProps {
  entry: Entry;
  parent: EntryRef;
  directoryPath: string;
  onClose: () => void;
}

export function EntryRenameModal({ entry, parent, directoryPath, onClose }: EntryRenameProps) {
  const { t } = useTranslation(['storage', 'common']);
  const queue = useStorageTaskQueue();
  const [name, setName] = useState(entry.name);
  const submitted = useRef(false);
  const active = useRef(true);
  const valid = name.trim().length > 0 && !name.includes('\0');

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const rename = async () => {
    if (submitted.current || !valid || name === entry.name) return;
    submitted.current = true;
    try {
      const admitted = await queue.enqueueRename({ parent, entry, name, directoryPath });
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
      title={t('renameEntry')}
      onClose={onClose}
      closeButtonProps={{ 'aria-label': t('common:close') }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <Stack>
          <TextInput
            data-autofocus
            label={t('entryName')}
            value={name}
            maxLength={32_768}
            error={!valid && name.length > 0 ? t('invalidEntryName') : undefined}
            onChange={(event) => {
              setName(event.currentTarget.value);
            }}
            onFocus={(event) => {
              const extension = entry.kind === 'file' ? name.lastIndexOf('.') : -1;
              event.currentTarget.setSelectionRange(0, extension > 0 ? extension : name.length);
            }}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              {t('common:cancel')}
            </Button>
            <Button type="submit" disabled={!valid || name === entry.name}>
              {t('common:save')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
