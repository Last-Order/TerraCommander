import { useEffect, useRef, useState } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { DownloadRequest, PreparedDownloadBatch } from '../../../../shared/downloads';
import type { Entry, EntryRef } from '../../../../shared/storage';
import { DownloadDirectoryInput } from '../../downloads/DownloadDirectoryInput';
import { errorKey, resultOf, type StorageErrorKey } from '../storage-client';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import { DownloadOverwriteModal } from './DownloadOverwriteModal';
import { enqueueDownloadGroup } from '../tasks/download-group';

export function EntryDownloadModal({
  entries,
  parent,
  directoryPath,
  onClose,
  onAuthRequired,
  onLocalChanged,
}: {
  entries: readonly Entry[];
  parent: EntryRef;
  directoryPath: string;
  onClose: () => void;
  onAuthRequired: () => void;
  onLocalChanged: () => void;
}) {
  const { t } = useTranslation(['storage', 'common', 'errors']);
  const queue = useStorageTaskQueue();
  const [directory, setDirectory] = useState('');
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StorageErrorKey>();
  const [overwriteRequest, setOverwriteRequest] = useState<
    DownloadRequest | PreparedDownloadBatch | null
  >(null);
  const preparedBatch = useRef<PreparedDownloadBatch | null>(null);
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
      if (preparedBatch.current) {
        void window.desktop.downloads.releaseBatch(preparedBatch.current.id).catch(() => {
          console.error('Download preparation release failed.');
        });
        preparedBatch.current = null;
      }
    };
  }, []);
  async function submit(request: DownloadRequest) {
    if (submitting.current || !request.directory) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const destination = await resultOf(window.desktop.downloads.prepare(request));
      if (
        !active.current ||
        !queue.enqueue({
          type: 'download',
          input: {
            parent,
            entry,
            directoryPath,
            destination,
          },
        })
      ) {
        await resultOf(window.desktop.downloads.releaseWork(destination.ref));
        if (active.current) {
          setOverwriteRequest(null);
          setError('DownloadTargetBusy');
        }
        return;
      }
      onClose();
    } catch (error) {
      if (!active.current) return;
      const code = errorKey(error);
      if (code === 'AlreadyExists') {
        setOverwriteRequest({ ...request, replace: true });
        return;
      }
      setOverwriteRequest(null);
      setError(code);
      if (code === 'AuthRequired') onAuthRequired();
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function enqueueBatch(destination: PreparedDownloadBatch) {
    if (
      !active.current ||
      !enqueueDownloadGroup(
        queue,
        { parent, entries, directoryPath, destination },
        { onAuthRequired, onLocalChanged },
      )
    ) {
      await resultOf(window.desktop.downloads.releaseBatch(destination.id));
      preparedBatch.current = null;
      if (active.current) {
        setOverwriteRequest(null);
        setError('DownloadTargetBusy');
      }
      return;
    }
    preparedBatch.current = null;
    onClose();
  }
  async function submitBatch(destination?: PreparedDownloadBatch) {
    if (submitting.current || !directory) return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (destination) {
        await resultOf(window.desktop.downloads.confirmBatch(destination.id));
        await enqueueBatch(destination);
      } else {
        const prepared = await resultOf(
          window.desktop.downloads.prepareBatch({
            entries: entries.map((entry) => ({ ref: entry.ref, expectedName: entry.name })),
            directory,
          }),
        );
        preparedBatch.current = prepared;
        if (!active.current) {
          await resultOf(window.desktop.downloads.releaseBatch(prepared.id));
          preparedBatch.current = null;
        } else if (prepared.conflicts.length) setOverwriteRequest(prepared);
        else await enqueueBatch(prepared);
      }
    } catch (error) {
      if (!active.current) return;
      const code = errorKey(error);
      setError(code);
      if (code === 'AuthRequired') onAuthRequired();
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  }
  const entry = entries[0]!;
  const singleFile = entries.length === 1 && entry.kind === 'file';
  const blocked = busy || overwriteRequest !== null;
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
        trapFocus={overwriteRequest === null}
        returnFocus={overwriteRequest === null}
        inert={overwriteRequest !== null}
        closeButtonProps={{ disabled: blocked, 'aria-label': t('common:close') }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (singleFile)
              void submit({ ref: entry.ref, directory, expectedName: entry.name, replace: false });
            else void submitBatch();
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
      {overwriteRequest && (
        <DownloadOverwriteModal
          busy={busy}
          conflicts={'conflicts' in overwriteRequest ? overwriteRequest.conflicts : undefined}
          onConfirm={() => {
            if ('conflicts' in overwriteRequest) void submitBatch(overwriteRequest);
            else void submit(overwriteRequest);
          }}
          onCancel={() => {
            setOverwriteRequest(null);
            if (preparedBatch.current) {
              const id = preparedBatch.current.id;
              preparedBatch.current = null;
              setBusy(true);
              void resultOf(window.desktop.downloads.releaseBatch(id))
                .catch((error: unknown) => {
                  if (active.current) setError(errorKey(error));
                })
                .finally(() => {
                  if (active.current) setBusy(false);
                });
            }
          }}
        />
      )}
    </>
  );
}
