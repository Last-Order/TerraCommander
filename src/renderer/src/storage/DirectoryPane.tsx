import { useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Button, Group, Loader } from '@mantine/core';
import { ChevronRight, File, Folder, FolderOpen, Link2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import useSWRInfinite from 'swr/infinite';
import type { Entry, EntryPage, EntryRef, Space, StorageLabel } from '../../../shared/storage';
import { errorKey, resultOf, StorageBrowserError } from './storage-client';
import { formatStorageLabel } from './storage-labels';
import classes from './StorageWorkspace.module.css';

const sizeUnits = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

function formatSize(bytes: number, formatter: Intl.NumberFormat): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < sizeUnits.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${formatter.format(value)} ${sizeUnits[unit]}`;
}

interface Location {
  ref: EntryRef;
  name: StorageLabel;
}

interface DirectoryProps {
  space: Space;
  version: number;
  onAuthRequired: () => void;
}

export function DirectoryPane({ space, version, onAuthRequired }: DirectoryProps) {
  const { t } = useTranslation('storage');
  const [trail, setTrail] = useState<Location[]>([{ ref: space.root, name: space.name }]);
  const current = trail.at(-1) ?? { ref: space.root, name: space.name };

  return (
    <main className={classes.directory}>
      <DirectoryListing
        key={JSON.stringify([current.ref, version])}
        parent={current.ref}
        version={version}
        onOpen={(entry) => setTrail([...trail, entry])}
        onAuthRequired={onAuthRequired}
      >
        <nav className={classes.breadcrumbs} aria-label={t('currentDirectory')}>
          {trail.map((location, index) => {
            const name = formatStorageLabel(location.name, t);
            return (
              <div className={classes.crumb} key={index}>
                {index > 0 && <ChevronRight size={14} aria-hidden="true" />}
                {index === trail.length - 1 ? (
                  <span aria-current="page" title={name}>
                    {name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setTrail(trail.slice(0, index + 1))}
                    title={name}
                  >
                    {name}
                  </button>
                )}
              </div>
            );
          })}
        </nav>
      </DirectoryListing>
    </main>
  );
}

export function EmptyDirectoryPane() {
  const { t } = useTranslation('storage');
  return (
    <main className={classes.emptyDirectory}>
      <FolderOpen size={32} strokeWidth={1.5} aria-hidden="true" />
      <h1>{t('chooseSpace')}</h1>
      <p>{t('chooseSpaceHint')}</p>
    </main>
  );
}

interface ListingProps {
  parent: EntryRef;
  version: number;
  onOpen: (entry: Entry) => void;
  onAuthRequired: () => void;
  children: ReactNode;
}

function DirectoryListing({ parent, version, onOpen, onAuthRequired, children }: ListingProps) {
  const { t, i18n } = useTranslation(['storage', 'common', 'errors']);
  const [selectedLocator, setSelectedLocator] = useState<string | null>(null);
  const {
    data: pages,
    error: failure,
    isValidating: loading,
    mutate,
    setSize,
  } = useSWRInfinite(
    (index, previous: EntryPage | null) => {
      if (index > 0 && !previous?.nextCursor) return null;
      return ['storage/directory', parent, version, previous?.nextCursor] as const;
    },
    ([, ref, , cursor]) => resultOf(window.desktop.storage.listDirectory(ref, cursor)),
    {
      revalidateOnMount: true,
      revalidateFirstPage: false,
      onError(error: unknown) {
        if (error instanceof StorageBrowserError && error.code === 'AuthRequired') onAuthRequired();
      },
    },
  );
  const entries = new Map<string, Entry>();
  for (const page of pages ?? []) {
    for (const entry of page.entries) entries.set(entry.ref.locator, entry);
  }
  const nextCursor = pages?.at(-1)?.nextCursor;
  const error = !loading && failure ? t(`errors:${errorKey(failure)}`) : null;
  const reload = () => void mutate();
  const dateFormatter = new Intl.DateTimeFormat(i18n.resolvedLanguage, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const sizeFormatter = new Intl.NumberFormat(i18n.resolvedLanguage, { maximumFractionDigits: 1 });

  return (
    <>
      <header className={classes.directoryHeader}>
        {children}
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('refreshDirectory')}
          disabled={loading}
          onClick={reload}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </ActionIcon>
      </header>
      <div className={classes.directoryContents} aria-busy={loading}>
        {loading && !pages && <Loader size="sm" aria-label={t('loadingDirectory')} />}
        {error && (
          <Alert color="red" role="alert">
            <Group justify="space-between">
              {error}
              <Button variant="subtle" size="compact-sm" onClick={reload}>
                {t('common:retry')}
              </Button>
            </Group>
          </Alert>
        )}
        {pages && entries.size === 0 && !nextCursor && !error && (
          <p className={classes.directoryStatus}>{t('emptyDirectory')}</p>
        )}
        {entries.size > 0 && (
          <table className={classes.entries} aria-label={t('filesAndFolders')}>
            <thead>
              <tr>
                <th scope="col">{t('entryName')}</th>
                <th scope="col" className={classes.entryDate}>
                  {t('entryModifiedAt')}
                </th>
                <th scope="col" className={classes.entrySize}>
                  {t('entrySize')}
                </th>
              </tr>
            </thead>
            <tbody>
              {[...entries.values()].map((entry) => {
                const { locator } = entry.ref;
                const isDirectory = entry.kind === 'directory';
                const Icon = isDirectory ? Folder : entry.kind === 'link' ? Link2 : File;
                const selected = selectedLocator === locator;
                const modifiedAt = Date.parse(entry.modifiedAt ?? '');

                return (
                  <tr
                    key={locator}
                    className={classes.entryRow}
                    data-selected={selected}
                    onClick={() => setSelectedLocator(locator)}
                    onDoubleClick={isDirectory ? () => onOpen(entry) : undefined}
                  >
                    <td className={classes.entryName}>
                      <button
                        type="button"
                        className={classes.entry}
                        data-kind={entry.kind}
                        aria-pressed={selected}
                        onKeyDown={(event) => {
                          if (isDirectory && event.key === 'Enter') {
                            event.preventDefault();
                            onOpen(entry);
                          }
                        }}
                      >
                        <Icon size={17} aria-hidden="true" />
                        <span>{entry.name}</span>
                        {isDirectory && <ChevronRight size={14} aria-hidden="true" />}
                      </button>
                    </td>
                    <td className={classes.entryDate}>
                      {Number.isFinite(modifiedAt) ? (
                        <time dateTime={entry.modifiedAt}>{dateFormatter.format(modifiedAt)}</time>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={classes.entrySize}>
                      {!isDirectory && entry.size !== undefined
                        ? formatSize(entry.size, sizeFormatter)
                        : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {nextCursor && !error && (
          <Button
            variant="default"
            size="compact-sm"
            loading={loading}
            onClick={() => void setSize((size) => size + 1)}
          >
            {t('loadMore')}
          </Button>
        )}
      </div>
    </>
  );
}
