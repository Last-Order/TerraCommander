import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu, VisuallyHidden } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ClipboardPaste, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { Capabilities, Entry, EntryRef } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import { useKeyboardShortcuts } from '@renderer/shortcuts/useKeyboardShortcuts';
import { errorKey, StorageBrowserError } from '../storage-client';
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
import { DownloadOverwriteModal } from './modals/DownloadOverwriteModal';
import type { StorageClipboard } from './storage-clipboard';
import { useDirectoryEntryActions } from './useDirectoryEntryActions';
import { useDirectoryListing } from './useDirectoryListing';
import { useDirectorySearch } from './useDirectorySearch';
import { useDirectorySelection } from './useDirectorySelection';
import { useDirectoryUpload } from './useDirectoryUpload';

const selectAllLoadingNotification = 'directory-select-all-loading';
const copyEntriesNotification = 'directory-copy-entries';
const pasteStatusNotification = 'directory-paste-status';

interface ListingProps {
  parent: EntryRef;
  cache: DirectoryCache;
  cacheable: boolean;
  version: number;
  directoryPath: string;
  canUpload: boolean;
  canUploadFolder: boolean;
  targetCapabilities?: Capabilities | undefined;
  targetAncestors: readonly EntryRef[];
  clipboard: StorageClipboard | null;
  onCopy: (clipboard: StorageClipboard) => void;
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
  targetCapabilities,
  targetAncestors,
  clipboard,
  onCopy,
  onOpen,
  onAuthRequired,
  onReauthorize,
  children,
}: ListingProps) {
  const { t, i18n } = useTranslation(['storage', 'errors']);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [sort, setSort] = useState<DirectorySort | null>(null);
  const [blankMenuPosition, setBlankMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const [pasteConflict, setPasteConflict] = useState<{
    confirmationId: string;
    conflicts?: readonly string[] | undefined;
    busy: boolean;
  } | null>(null);
  const pasteConflictIdRef = useRef<string | null>(null);
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
  useEffect(() => {
    pasteConflictIdRef.current = pasteConflict?.confirmationId ?? null;
  }, [pasteConflict]);
  useEffect(() => {
    return () => {
      const pendingId = pasteConflictIdRef.current;
      if (pendingId !== null) {
        pasteConflictIdRef.current = null;
        void queue.cancelDownloadConfirmation(pendingId).catch(() => {});
      }
    };
  }, [queue]);
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

  const canPaste =
    clipboard !== null && clipboard.entries.length > 0 && !loadingWithoutEntries && error === null;

  const copySelection = () => {
    if (!actions.canCopy) return;
    actions.closeMenu();
    setBlankMenuPosition(null);
    onCopy({
      sourceParent: parent,
      sourceDirectoryPath: directoryPath,
      entries: actions.selectedEntries,
    });
    notifications.show({
      id: copyEntriesNotification,
      color: 'blue',
      message:
        actions.selectedEntries.length === 1
          ? t('copiedEntryNotice', { name: actions.selectedEntries[0]!.name })
          : t('copiedEntriesNotice', { count: actions.selectedEntries.length }),
    });
  };

  const pasteSelection = async () => {
    setBlankMenuPosition(null);
    if (!clipboard || clipboard.entries.length === 0 || loadingWithoutEntries || error !== null) {
      return;
    }
    const sourceConnectionId = clipboard.sourceParent.connectionId;
    const targetConnectionId = parent.connectionId;
    if (
      sourceConnectionId !== localConnectionId &&
      targetConnectionId !== localConnectionId &&
      sourceConnectionId !== targetConnectionId
    ) {
      notifications.show({
        id: pasteStatusNotification,
        color: 'yellow',
        message: t('crossSourcePasteUnsupported'),
      });
      return;
    }
    if (
      clipboard.entries.some(
        (entry) =>
          entry.kind === 'directory' &&
          targetAncestors.some(
            (ancestor) =>
              ancestor.connectionId === entry.ref.connectionId &&
              ancestor.spaceId === entry.ref.spaceId &&
              ancestor.locator === entry.ref.locator,
          ),
      )
    ) {
      notifications.show({
        id: pasteStatusNotification,
        color: 'red',
        message: t('pasteSelfContainmentError'),
      });
      return;
    }
    if (targetConnectionId !== localConnectionId) {
      if (targetCapabilities?.write?.support === 'unsupported') {
        notifications.show({
          id: pasteStatusNotification,
          color: 'red',
          message: t('errors:permissionDenied'),
        });
        return;
      }
      if (
        clipboard.entries.some((entry) => entry.kind === 'directory') &&
        targetCapabilities?.createDirectory?.support === 'unsupported'
      ) {
        notifications.show({
          id: pasteStatusNotification,
          color: 'red',
          message: t('errors:unsupported'),
        });
        return;
      }
    }

    try {
      const response = await queue.pasteEntries({
        sourceParent: clipboard.sourceParent,
        sourceDirectoryPath: clipboard.sourceDirectoryPath,
        entries: clipboard.entries,
        targetParent: parent,
        targetDirectoryPath: directoryPath,
      });
      if (response.status === 'conflict') {
        setPasteConflict({
          confirmationId: response.confirmationId,
          conflicts: response.conflicts,
          busy: false,
        });
      }
    } catch (caught) {
      if (caught instanceof StorageBrowserError) {
        if (caught.code === 'AuthRequired') {
          onAuthRequired();
          return;
        }
        const message =
          caught.code === 'Unsupported'
            ? t('crossSourcePasteUnsupported')
            : t(`errors:${errorKey(caught)}`);
        notifications.show({ id: pasteStatusNotification, color: 'red', message });
        return;
      }
      notifications.show({
        id: pasteStatusNotification,
        color: 'red',
        message: t(`errors:${errorKey(caught)}`),
      });
    }
  };

  useKeyboardShortcuts([
    {
      key: 'c',
      ctrlKey: true,
      onTrigger: copySelection,
      enabled: actions.canCopy,
    },
    {
      key: 'v',
      ctrlKey: true,
      onTrigger: () => void pasteSelection(),
      enabled: canPaste,
    },
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
                canCopy={actions.canCopy}
                canDownload={actions.canDownload}
                downloadPending={actions.downloadPending}
                canRename={actions.canRename}
                renamePending={actions.renamePending}
                canDelete={actions.canDelete}
                deletePending={actions.deletePending}
                onCopy={copySelection}
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
              <Menu.Item
                disabled={!canPaste}
                aria-keyshortcuts="Control+V"
                leftSection={<ClipboardPaste size={16} strokeWidth={1.5} aria-hidden="true" />}
                onClick={() => void pasteSelection()}
              >
                {t('pasteEntry')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </div>
      {pasteConflict && (
        <DownloadOverwriteModal
          busy={pasteConflict.busy}
          conflicts={pasteConflict.conflicts}
          confirmLabel={t('overwriteAndPaste')}
          onConfirm={() => {
            setPasteConflict((current) => (current ? { ...current, busy: true } : null));
            void queue
              .confirmDownload(pasteConflict.confirmationId)
              .catch((caught) => {
                if (caught instanceof StorageBrowserError && caught.code === 'AuthRequired') {
                  onAuthRequired();
                } else {
                  notifications.show({
                    id: pasteStatusNotification,
                    color: 'red',
                    message: t(`errors:${errorKey(caught)}`),
                  });
                }
              })
              .finally(() => setPasteConflict(null));
          }}
          onCancel={() => {
            const id = pasteConflict.confirmationId;
            setPasteConflict(null);
            void queue.cancelDownloadConfirmation(id).catch(() => {});
          }}
        />
      )}
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
