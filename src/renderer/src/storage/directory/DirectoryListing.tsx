import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Button, Menu, Transition, VisuallyHidden } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { CircleAlert, FileUp, FolderUp, RefreshCw, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { Entry, EntryRef } from '@shared/storage';
import { useKeyboardShortcuts } from '@renderer/shortcuts/useKeyboardShortcuts';
import { errorKey, type StorageErrorKey } from '../storage-client';
import { selectPendingEntryEffects } from '../tasks/pending-entry-effects';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import type { DirectoryCache } from './directory-cache';
import type { DirectoryRow, DirectorySort } from './directory-types';
import { DirectoryEntryMenu } from './DirectoryEntryMenu';
import { DirectoryEntryModals } from './modals/DirectoryEntryModals';
import classes from './DirectoryListing.module.css';
import { DirectorySearch } from './DirectorySearch';
import { DirectoryTable } from './DirectoryTable';
import { useDirectoryEntryActions } from './useDirectoryEntryActions';
import { useDirectoryListing } from './useDirectoryListing';
import { useDirectorySearch } from './useDirectorySearch';
import { useDirectorySelection } from './useDirectorySelection';

function sortRows(rows: DirectoryRow[], { field, direction }: DirectorySort, locale?: string) {
  const { compare } = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const order = direction === 'ascending' ? 1 : -1;

  rows.sort((a, b) => {
    if (field === 'name') return compare(a.name, b.name) * order;
    const left = a[field];
    const right = b[field];
    if (left === undefined) return right === undefined ? compare(a.name, b.name) : 1;
    if (right === undefined) return -1;
    return (left - right) * order || compare(a.name, b.name);
  });
}

interface ListingProps {
  parent: EntryRef;
  cache: DirectoryCache;
  cacheable: boolean;
  version: number;
  directoryPath: string;
  canUpload: boolean;
  canUploadFolder: boolean;
  onOpen: (entry: Entry) => void;
  onAuthRequired: () => void;
  children: ReactNode;
}

export function DirectoryListing({
  parent,
  cache,
  cacheable,
  version,
  directoryPath,
  canUpload,
  canUploadFolder,
  onOpen,
  onAuthRequired,
  children,
}: ListingProps) {
  const { t, i18n } = useTranslation(['storage', 'common', 'errors']);
  const reduceMotion = useReducedMotion();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [sort, setSort] = useState<DirectorySort | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [uploadError, setUploadError] = useState<StorageErrorKey | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const { entries, phase, snapshot, error, refresh } = useDirectoryListing({
    parent,
    cache,
    cacheable,
    version,
    onAuthRequired,
  });
  const queue = useStorageTaskQueue();
  const tasks = useStore(queue.store, (state) => state.tasks);
  const groups = useStore(queue.store, (state) => state.groups);
  const pendingEntries = useMemo(
    () => selectPendingEntryEffects(tasks, groups, entries, parent),
    [tasks, groups, entries, parent],
  );
  const loading = phase === 'loading' || phase === 'refreshing';
  const loadingWithoutEntries = phase === 'loading' && entries.size === 0;

  const locale = i18n.resolvedLanguage;
  const rows = useMemo(() => {
    const rows = Array.from(entries.values(), (entry): DirectoryRow => {
      const modifiedAt = Date.parse(entry.modifiedAt ?? '');
      const pending = pendingEntries.get(entry.ref.locator);
      return {
        entry,
        name: pending?.optimisticName ?? entry.name,
        disabled: pending?.busy === true,
        modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : undefined,
        size: entry.kind === 'directory' ? undefined : entry.size,
      };
    });
    if (sort && snapshot) sortRows(rows, sort, locale);
    return rows;
  }, [entries, sort, snapshot, locale, pendingEntries]);
  const { selectedLocators, selectEntry, selectAll, selectOnly, selectForContextMenu } =
    useDirectorySelection({
      rows,
      completedEntries: phase === 'ready' ? entries : undefined,
      cache,
      parent,
    });
  const actions = useDirectoryEntryActions({
    entries,
    selectedLocators,
    pendingEntries,
    phase,
    selectForContextMenu,
  });
  const { closeMenu } = actions;
  const selectSearchMatch = useCallback(
    (locator: string | null) => {
      selectOnly(locator);
      closeMenu();
    },
    [selectOnly, closeMenu],
  );
  const search = useDirectorySearch(rows, selectSearchMatch);

  const reload = () => {
    actions.closeMenu();
    refresh();
  };
  const startUpload = async (upload: () => Promise<void>) => {
    setUploadPending(true);
    setUploadError(null);
    try {
      await upload();
    } catch (failure) {
      const code = errorKey(failure);
      if (code !== 'Cancelled') setUploadError(code);
      if (code === 'AuthRequired') onAuthRequired();
    } finally {
      setUploadPending(false);
    }
  };
  const uploadFile = () => startUpload(() => queue.uploadFile({ parent, directoryPath }));
  const uploadFolder = () => startUpload(() => queue.uploadFolder({ parent, directoryPath }));
  const openSearch = () => {
    actions.closeMenu();
    search.open();
    searchInput.current?.focus();
    searchInput.current?.select();
  };
  const closeSearch = () => {
    search.close();
    refreshButton.current?.focus();
  };
  useKeyboardShortcuts([
    {
      key: 'F2',
      onTrigger: actions.showRename,
      enabled: actions.canRename && !actions.renamePending,
    },
    { key: 'F5', onTrigger: reload, enabled: !loading, allowInEditable: true },
    { key: 'f', ctrlKey: true, onTrigger: openSearch, allowInEditable: true },
    ...(search.opened ? [{ key: 'Escape', onTrigger: closeSearch, allowInEditable: true }] : []),
  ]);
  const changeSort = (field: DirectorySort['field']) =>
    setSort((previous) => ({
      field,
      direction:
        previous?.field === field && previous.direction === 'ascending'
          ? 'descending'
          : 'ascending',
    }));
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  const sizeFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );

  return (
    <>
      <header className={classes.directoryHeader}>
        {children}
        <div className={classes.directoryActions}>
          {canUpload &&
            (canUploadFolder ? (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon
                    type="button"
                    variant="subtle"
                    color="gray"
                    aria-label={t('upload')}
                    title={t('upload')}
                    disabled={loading || uploadPending || error !== null}
                  >
                    <Upload size={16} strokeWidth={1.5} aria-hidden="true" />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item
                    leftSection={<FileUp size={16} strokeWidth={1.5} aria-hidden="true" />}
                    onClick={() => void uploadFile()}
                  >
                    {t('uploadFile')}
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<FolderUp size={16} strokeWidth={1.5} aria-hidden="true" />}
                    onClick={() => void uploadFolder()}
                  >
                    {t('uploadFolder')}
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : (
              <ActionIcon
                type="button"
                variant="subtle"
                color="gray"
                aria-label={t('upload')}
                title={t('upload')}
                disabled={loading || uploadPending || error !== null}
                onClick={() => void uploadFile()}
              >
                <Upload size={16} strokeWidth={1.5} aria-hidden="true" />
              </ActionIcon>
            ))}
          <ActionIcon
            ref={refreshButton}
            variant="subtle"
            color="gray"
            aria-label={t('refreshDirectory')}
            aria-keyshortcuts="F5"
            title={`${t('refreshDirectory')} (F5)`}
            disabled={loading}
            onClick={reload}
          >
            <RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />
          </ActionIcon>
        </div>
      </header>
      {uploadError && (
        <p className={classes.directoryStatus} role="alert">
          {t(`errors:${uploadError}`)}
        </p>
      )}
      {loadingWithoutEntries && (
        <VisuallyHidden>
          <output>{t('loadingDirectory')}</output>
        </VisuallyHidden>
      )}
      <div className={classes.directoryBody}>
        <div
          ref={setScrollElement}
          className={
            error && entries.size === 0
              ? `${classes.directoryContents} ${classes.centeredError}`
              : classes.directoryContents
          }
          aria-busy={loadingWithoutEntries}
        >
          <Transition
            mounted={search.opened}
            duration={reduceMotion ? 0 : 160}
            exitDuration={reduceMotion ? 0 : 120}
            timingFunction="ease-out"
            transition={{
              in: { opacity: 1, transform: 'translateY(0)' },
              out: { opacity: 0, transform: 'translateY(-4px)' },
              transitionProperty: 'opacity, transform',
            }}
          >
            {(styles) => (
              <div
                className={classes.searchOverlay}
                style={styles}
                inert={!search.opened}
                aria-hidden={!search.opened || undefined}
              >
                <DirectorySearch
                  opened={search.opened}
                  inputRef={searchInput}
                  query={search.query}
                  index={search.index}
                  total={search.total}
                  onChange={search.changeQuery}
                  onNavigate={search.navigate}
                  onClose={closeSearch}
                />
              </div>
            )}
          </Transition>
          {error && (
            <div className={classes.directoryError} role="alert">
              <CircleAlert size={24} strokeWidth={1.5} aria-hidden="true" />
              <p>{t(`errors:${error}`)}</p>
              <Button
                variant="subtle"
                size="compact-sm"
                leftSection={<RefreshCw size={16} strokeWidth={1.5} aria-hidden="true" />}
                onClick={reload}
              >
                {t('common:retry')}
              </Button>
            </div>
          )}
          {!error && snapshot?.size === 0 && (
            <p className={classes.directoryStatus}>{t('emptyDirectory')}</p>
          )}
          {(loadingWithoutEntries || entries.size > 0) && (
            <Menu
              opened={actions.menuOpened}
              onChange={(opened) => {
                if (!opened) actions.closeMenu();
              }}
              position="bottom-start"
              floatingStrategy="fixed"
              hideDetached={false}
              transitionProps={{ duration: 0 }}
            >
              <DirectoryTable
                scrollElement={scrollElement}
                rows={rows}
                revealTarget={search.revealTarget}
                sort={sort}
                canSort={snapshot !== undefined && !loading}
                loadingWithoutEntries={loadingWithoutEntries}
                selectedLocators={selectedLocators}
                dateFormatter={dateFormatter}
                sizeFormatter={sizeFormatter}
                onSort={changeSort}
                onSelect={selectEntry}
                onSelectAll={selectAll}
                onContextMenu={actions.showEntryMenu}
                onOpen={onOpen}
              />
              <DirectoryEntryMenu
                canDownload={actions.canDownload}
                downloadPending={actions.downloadPending}
                canRename={actions.canRename}
                renamePending={actions.renamePending}
                canDelete={actions.canDelete}
                deletePending={actions.deletePending}
                onDownload={actions.showDownload}
                onRename={actions.showRename}
                onInformation={actions.showInformation}
                onDelete={actions.showDelete}
              />
            </Menu>
          )}
        </div>
      </div>
      <DirectoryEntryModals
        parent={parent}
        directoryPath={directoryPath}
        dateFormatter={dateFormatter}
        sizeFormatter={sizeFormatter}
        onAuthRequired={onAuthRequired}
        renameEntry={actions.renameEntry}
        onCloseRename={actions.closeRename}
        downloadEntries={actions.downloadEntries}
        onCloseDownload={actions.closeDownload}
        deleteEntry={actions.deleteEntry}
        onCloseDelete={actions.closeDelete}
        informationEntries={actions.informationEntries}
        onCloseInformation={actions.closeInformation}
      />
    </>
  );
}
