import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu, VisuallyHidden } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { Entry, EntryRef } from '@shared/storage';
import { useKeyboardShortcuts } from '@renderer/shortcuts/useKeyboardShortcuts';
import { selectPendingEntryEffects } from '../tasks/pending-entry-effects';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import type { DirectoryCache } from './directory-cache';
import { buildDirectoryRows } from './directory-rows';
import type { DirectorySort } from './directory-types';
import { DirectoryEntryMenu } from './DirectoryEntryMenu';
import classes from './DirectoryListing.module.css';
import { DirectorySearch } from './DirectorySearch';
import { DirectoryStatus } from './DirectoryStatus';
import { DirectoryTable } from './DirectoryTable';
import { DirectoryToolbar } from './DirectoryToolbar';
import { DirectoryEntryModals } from './modals/DirectoryEntryModals';
import { useDirectoryEntryActions } from './useDirectoryEntryActions';
import { useDirectoryListing } from './useDirectoryListing';
import { useDirectorySearch } from './useDirectorySearch';
import { useDirectorySelection } from './useDirectorySelection';
import { useDirectoryUpload } from './useDirectoryUpload';

const selectAllLoadingNotification = 'directory-select-all-loading';

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
  onReauthorize: () => void;
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
  onReauthorize,
  children,
}: ListingProps) {
  const { t, i18n } = useTranslation(['storage', 'errors']);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [sort, setSort] = useState<DirectorySort | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);

  const { entries, phase, snapshot, error, refresh } = useDirectoryListing({
    parent,
    cache,
    cacheable,
    version,
    onAuthRequired,
  });
  const loading = phase === 'loading' || phase === 'refreshing';
  const loadingWithoutEntries = phase === 'loading' && entries.size === 0;

  const queue = useStorageTaskQueue();
  const tasks = useStore(queue.store, (state) => state.tasks);
  const groups = useStore(queue.store, (state) => state.groups);
  const pendingEntries = useMemo(
    () => selectPendingEntryEffects(tasks, groups, entries, parent),
    [tasks, groups, entries, parent],
  );

  const locale = i18n.resolvedLanguage;
  const rows = useMemo(
    () => buildDirectoryRows(entries, pendingEntries, snapshot ? sort : null, locale),
    [entries, pendingEntries, snapshot, sort, locale],
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  const sizeFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );

  const { selectedLocators, selectEntry, selectAll, selectOnly, selectForContextMenu } =
    useDirectorySelection({
      rows,
      completedEntries: phase === 'ready' ? entries : undefined,
      cache,
      parent,
      scrollElement,
    });
  const actions = useDirectoryEntryActions({
    entries,
    selectedLocators,
    pendingEntries,
    phase,
    selectForContextMenu,
  });
  const upload = useDirectoryUpload({
    parent,
    directoryPath,
    canUpload,
    blocked: loading || error !== null,
    onAuthRequired,
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
  const selectAllEntries = () => {
    if (phase === 'ready') {
      actions.closeMenu();
      selectAll();
    } else if (loading) {
      notifications.show({
        id: selectAllLoadingNotification,
        color: 'yellow',
        message: t('selectAllWhileLoading'),
      });
    }
  };
  useEffect(() => {
    if (phase === 'ready') notifications.hide(selectAllLoadingNotification);
  }, [phase]);

  useKeyboardShortcuts([
    {
      key: 'F2',
      onTrigger: actions.showRename,
      enabled: actions.canRename && !actions.renamePending,
    },
    { key: 'F5', onTrigger: reload, enabled: !loading, allowInEditable: true },
    { key: 'f', ctrlKey: true, onTrigger: openSearch, allowInEditable: true },
    { key: 'a', ctrlKey: true, onTrigger: selectAllEntries, enabled: phase !== 'error' },
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

  const centeredState = (error && entries.size === 0) || (!error && snapshot?.size === 0);

  return (
    <>
      <DirectoryToolbar
        canUpload={canUpload}
        canUploadFolder={canUploadFolder}
        uploadDisabled={upload.disabled}
        refreshDisabled={loading}
        refreshButton={refreshButton}
        onUploadFile={() => void upload.uploadFile()}
        onUploadFolder={() => void upload.uploadFolder()}
        onRefresh={reload}
      >
        {children}
      </DirectoryToolbar>
      {upload.error && (
        <p className={classes.directoryStatus} role="alert">
          {t(`errors:${upload.error}`)}
        </p>
      )}
      {loadingWithoutEntries && (
        <VisuallyHidden>
          <output>{t('loadingDirectory')}</output>
        </VisuallyHidden>
      )}
      <div className={classes.directoryBody} {...upload.dropZoneProps}>
        {upload.dropActive && (
          <div className={classes.dropOverlay} aria-hidden="true">
            <div className={classes.dropPrompt}>
              <Upload size={16} strokeWidth={1.5} />
              <span>{t('dropToUpload')}</span>
            </div>
          </div>
        )}
        <div
          ref={setScrollElement}
          className={
            centeredState
              ? `${classes.directoryContents} ${classes.centeredState}`
              : classes.directoryContents
          }
          aria-busy={loadingWithoutEntries}
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
          <DirectoryStatus
            error={error}
            empty={snapshot?.size === 0}
            onReauthorize={onReauthorize}
            onRetry={reload}
          />
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
        deleteEntries={actions.deleteEntries}
        onCloseDelete={actions.closeDelete}
        informationEntries={actions.informationEntries}
        onCloseInformation={actions.closeInformation}
      />
    </>
  );
}
