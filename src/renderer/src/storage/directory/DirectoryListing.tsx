import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu, VisuallyHidden } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ClipboardPaste, FolderPlus, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { Entry } from '@shared/storage';
import { useKeyboardShortcuts } from '@renderer/shortcuts/useKeyboardShortcuts';
import { useStorageWorkspace } from '../storage-workspace-context';
import { selectPendingEntryEffects } from '../tasks/pending-entry-effects';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import { useCurrentDirectory } from './current-directory-context';
import { buildDirectoryRows } from './directory-rows';
import type { DirectorySort } from './directory-types';
import { DirectoryEntryMenu } from './DirectoryEntryMenu';
import classes from './DirectoryListing.module.css';
import { DirectorySearch } from './DirectorySearch';
import { DirectoryStatus } from './DirectoryStatus';
import { DirectoryTable } from './DirectoryTable';
import { DirectoryToolbar } from './DirectoryToolbar';
import { DirectoryEntryModals } from './modals/DirectoryEntryModals';
import { DownloadOverwriteModal } from './modals/DownloadOverwriteModal';
import { useDirectoryClipboard } from './useDirectoryClipboard';
import { useDirectoryEntryActions } from './useDirectoryEntryActions';
import { useDirectoryListing } from './useDirectoryListing';
import { useDirectorySearch } from './useDirectorySearch';
import { useDirectorySelection } from './useDirectorySelection';
import { useDirectoryUpload } from './useDirectoryUpload';

const selectAllLoadingNotification = 'directory-select-all-loading';

interface ListingProps {
  cacheable: boolean;
  version: number;
  onOpen: (entry: Entry) => void;
  children: ReactNode;
}

