import { Group, Loader, Modal } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatSize } from '@renderer/format/size';
import { errorKey, resultOf } from '@renderer/storage/storage-client';
import { useStorageWorkspace } from '@renderer/storage/storage-workspace-context';
import type { Entry } from '@shared/storage';
import { useCurrentDirectory } from '../current-directory-context';
import classes from './EntryInformationModal.module.css';

const entryInformationErrorNotification = 'entry-information-error';

export type EntrySelection = [Entry, ...Entry[]];

interface EntryInformationProps {
  entries: EntrySelection;
  onClose: () => void;
}

export function EntryInformationModal({ entries, onClose }: EntryInformationProps) {
  const { t, i18n } = useTranslation(['storage', 'common', 'errors']);
  const { onAuthRequired } = useStorageWorkspace();
  const { path: directoryPath } = useCurrentDirectory();
  const locale = i18n.resolvedLanguage;
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  const sizeFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const [measurement, setMeasurement] = useState<
    { bytes: number | null } | { failed: true } | null
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
        const code = errorKey(failure);
        setMeasurement({ failed: true });
        notifications.show({
          id: entryInformationErrorNotification,
          color: 'red',
          message: t(`errors:${code}`),
        });
        if (code === 'authRequired') onAuthRequired();
      },
    );
    return () => {
      active = false;
      void storage.cancelDirectoryMeasurement(id).catch(() => {});
    };
  }, [entries, onAuthRequired, t]);

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
  const failed = measurement !== null && 'failed' in measurement;
  const folderBytes = measurement && 'bytes' in measurement ? measurement.bytes : 0;
  const total =
    folderBytes === null || fileBytes === undefined ? undefined : folderBytes + fileBytes;
  const size =
    failed || total === undefined || !Number.isSafeInteger(total)
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
    </Modal>
  );
}
