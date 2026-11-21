import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Menu, VisuallyHidden } from '@mantine/core';
import { Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { Entry } from '@shared/storage';
import { useStorageWorkspace } from '../storage-workspace-context';
import { selectPendingEntryEffects } from '../tasks/pending-entry-effects';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import { useCurrentDirectory } from './current-directory-context';
import { buildDirectoryRows } from './directory-rows';
import { useDirectorySortStore } from './directory-sort';
import { DirectoryBlankMenu } from './DirectoryBlankMenu';
import { DirectoryEntryMenu } from './DirectoryEntryMenu';
import classes from './DirectoryListing.module.css';
import { DirectorySearch } from './DirectorySearch';
import { DirectoryStatus } from './DirectoryStatus';
import { DirectoryTable } from './DirectoryTable';
import { DirectoryToolbar } from './DirectoryToolbar';
import { resolveEntryCapabilities } from './entry-capabilities';
import { DirectoryEntryModals } from './modals/DirectoryEntryModals';
import { useDirectoryClipboard } from './useDirectoryClipboard';
import { useDirectoryCommands } from './useDirectoryCommands';
import { useDirectoryContextMenu } from './useDirectoryContextMenu';
import { useDirectoryEntryModals } from './useDirectoryEntryModals';
import { useDirectoryListing } from './useDirectoryListing';
import { useDirectorySearch } from './useDirectorySearch';
import { useDirectorySelection } from './useDirectorySelection';
import { useDirectoryUpload } from './useDirectoryUpload';

interface ListingProps {
  cacheable: boolean;
  version: number;
  onOpen: (entry: Entry) => void;
  onNavigateUp?: (() => void) | undefined;
  children: ReactNode;
}

export function DirectoryListing({
  cacheable,
  version,
  onOpen,
  onNavigateUp,
  children,
}: ListingProps) {
  const { t, i18n } = useTranslation(['storage', 'errors']);
  const { directoryCache: cache, onAuthRequired, reauthorize } = useStorageWorkspace();
  const { ref: parent, canCreateDirectory } = useCurrentDirectory();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const sort = useDirectorySortStore((state) => state.sort);
  const changeSort = useDirectorySortStore((state) => state.toggleSort);
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

  const rows = useMemo(
    () =>
      buildDirectoryRows(entries, pendingEntries, snapshot ? sort : null, i18n.resolvedLanguage),
    [entries, pendingEntries, snapshot, sort, i18n.resolvedLanguage],
  );

  const { selectedLocators, selectEntry, selectAll, selectOnly, selectForContextMenu } =
    useDirectorySelection({
      rows,
      completedEntries: phase === 'ready' ? entries : undefined,
      cache,
      parent,
      scrollElement,
    });
  const capabilities = useMemo(
    () => resolveEntryCapabilities(entries, selectedLocators, pendingEntries),
    [entries, selectedLocators, pendingEntries],
  );
  const menu = useDirectoryContextMenu({
    entries,
    phase,
    selectForContextMenu,
  });
  const modals = useDirectoryEntryModals({
    entries,
    selectedLocators,
    capabilities,
    menuEntry: menu.menuEntry,
    onOpenModal: menu.closeMenu,
  });
  const upload = useDirectoryUpload({
    blocked: loading || error !== null,
    onAuthRequired,
  });

  const { closeMenu } = menu;
  const selectSearchMatch = useCallback(
    (locator: string | null) => {
      selectOnly(locator);
      closeMenu();
    },
    [selectOnly, closeMenu],
  );
  const search = useDirectorySearch(rows, selectSearchMatch);
  const clipboard = useDirectoryClipboard({
    blocked: loadingWithoutEntries || error !== null,
    onAuthRequired,
  });
  const commands = useDirectoryCommands({
    phase,
    loading,
    hasError: error !== null,
    canCreateDirectory,
    refresh,
    selectAll,
    capabilities,
    menu,
    modals,
    clipboard,
    search,
    searchInput,
    refreshButton,
    onNavigateUp,
  });

  const centeredState = (error && entries.size === 0) || (!error && snapshot?.size === 0);
  const pasteConflict = clipboard.pasteConflict
    ? {
        busy: clipboard.pasteConflict.busy,
        conflicts: clipboard.pasteConflict.conflicts,
        onConfirm: clipboard.confirmPasteConflict,
        onCancel: clipboard.cancelPasteConflict,
      }
    : null;

  return (
    <>
      <DirectoryToolbar
        createDirectoryDisabled={!commands.createDirectoryEnabled}
        uploadDisabled={upload.disabled}
        refreshDisabled={loading}
        refreshButton={refreshButton}
        onCreateDirectory={commands.openCreateDirectory}
        onUploadFile={() => void upload.uploadFile()}
        onUploadFolder={() => void upload.uploadFolder()}
        onRefresh={commands.reload}
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
            menu.showBlankMenu({ x: event.clientX, y: event.clientY });
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
            onClose={commands.closeSearch}
          />
          <DirectoryStatus
            error={error}
            empty={snapshot?.size === 0}
            onReauthorize={() => reauthorize(parent.connectionId)}
            onRetry={commands.reload}
          />
          {(loadingWithoutEntries || entries.size > 0) && (
            <Menu
              opened={menu.entryMenuOpened}
              onChange={(opened) => {
                if (!opened) menu.closeMenu();
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
                navigationBlocked={menu.anyMenuOpened}
                selectedLocators={selectedLocators}
                cutLocators={clipboard.cutLocators}
                onSort={changeSort}
                onSelect={selectEntry}
                onContextMenu={menu.showEntryMenu}
                onOpen={onOpen}
              />
              <DirectoryEntryMenu
                canCopy={capabilities.canCopy}
                canCut={capabilities.canCut}
                canDownload={capabilities.canDownload}
                canRename={capabilities.canRename}
                renamePending={capabilities.renamePending}
                canDelete={capabilities.canDelete}
                selectionBusy={capabilities.selectionBusy}
                onCopy={commands.copySelection}
                onCut={commands.cutSelection}
                onDownload={modals.showDownload}
                onRename={modals.showRename}
                onInformation={modals.showInformation}
                onDelete={modals.showDelete}
              />
            </Menu>
          )}
          <DirectoryBlankMenu
            position={menu.blankMenuPosition}
            canCreateDirectory={canCreateDirectory}
            createDirectoryEnabled={commands.createDirectoryEnabled}
            canPaste={clipboard.canPaste}
            onCreateDirectory={commands.openCreateDirectory}
            onPaste={commands.pasteSelection}
            onClose={menu.closeMenu}
          />
        </div>
      </div>
      <DirectoryEntryModals
        modal={modals.modal}
        pasteConflict={pasteConflict}
        onClose={modals.closeModal}
      />
    </>
  );
}
