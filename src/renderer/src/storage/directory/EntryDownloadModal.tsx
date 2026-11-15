import { useEffect, useRef, useState } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { DownloadRequest } from '../../../../shared/downloads';
import type { Entry, EntryRef } from '../../../../shared/storage';
import { DownloadDirectoryInput } from '../../downloads/DownloadDirectoryInput';
import { errorKey, resultOf, type StorageErrorKey } from '../storage-client';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import { DownloadOverwriteModal } from './DownloadOverwriteModal';

export function EntryDownloadModal({
  entry,
  parent,
  directoryPath,
  onClose,
  onAuthRequired,
}: {
  entry: Entry;
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
  const [overwriteRequest, setOverwriteRequest] = useState<DownloadRequest | null>(null);
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
          input: { parent, entry, directoryPath, destination },
        })
      ) {
        await resultOf(window.desktop.downloads.cancel(destination.id));
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
            void submit({ ref: entry.ref, directory, expectedName: entry.name, replace: false });
          }}
        >
          <Stack>
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
          onConfirm={() => {
            void submit(overwriteRequest);
          }}
          onCancel={() => setOverwriteRequest(null)}
        />
      )}
    </>
  );
}
