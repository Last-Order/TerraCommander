import { useEffect, useRef, useState } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Entry, EntryRef } from '../../../../../shared/storage';
import { DownloadDirectoryInput } from '../../../downloads/DownloadDirectoryInput';
import { errorKey, resultOf, type StorageErrorKey } from '../../storage-client';
import { useStorageTaskQueue } from '../../tasks/storage-task-queue-context';
import { DownloadOverwriteModal } from './DownloadOverwriteModal';

interface PendingOverwriteConfirmation {
  confirmationId: string;
  conflicts?: readonly string[] | undefined;
}

export function EntryDownloadModal({
  entries,
  parent,
  directoryPath,
  onClose,
  onAuthRequired,
}: {
  entries: readonly Entry[];
  parent: EntryRef;
  directoryPath: string;
  onClose: () => void;
  onAuthRequired: () => void;
}) {
  const { t } = useTranslation(['storage', 'common', 'errors']);
  const queue = useStorageTaskQueue();
  const [directory, setDirectory] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StorageErrorKey>();
  const [pendingConflict, setPendingConflict] = useState<PendingOverwriteConfirmation | null>(null);
  const pendingConfirmationId = useRef<string | null>(null);
  const active = useRef(true);
  const submitting = useRef(false);
  const directoryEdited = useRef(false);

  useEffect(() => {
    let cancelled = false;
    active.current = true;
    void (async () => {
      try {
        const settings = await resultOf(window.desktop.downloads.getSettings());
        if (!cancelled) {
          if (!directoryEdited.current) setDirectory(settings.directory);
          setReady(true);
        }
      } catch (error) {
        if (!cancelled && !directoryEdited.current) setError(errorKey(error));
      }
    })();
    return () => {
      cancelled = true;
      active.current = false;
      const confirmationId = pendingConfirmationId.current;
      pendingConfirmationId.current = null;
      if (confirmationId) {
        void queue.cancelDownloadConfirmation(confirmationId).catch(() => {
          console.error('Download preparation release failed.');
        });
      }
    };
  }, [queue]);

  async function submit() {
    if (submitting.current || !directory) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const response = await queue.prepareDownload({ parent, entries, directory, directoryPath });
      if (!active.current) {
        if (response.status === 'conflict') {
          void queue.cancelDownloadConfirmation(response.confirmationId).catch(() => {
            console.error('Download preparation release failed.');
          });
        }
        return;
      }
      if (response.status === 'conflict') {
        pendingConfirmationId.current = response.confirmationId;
        setPendingConflict({
          confirmationId: response.confirmationId,
          conflicts: response.conflicts,
        });
        return;
      }
      onClose();
    } catch (error) {
      if (!active.current) return;
      const code = errorKey(error);
      setPendingConflict(null);
      setError(code);
      if (code === 'AuthRequired') onAuthRequired();
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function confirmOverwrite() {
    if (submitting.current || !pendingConflict) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    const confirmationId = pendingConflict.confirmationId;
    pendingConfirmationId.current = null;
    try {
      await queue.confirmDownload(confirmationId);
      if (active.current) onClose();
    } catch (error) {
      if (!active.current) return;
      const code = errorKey(error);
      setPendingConflict(null);
      setError(code);
      if (code === 'AuthRequired') onAuthRequired();
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function cancelOverwrite() {
    const confirmationId = pendingConfirmationId.current;
    pendingConfirmationId.current = null;
    setPendingConflict(null);
    if (!confirmationId) return;
    setBusy(true);
    try {
      await queue.cancelDownloadConfirmation(confirmationId);
    } catch (error) {
      if (active.current) setError(errorKey(error));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  const singleFile = entries.length === 1 && entries[0]?.kind === 'file';
  const blocked = busy || pendingConflict !== null;
  return (
    <>
      <Modal
        opened
        centered
        title={t('downloadEntry')}
        onClose={() => {
          if (!blocked) onClose();
        }}
        closeOnClickOutside={!blocked}
        closeOnEscape={!blocked}
        trapFocus={pendingConflict === null}
        returnFocus={pendingConflict === null}
        inert={pendingConflict !== null}
        closeButtonProps={{ disabled: blocked, 'aria-label': t('common:close') }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Stack>
            {!singleFile && (
              <Text size="sm">
                {t('downloadSelection', {
                  files: entries.filter((selected) => selected.kind === 'file').length,
                  folders: entries.filter((selected) => selected.kind === 'directory').length,
                })}
              </Text>
            )}
            <DownloadDirectoryInput
              label={t('downloadDirectory')}
              value={directory}
              disabled={blocked}
              error={
                error === 'InvalidDownloadDirectory'
                  ? t('errors:InvalidDownloadDirectory')
                  : undefined
              }
              onChange={(value) => {
                directoryEdited.current = true;
                setDirectory(value);
                setReady(true);
                setError(undefined);
              }}
            />
            {error && error !== 'InvalidDownloadDirectory' && (
              <Text size="sm" c="red" role="alert">
                {t(`errors:${error}`)}
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" disabled={blocked} onClick={onClose}>
                {t('common:cancel')}
              </Button>
              <Button type="submit" loading={busy} disabled={blocked || !ready || !directory}>
                {t('startDownload')}
              </Button>
            </Group>
          </Stack>
        </form>
      </Modal>
      {pendingConflict && (
        <DownloadOverwriteModal
          busy={busy}
          conflicts={pendingConflict.conflicts}
          onConfirm={() => {
            void confirmOverwrite();
          }}
          onCancel={() => {
            void cancelOverwrite();
          }}
        />
      )}
    </>
  );
}
