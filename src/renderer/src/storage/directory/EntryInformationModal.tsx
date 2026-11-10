import { useEffect, useState } from 'react';
import { Alert, Group, Loader, Modal } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import type { Entry } from '../../../../shared/storage';
import { errorKey, resultOf, type StorageErrorKey } from '../storage-client';
import classes from './EntryInformationModal.module.css';
import { formatSize } from './entry-format';

export type EntrySelection = [Entry, ...Entry[]];

interface EntryInformationProps {
  entries: EntrySelection;
  directoryPath: string;
  dateFormatter: Intl.DateTimeFormat;
  sizeFormatter: Intl.NumberFormat;
  onAuthRequired: () => void;
  onClose: () => void;
}

export function EntryInformationModal({
  entries,
  directoryPath,
  dateFormatter,
  sizeFormatter,
  onAuthRequired,
  onClose,
}: EntryInformationProps) {
  const { t } = useTranslation(['storage', 'common', 'errors']);
  const [measurement, setMeasurement] = useState<
    { bytes: number | null } | { error: StorageErrorKey } | null
  >(null);

  useEffect(() => {
    const folders = entries.filter(({ kind }) => kind === 'directory').map(({ ref }) => ref);
    if (folders.length === 0) return;

    const id = crypto.randomUUID();
    const storage = window.desktop.storage;
    let active = true;
    void resultOf(storage.measureDirectorySize(id, folders)).then(
      (bytes) => {
        if (active) setMeasurement({ bytes });
      },
      (failure: unknown) => {
        if (!active) return;
        const error = errorKey(failure);
        setMeasurement({ error });
        if (error === 'AuthRequired') onAuthRequired();
      },
    );
    return () => {
      active = false;
      void storage.cancelDirectoryMeasurement(id).catch(() => {});
    };
  }, [entries, onAuthRequired]);

  const [first] = entries;
  const multiple = entries.length > 1;
  const path = multiple
    ? (first.displayPath?.slice(0, -first.name.length) ?? directoryPath)
    : (first.displayPath ?? `${directoryPath} / ${first.name}`);
  let latestModifiedAt: number | undefined;
  let fileBytes: number | undefined = 0;
  for (const entry of entries) {
    const modifiedAt = Date.parse(entry.modifiedAt ?? '');
    if (
      Number.isFinite(modifiedAt) &&
      (latestModifiedAt === undefined || modifiedAt > latestModifiedAt)
    ) {
      latestModifiedAt = modifiedAt;
    }
    if (entry.kind !== 'directory' && fileBytes !== undefined) {
      fileBytes = entry.size === undefined ? undefined : fileBytes + entry.size;
    }
  }
  const calculating = measurement === null && entries.some(({ kind }) => kind === 'directory');
  const error = measurement && 'error' in measurement ? measurement.error : null;
  const folderBytes = measurement && 'bytes' in measurement ? measurement.bytes : 0;
  const total =
    folderBytes === null || fileBytes === undefined ? undefined : folderBytes + fileBytes;
  const size =
    error || total === undefined || !Number.isSafeInteger(total)
      ? t('entrySizeUnavailable')
      : formatSize(total, sizeFormatter);

  return (
    <Modal
      opened
      onClose={onClose}
      title={t('entryInformation')}
      closeButtonProps={{ 'aria-label': t('common:close') }}
      centered
    >
      <dl className={classes.entryInformation}>
        <dt>{t(multiple ? 'entrySelection' : 'entryName')}</dt>
        <dd>{multiple ? t('entrySelectionCount', { count: entries.length }) : first.name}</dd>
        <dt>{t(multiple ? 'entryTotalSize' : 'entrySize')}</dt>
        <dd aria-live="polite">
          {calculating ? (
            <Group gap="xs">
              <Loader size="xs" aria-hidden="true" />
              {t('calculatingEntrySize')}
            </Group>
          ) : (
            size
          )}
        </dd>
        <dt>{t(multiple ? 'entryLatestModifiedAt' : 'entryModifiedAt')}</dt>
        <dd>{latestModifiedAt === undefined ? '—' : dateFormatter.format(latestModifiedAt)}</dd>
        <dt>{t(multiple ? 'entryParentPath' : 'entryPath')}</dt>
        <dd>{path}</dd>
      </dl>
      {error && (
        <Alert color="red" role="alert">
          {t(`errors:${error}`)}
        </Alert>
      )}
    </Modal>
  );
}
