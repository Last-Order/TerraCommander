import { VisuallyHidden } from '@mantine/core';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { entryKey, type Entry } from '@shared/storage';
import { useStorageWorkspace } from '../storage-workspace-context';
import { DirectoryContextMenu } from './actions/DirectoryContextMenu';
import { DirectoryUploadDropZone } from './actions/DirectoryUploadDropZone';
import { useDirectoryClipboard } from './actions/useDirectoryClipboard';
import { useDirectoryCommands } from './actions/useDirectoryCommands';
import { useDirectoryContextMenu } from './actions/useDirectoryContextMenu';
import { useDirectoryUpload } from './actions/useDirectoryUpload';
import { useCurrentDirectory } from './current-directory-context';
import { DirectoryStatus } from './DirectoryStatus';
import { DirectoryToolbar } from './DirectoryToolbar';
import { DirectoryEntryModals } from './modals/DirectoryEntryModals';
import { useDirectoryEntryModals } from './modals/useDirectoryEntryModals';
import { DirectorySearch } from './search/DirectorySearch';
import { useDirectorySearch } from './search/useDirectorySearch';
import { buildDirectoryRows } from './state/directory-rows';
import { useDirectorySortStore } from './state/directory-sort';
import { useDirectoryViewStore } from './state/directory-view-context';
import { resolveEntryCapabilities } from './state/entry-capabilities';
import { summarizeSelection } from './state/selection-summary';
import { useDirectoryRenames } from './state/useDirectoryEffects';
import { useDirectoryListing } from './state/useDirectoryListing';
import { useSelectedEntries } from './state/useSelectedEntries';
import { DirectoryTable } from './table/DirectoryTable';
import classes from './DirectoryListing.module.css';

const nonBlankDirectoryTargetSelector = 'tr[data-index], thead, [data-directory-search]';

function isDirectoryBlankTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !target.closest(nonBlankDirectoryTargetSelector);
}

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
  const { t, i18n } = useTranslation('storage');
  const { directoryCache: cache, selectionSummary } = useStorageWorkspace();
  const { ref: parent, provider } = useCurrentDirectory();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const sort = useDirectorySortStore((state) => state.sort);
  const moreButton = useRef<HTMLButtonElement>(null);

  const { entries, phase, snapshot, error, refresh } = useDirectoryListing({
    cacheable,
    version,
  });
  const loading = phase === 'loading' || phase === 'refreshing';
  const loadingWithoutEntries = phase === 'loading' && entries.size === 0;
  const canSort = snapshot !== undefined && !loading;
  const hasError = error !== null;

  const optimisticNames = useDirectoryRenames(parent);

  const rows = useMemo(
    () =>
      buildDirectoryRows(entries, optimisticNames, snapshot ? sort : null, i18n.resolvedLanguage),
    [entries, optimisticNames, snapshot, sort, i18n.resolvedLanguage],
  );

  const viewStore = useDirectoryViewStore();

  useLayoutEffect(() => {
    viewStore.getState().syncListing({
      entries,
      ready: phase === 'ready',
      rows,
    });
  }, [viewStore, entries, phase, rows]);

  useLayoutEffect(
    () =>
      cache.subscribeRenames((change) => {
        if (entryKey(change.parent) !== entryKey(parent)) return;
        viewStore.getState().migrateRename(change.previous.locator, change.entry.ref.locator);
      }),
    [cache, parent, viewStore],
  );

  useEffect(() => {
    if (!scrollElement) return;
    const clearOnBlankClick = (event: MouseEvent) => {
      if (event.ctrlKey || event.shiftKey || event.metaKey) return;
      if (!isDirectoryBlankTarget(event.target)) return;
      viewStore.getState().selectOnly(null);
    };
    scrollElement.addEventListener('click', clearOnBlankClick);
    return () => scrollElement.removeEventListener('click', clearOnBlankClick);
  }, [scrollElement, viewStore]);

  const selectedEntries = useSelectedEntries();

  const selectionStatus = useMemo(() => summarizeSelection(selectedEntries), [selectedEntries]);
  useEffect(() => {
    selectionSummary.getState().setSummary(selectionStatus);
  }, [selectionSummary, selectionStatus]);
  useEffect(
    () => () => {
      selectionSummary.getState().setSummary(null);
    },
    [selectionSummary],
  );

  const capabilities = useMemo(
    () => resolveEntryCapabilities(selectedEntries, provider),
    [selectedEntries, provider],
  );
  const selectForContextMenu = useCallback(
    (locator: string) => viewStore.getState().selectForContextMenu(locator),
    [viewStore],
  );
  const selectAll = useCallback(() => viewStore.getState().selectAll(), [viewStore]);

  const menu = useDirectoryContextMenu({
    entries,
    ready: phase === 'ready',
    selectForContextMenu,
  });

  const modals = useDirectoryEntryModals({
    selectedEntries,
    capabilities,
    menuEntry: menu.menuEntry,
    onOpenModal: menu.closeMenu,
  });
  const upload = useDirectoryUpload({ blocked: loading || error !== null });

  const { closeMenu } = menu;
  const selectSearchMatch = useCallback(
    (locator: string | null) => {
      const state = viewStore.getState();
      state.selectOnly(locator);
      closeMenu();
      if (locator !== null) {
        state.requestViewport({ locator, align: 'center', focus: false });
      }
    },
    [viewStore, closeMenu],
  );
  const selectAllSearchMatches = useCallback(
    (locators: readonly string[], primaryLocator: string | null) => {
      const state = viewStore.getState();
      state.selectMany(locators, primaryLocator);
      closeMenu();
      if (primaryLocator !== null) {
        state.requestViewport({ locator: primaryLocator, align: 'auto', focus: false });
      }
    },
    [viewStore, closeMenu],
  );
  const search = useDirectorySearch({
    rows,
    onOpen: closeMenu,
    onClose: () => moreButton.current?.focus(),
    onMatch: selectSearchMatch,
    onSelectAll: selectAllSearchMatches,
  });
  const clipboard = useDirectoryClipboard({
    blocked: loadingWithoutEntries || error !== null,
  });
  const commands = useDirectoryCommands({
    phase,
    refresh,
    selectAll,
    selectedEntries,
    capabilities,
    menu,
    modals,
    clipboard,
    searchOpened: search.opened,
    onNavigateUp,
  });

  const centeredState = (error && entries.size === 0) || (!error && snapshot?.size === 0);

  return (
    <>
      <DirectoryToolbar actions={commands.blankActions} upload={upload} moreButton={moreButton}>
        {children}
      </DirectoryToolbar>
      {loadingWithoutEntries && (
        <VisuallyHidden>
          <output>{t('loadingDirectory')}</output>
        </VisuallyHidden>
      )}
      <DirectoryUploadDropZone upload={upload}>
        <div
          ref={setScrollElement}
          className={
            centeredState
              ? `${classes.directoryContents} ${classes.centeredState}`
              : classes.directoryContents
          }
          aria-busy={loadingWithoutEntries}
          onContextMenu={(event) => {
            if (!isDirectoryBlankTarget(event.target)) return;
            if (loadingWithoutEntries || error !== null) return;
            event.preventDefault();
            menu.showBlankMenu({ x: event.clientX, y: event.clientY });
          }}
        >
          <DirectorySearch search={search} />
          <DirectoryStatus
            error={entries.size === 0 ? error : null}
            empty={snapshot?.size === 0}
            onRetry={commands.reload}
          />
          {(loadingWithoutEntries || entries.size > 0) && (
            <DirectoryTable
              scrollElement={scrollElement}
              canSort={canSort}
              loadingWithoutEntries={loadingWithoutEntries}
              hasError={hasError}
              interactionBlocked={menu.opened}
              externalDropTargetLocator={upload.dropTargetFolderLocator}
              onContextMenu={menu.showEntryMenu}
              onOpen={onOpen}
            />
          )}
        </div>
      </DirectoryUploadDropZone>
      <DirectoryContextMenu
        menu={menu.activeMenu}
        selectedEntries={selectedEntries}
        capabilities={capabilities}
        entryActions={{
          onCopy: commands.copySelection,
          onCut: commands.cutSelection,
          onDownload: modals.showDownload,
          onRename: modals.showRename,
          onInformation: modals.showInformation,
          onDelete: modals.showDelete,
        }}
        blankActions={commands.blankActions}
        onClose={menu.closeMenu}
      />
      <DirectoryEntryModals
        modal={modals.modal}
        transferConflict={clipboard.pasteConflict ?? upload.transferConflict}
        onClose={modals.closeModal}
      />
    </>
  );
}
