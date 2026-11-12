import { useRef, useState } from 'react';
import { Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Entry, EntryRef } from '../../../../shared/storage';
import { useTaskQueue } from '../../tasks/task-queue-context';

interface EntryRenameProps {
  entry: Entry;
  parent: EntryRef;
  directoryPath: string;
  onClose: () => void;
}

export function EntryRenameModal({ entry, parent, directoryPath, onClose }: EntryRenameProps) {
  const { t } = useTranslation(['storage', 'common']);
  const queue = useTaskQueue();
  const [name, setName] = useState(entry.name);
  const submitted = useRef(false);
  const valid = name.trim().length > 0 && !name.includes('\0');

  const rename = () => {
    if (submitted.current || !valid || name === entry.name) return;
    if (!queue.enqueue({ type: 'rename', parent, entry, name, directoryPath })) return;
    submitted.current = true;
    onClose();
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
          rename();
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
