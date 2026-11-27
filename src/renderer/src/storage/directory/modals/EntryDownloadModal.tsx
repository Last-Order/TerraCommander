import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadDirectoryInput } from '@renderer/downloads/DownloadDirectoryInput';
import { errorKey, resultOf, type StorageErrorKey } from '@renderer/storage/storage-client';
import { useStorageWorkspace } from '@renderer/storage/storage-workspace-context';
import { useStorageTaskQueue } from '@renderer/storage/tasks/storage-task-queue-context';
import type { Entry } from '@shared/storage';
import { useCurrentDirectory } from '../current-directory-context';
import { TransferOverwriteModal } from './TransferOverwriteModal';

const entryDownloadErrorNotification = 'entry-download-error';

interface PendingOverwriteConfirmation {
  confirmationId: string;
  conflicts?: readonly string[] | undefined;
}

export function EntryDownloadModal({
  entries,
  onClose,
}: {
  entries: readonly Entry[];
  onClose: () => void;
}) {
  const { t } = useTranslation(['storage', 'common', 'errors']);
  const { onAuthRequired } = useStorageWorkspace();
  const queue = useStorageTaskQueue();
  const { ref: parent, path: directoryPath } = useCurrentDirectory();
  const [directory, setDirectory] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [directoryInvalid, setDirectoryInvalid] = useState(false);
  const [pendingConflict, setPendingConflict] = useState<PendingOverwriteConfirmation | null>(null);
  const pendingConfirmationId = useRef<string | null>(null);
  const active = useRef(true);
  const submitting = useRef(false);
  const directoryEdited = useRef(false);

  function reportError(code: StorageErrorKey) {
    if (code === 'invalidDownloadDirectory') {
      setDirectoryInvalid(true);
    } else {
      notifications.show({
        id: entryDownloadErrorNotification,
        color: 'red',
        message: t(`errors:${code}`),
      });
    }
  }

  useEffect(() => {
    let cancelled = false;
    active.current = true;
    void (async () => {
      try {
        const directorySetting = await resultOf(window.desktop.settings.get('downloads.directory'));
        if (!cancelled) {
          if (!directoryEdited.current) setDirectory(directorySetting);
          setReady(true);
        }
      } catch (failure) {
        if (!cancelled && !directoryEdited.current) {
          const code = errorKey(failure);
          if (code === 'invalidDownloadDirectory') {
            setDirectoryInvalid(true);
          } else {
            notifications.show({
              id: entryDownloadErrorNotification,
              color: 'red',
              message: t(`errors:${code}`),
            });
          }
        }
      }
    })();
    return () => {
      cancelled = true;
      active.current = false;
      const confirmationId = pendingConfirmationId.current;
      pendingConfirmationId.current = null;
      if (confirmationId) {
        void queue.cancelTransferConfirmation(confirmationId).catch(() => {
          console.error('Download preparation release failed.');
        });
      }
    };
  }, [queue, t]);

  async function submit() {
    if (submitting.current || !directory) return;
    submitting.current = true;
    setBusy(true);
    setDirectoryInvalid(false);
    try {
      const response = await queue.transferToLocalDirectory({
        sourceParent: parent,
        sourceDirectoryPath: directoryPath,
        entries,
        directory,
      });
      if (!active.current) {
        if (response.status === 'conflict') {
          void queue.cancelTransferConfirmation(response.confirmationId).catch(() => {
            console.error('Download preparation release failed.');
          });
        }
        return;
      }
      if (response.status === 'rejected') {
        reportError(response.reason === 'permission-denied' ? 'permissionDenied' : 'unsupported');
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
    } catch (failure) {
      if (!active.current) return;
      const code = errorKey(failure);
      setPendingConflict(null);
      reportError(code);
      if (code === 'authRequired') onAuthRequired();
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function confirmOverwrite() {
    if (submitting.current || !pendingConflict) return;
    submitting.current = true;
    setBusy(true);
    setDirectoryInvalid(false);
    const confirmationId = pendingConflict.confirmationId;
    pendingConfirmationId.current = null;
    try {
      await queue.confirmTransfer(confirmationId);
      if (active.current) onClose();
    } catch (failure) {
      if (!active.current) return;
      const code = errorKey(failure);
      setPendingConflict(null);
      reportError(code);
      if (code === 'authRequired') onAuthRequired();
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
      await queue.cancelTransferConfirmation(confirmationId);
    } catch (failure) {
      if (active.current) reportError(errorKey(failure));
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
              error={directoryInvalid ? t('errors:invalidDownloadDirectory') : undefined}
              onChange={(value) => {
                directoryEdited.current = true;
                setDirectory(value);
                setReady(true);
                setDirectoryInvalid(false);
              }}
            />
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
        <TransferOverwriteModal
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