export function DirectoryListing({ cacheable, version, onOpen, children }: ListingProps) {
  const { t, i18n } = useTranslation(['storage', 'errors']);
  const { directoryCache: cache, onAuthRequired, reauthorize } = useStorageWorkspace();
  const { ref: parent, canCreateDirectory } = useCurrentDirectory();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [sort, setSort] = useState<DirectorySort | null>(null);
  const [createDirectoryOpened, setCreateDirectoryOpened] = useState(false);
  const [blankMenuPosition, setBlankMenuPosition] = useState<{ x: number; y: number } | null>(null);
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

  const createDirectoryEnabled = canCreateDirectory && !loading && error === null;
  const openCreateDirectory = () => {
    if (!createDirectoryEnabled) return;
    actions.closeMenu();
    setBlankMenuPosition(null);
    setCreateDirectoryOpened(true);
  };
  const clipboard = useDirectoryClipboard({
    blocked: loadingWithoutEntries || error !== null,
    onAuthRequired,
  });

  const copySelection = () => {
    if (!actions.canCopy) return;
    actions.closeMenu();
    setBlankMenuPosition(null);
    clipboard.copy(actions.selectedEntries);
  };

  const cutSelection = () => {
    if (!actions.canCut || actions.cutPending) return;
    actions.closeMenu();
    setBlankMenuPosition(null);
    clipboard.cut(actions.selectedEntries);
  };

  const pasteSelection = () => {
    setBlankMenuPosition(null);
    void clipboard.paste();
  };

  useKeyboardShortcuts([
    {
      key: 'n',
      ctrlKey: true,
      shiftKey: true,
      onTrigger: openCreateDirectory,
      enabled: createDirectoryEnabled,
    },
    {
      key: 'c',
      ctrlKey: true,
      onTrigger: copySelection,
      enabled: actions.canCopy,
    },
    {
      key: 'x',
      ctrlKey: true,
      onTrigger: cutSelection,
      enabled: actions.canCut && !actions.cutPending,
    },
    {
      key: 'v',
      ctrlKey: true,
      onTrigger: pasteSelection,
      enabled: clipboard.canPaste,
    },
    {
      key: 'F2',
      onTrigger: actions.showRename,
      enabled: actions.canRename && !actions.renamePending,
    },
    {
      key: 'Delete',
      onTrigger: actions.showDelete,
      enabled: actions.canDelete && !actions.deletePending,
    },
    { key: 'F5', onTrigger: reload, enabled: !loading, allowInEditable: true },
    { key: 'f', ctrlKey: true, onTrigger: openSearch, allowInEditable: true },
    { key: 'a', ctrlKey: true, onTrigger: selectAllEntries, enabled: phase !== 'error' },
    ...(search.opened ? [{ key: 'Escape', onTrigger: closeSearch, allowInEditable: true }] : []),
    ...(!search.opened && clipboard.isCutActive
      ? [{ key: 'Escape', onTrigger: clipboard.clear }]
      : []),
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
        createDirectoryDisabled={!createDirectoryEnabled}
        uploadDisabled={upload.disabled}
        refreshDisabled={loading}
        refreshButton={refreshButton}
        onCreateDirectory={openCreateDirectory}
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
          onContextMenu={(event) => {
            const { target } = event;
            if (!(target instanceof Element)) return;
            if (target.closest('tr[data-index], thead, [data-directory-search]')) return;
            if (loadingWithoutEntries || error !== null) return;
            event.preventDefault();
            actions.closeMenu();
            setBlankMenuPosition({ x: event.clientX, y: event.clientY });
          }}
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
            onReauthorize={() => reauthorize(parent.connectionId)}
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
                cutLocators={clipboard.cutLocators}
                dateFormatter={dateFormatter}
                sizeFormatter={sizeFormatter}
                onSort={changeSort}
                onSelect={selectEntry}
                onContextMenu={actions.showEntryMenu}
                onOpen={onOpen}
              />
              <DirectoryEntryMenu
                canCopy={actions.canCopy}
                canCut={actions.canCut}
                cutPending={actions.cutPending}
                canDownload={actions.canDownload}
                downloadPending={actions.downloadPending}
                canRename={actions.canRename}
                renamePending={actions.renamePending}
                canDelete={actions.canDelete}
                deletePending={actions.deletePending}
                onCopy={copySelection}
                onCut={cutSelection}
                onDownload={actions.showDownload}
                onRename={actions.showRename}
                onInformation={actions.showInformation}
                onDelete={actions.showDelete}
              />
            </Menu>
          )}
          <Menu
            opened={blankMenuPosition !== null}
            onChange={(opened) => {
              if (!opened) setBlankMenuPosition(null);
            }}
            position="bottom-start"
            floatingStrategy="fixed"
            hideDetached={false}
            transitionProps={{ duration: 0 }}
          >
            <Menu.Target>
              <div
                style={{
                  position: 'fixed',
                  left: blankMenuPosition?.x ?? 0,
                  top: blankMenuPosition?.y ?? 0,
                  width: 0,
                  height: 0,
                  pointerEvents: 'none',
                }}
              />
            </Menu.Target>
            <Menu.Dropdown>
              {canCreateDirectory && (
                <Menu.Item
                  disabled={!createDirectoryEnabled}
                  aria-keyshortcuts="Control+Shift+N"
                  leftSection={<FolderPlus size={16} strokeWidth={1.5} aria-hidden="true" />}
                  onClick={openCreateDirectory}
                >
                  {t('newFolder')}
                </Menu.Item>
              )}
              <Menu.Item
                disabled={!clipboard.canPaste}
                aria-keyshortcuts="Control+V"
                leftSection={<ClipboardPaste size={16} strokeWidth={1.5} aria-hidden="true" />}
                onClick={pasteSelection}
              >
                {t('pasteEntry')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </div>
      {clipboard.pasteConflict && (
        <DownloadOverwriteModal
          busy={clipboard.pasteConflict.busy}
          conflicts={clipboard.pasteConflict.conflicts}
          confirmLabel={t('overwriteAndPaste')}
          onConfirm={clipboard.confirmPasteConflict}
          onCancel={clipboard.cancelPasteConflict}
        />
      )}
      <DirectoryEntryModals
        dateFormatter={dateFormatter}
        sizeFormatter={sizeFormatter}
        onAuthRequired={onAuthRequired}
        createDirectoryOpened={createDirectoryOpened}
        onCloseCreateDirectory={() => setCreateDirectoryOpened(false)}
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
