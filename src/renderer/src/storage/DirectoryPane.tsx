import { useEffect, useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Button, Group, Menu, Skeleton, VisuallyHidden } from '@mantine/core';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  File,
  Folder,
  FolderOpen,
  Info,
  Link2,
  RefreshCw,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SWRConfig } from 'swr';
import useSWRInfinite from 'swr/infinite';
import type { Entry, EntryPage, EntryRef, Space, StorageLabel } from '../../../shared/storage';
import { EntryInformationModal, type EntrySelection } from './EntryInformationModal';
import { formatSize } from './entry-format';
import { errorKey, resultOf, StorageBrowserError } from './storage-client';
import { formatStorageLabel } from './storage-labels';
import classes from './StorageWorkspace.module.css';

const temporaryFolderCache = { provider: () => new Map() };
const entryIconSize = 17;
const columns = [
  { field: 'name', label: 'entryName', className: undefined },
  { field: 'modifiedAt', label: 'entryModifiedAt', className: classes.entryDate },
  { field: 'size', label: 'entrySize', className: classes.entrySize },
] as const;

interface DirectorySort {
  field: (typeof columns)[number]['field'];
  direction: 'ascending' | 'descending';
}

interface DirectoryRow {
  entry: Entry;
  modifiedAt: number | undefined;
  size: number | undefined;
}

function sortRows(rows: DirectoryRow[], { field, direction }: DirectorySort, locale?: string) {
  const { compare } = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const order = direction === 'ascending' ? 1 : -1;

  rows.sort((a, b) => {
    const byName = compare(a.entry.name, b.entry.name);
    if (field === 'name') return byName * order;
    const left = a[field];
    const right = b[field];
    if (left === undefined) return right === undefined ? byName : 1;
    if (right === undefined) return -1;
    return (left - right) * order || byName;
  });
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
      <SWRConfig
        key={JSON.stringify([current.ref, version])}
        value={trail.length > 1 ? temporaryFolderCache : {}}
      >
        <DirectoryListing
          parent={current.ref}
          version={version}
          directoryPath={trail.map(({ name }) => formatStorageLabel(name, t)).join(' / ')}
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
      </SWRConfig>
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

function DirectorySkeletonRows() {
  return Array.from({ length: 10 }, (_, index) => (
    <tr key={index}>
      <td className={classes.entryName}>
        <div className={classes.entryPlaceholder}>
          <Skeleton style={{ width: entryIconSize, height: entryIconSize, flex: 'none' }} />
          <Skeleton width="min(55%, 14rem)" height="0.75rem" />
        </div>
      </td>
      <td className={classes.entryDate}>
        <Skeleton width="8.5rem" height="0.75rem" />
      </td>
      <td className={classes.entrySize}>
        <Skeleton className={classes.entrySizePlaceholder} width="3rem" height="0.75rem" />
      </td>
    </tr>
  ));
}

interface ListingProps {
  parent: EntryRef;
  version: number;
  directoryPath: string;
  onOpen: (entry: Entry) => void;
  onAuthRequired: () => void;
  children: ReactNode;
}

function DirectoryListing({
  parent,
  version,
  directoryPath,
  onOpen,
  onAuthRequired,
  children,
}: ListingProps) {
  const { t, i18n } = useTranslation(['storage', 'common', 'errors']);
  const [selectedLocators, setSelectedLocators] = useState(() => new Set<string>());
  const [menuEntries, setMenuEntries] = useState<EntrySelection | null>(null);
  const [informationEntries, setInformationEntries] = useState<EntrySelection | null>(null);
  const [sort, setSort] = useState<DirectorySort | null>(null);
  const {
    data: pages,
    error: failure,
    isValidating: loading,
    mutate,
    size,
    setSize,
  } = useSWRInfinite(
    (index, previous: EntryPage | null) => {
      if (index > 0 && !previous?.nextCursor) return null;
      return ['storage/directory', parent, version, previous?.nextCursor] as const;
    },
    ([, ref, , cursor]) => resultOf(window.desktop.storage.listDirectory(ref, cursor)),
    {
      revalidateIfStale: false,
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
  const repeatedCursor =
    nextCursor !== undefined &&
    pages?.some((page, index) => index < pages.length - 1 && page.nextCursor === nextCursor);
  const code = failure ? errorKey(failure) : repeatedCursor ? 'OutcomeUnknown' : null;
  const error = !loading && code ? t(`errors:${code}`) : null;
  const hasMorePages = nextCursor !== undefined && !code;
  const complete = pages !== undefined && nextCursor === undefined && !code;
  const canSort = complete && !loading;
  const loadingFirstPage = loading && !pages;
  const pageCount = pages?.length;

  useEffect(() => {
    if (hasMorePages && !loading && pageCount === size) void setSize(size + 1);
  }, [hasMorePages, loading, pageCount, size, setSize]);

  if (complete && !loading && selectedLocators.size > 0) {
    const remaining = [...selectedLocators].filter((locator) => entries.has(locator));
    if (remaining.length < selectedLocators.size) setSelectedLocators(new Set(remaining));
  }

  const rows = Array.from(entries.values(), (entry): DirectoryRow => {
    const modifiedAt = Date.parse(entry.modifiedAt ?? '');
    return {
      entry,
      modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : undefined,
      size: entry.kind === 'directory' ? undefined : entry.size,
    };
  });
  if (sort && complete) sortRows(rows, sort, i18n.resolvedLanguage);

  const reload = () => void mutate();
  const selectEntry = (locator: string, toggle: boolean) => {
    setSelectedLocators((previous) => {
      if (!toggle) return new Set([locator]);

      const next = new Set(previous);
      if (next.has(locator)) next.delete(locator);
      else next.add(locator);
      return next;
    });
  };
  const showEntryMenu = (entry: Entry) => {
    const selection: EntrySelection = [entry];
    if (selectedLocators.has(entry.ref.locator)) {
      for (const other of entries.values()) {
        if (other !== entry && selectedLocators.has(other.ref.locator)) selection.push(other);
      }
    } else {
      selectEntry(entry.ref.locator, false);
    }
    setMenuEntries(selection);
  };
  const changeSort = (field: DirectorySort['field']) =>
    setSort((previous) => ({
      field,
      direction:
        previous?.field === field && previous.direction === 'ascending'
          ? 'descending'
          : 'ascending',
    }));
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
          disabled={loading || hasMorePages}
          onClick={reload}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </ActionIcon>
      </header>
      {loadingFirstPage && (
        <VisuallyHidden>
          <output>{t('loadingDirectory')}</output>
        </VisuallyHidden>
      )}
      <div className={classes.directoryContents} aria-busy={loadingFirstPage}>
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
        {complete && entries.size === 0 && (
          <p className={classes.directoryStatus}>{t('emptyDirectory')}</p>
        )}
        {(loadingFirstPage || entries.size > 0) && (
          <Menu
            opened={menuEntries !== null}
            onChange={(opened) => {
              if (!opened) setMenuEntries(null);
            }}
            position="bottom-start"
            floatingStrategy="fixed"
            hideDetached={false}
            transitionProps={{ duration: 0 }}
          >
            <table className={classes.entries} aria-label={t('filesAndFolders')}>
              <thead>
                <tr>
                  {columns.map(({ field, label, className }) => {
                    const direction = canSort && sort?.field === field ? sort.direction : undefined;
                    const Icon =
                      direction === 'ascending'
                        ? ChevronUp
                        : direction
                          ? ChevronDown
                          : ChevronsUpDown;
                    return (
                      <th key={field} scope="col" className={className} aria-sort={direction}>
                        {canSort ? (
                          <button
                            type="button"
                            className={classes.sortHeader}
                            onClick={() => changeSort(field)}
                          >
                            {t(label)}
                            <Icon size={14} aria-hidden="true" />
                          </button>
                        ) : (
                          <span className={classes.columnLabel}>{t(label)}</span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <Menu.ContextMenu disabled={loadingFirstPage}>
                <tbody
                  aria-hidden={loadingFirstPage || undefined}
                  className={loadingFirstPage ? classes.placeholderRows : undefined}
                >
                  {loadingFirstPage && <DirectorySkeletonRows />}
                  {rows.map(({ entry, modifiedAt, size }) => {
                    const { locator } = entry.ref;
                    const isDirectory = entry.kind === 'directory';
                    const Icon = isDirectory ? Folder : entry.kind === 'link' ? Link2 : File;
                    const selected = selectedLocators.has(locator);

                    return (
                      <tr
                        key={locator}
                        className={classes.entryRow}
                        data-selected={selected}
                        onClick={(event) => selectEntry(locator, event.ctrlKey)}
                        onContextMenu={() => showEntryMenu(entry)}
                        onDoubleClick={
                          isDirectory
                            ? (event) => {
                                if (!event.ctrlKey) onOpen(entry);
                              }
                            : undefined
                        }
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
                            <Icon size={entryIconSize} aria-hidden="true" />
                            <span title={entry.name}>{entry.name}</span>
                            {isDirectory && <ChevronRight size={14} aria-hidden="true" />}
                          </button>
                        </td>
                        <td className={classes.entryDate}>
                          {modifiedAt !== undefined ? (
                            <time dateTime={entry.modifiedAt}>
                              {dateFormatter.format(modifiedAt)}
                            </time>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className={classes.entrySize}>
                          {size !== undefined ? formatSize(size, sizeFormatter) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Menu.ContextMenu>
            </table>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<Info size={16} aria-hidden="true" />}
                onClick={() => setInformationEntries(menuEntries)}
              >
                {t('entryInformation')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </div>
      {informationEntries && (
        <EntryInformationModal
          entries={informationEntries}
          directoryPath={directoryPath}
          dateFormatter={dateFormatter}
          sizeFormatter={sizeFormatter}
          onAuthRequired={onAuthRequired}
          onClose={() => setInformationEntries(null)}
        />
      )}
    </>
  );
}
