import { VisuallyHidden } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import { useStorageWorkspace } from '../storage-workspace-context';
import { useCurrentDirectory } from './current-directory-context';
import { isDirectoryBlankTarget } from './directory-blank-target';
import { buildDirectoryRows, indexDirectoryRows } from './directory-rows';
import { useDirectorySortStore } from './directory-sort';
import { DirectoryContextMenu } from './DirectoryContextMenu';
import { DirectoryDropZone } from './DirectoryDropZone';
import { DirectorySearch } from './DirectorySearch';
import { DirectoryStatus } from './DirectoryStatus';
import { DirectoryTable } from './DirectoryTable';
import { DirectoryToolbar } from './DirectoryToolbar';
import { resolveEntryCapabilities } from './entry-capabilities';
import { DirectoryEntryModals } from './modals/DirectoryEntryModals';
import { summarizeSelection } from './selection-summary';
import { useDirectoryClipboard } from './useDirectoryClipboard';
import { useDirectoryCommands } from './useDirectoryCommands';
import { useDirectoryContextMenu } from './useDirectoryContextMenu';
import { useDirectoryDrag } from './useDirectoryDrag';
import { useDirectoryRenames } from './useDirectoryEffects';
import { useDirectoryEntryModals } from './useDirectoryEntryModals';
import { useDirectoryListing } from './useDirectoryListing';
import { useDirectorySearch } from './useDirectorySearch';
import { useDirectorySelection } from './useDirectorySelection';
import { useDirectoryUpload } from './useDirectoryUpload';
import { useDirectoryViewportCommand } from './useDirectoryViewportCommand';
import classes from './DirectoryListing.module.css';

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
  const { selectionSummary } = useStorageWorkspace();
  const { ref: parent } = useCurrentDirectory();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const sort = useDirectorySortStore((state) => state.sort);
  const moreButton = useRef<HTMLButtonElement>(null);

  const { entries, phase, snapshot, error, refresh } = useDirectoryListing({
    cacheable,
    version,
  });
  const loading = phase === 'loading' || phase === 'refreshing';
  const loadingWithoutEntries = phase === 'loading' && entries.size === 0;

  const optimisticNames = useDirectoryRenames(parent);

  const rows = useMemo(
    () =>
      buildDirectoryRows(entries, optimisticNames, snapshot ? sort : null, i18n.resolvedLanguage),
    [entries, optimisticNames, snapshot, sort, i18n.resolvedLanguage],
  );
  const rowIndexByLocator = useMemo(() => indexDirectoryRows(rows), [rows]);

  const {
    selectedLocators,
    activeLocator,
    selectedEntries,
    selectEntry,
    selectAll,
    selectOnly,
    selectForContextMenu,
    setActiveLocator,
  } = useDirectorySelection({
    entries,
    ready: phase === 'ready',
    rows,
    rowIndexByLocator,
    scrollElement,
  });
  const viewport = useDirectoryViewportCommand();
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
  const capabilities = useMemo(() => resolveEntryCapabilities(selectedEntries), [selectedEntries]);
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
  const { request: requestViewport } = viewport;
  const selectSearchMatch = useCallback(
    (locator: string | null) => {
      selectOnly(locator);
      closeMenu();
      if (locator !== null) {
        requestViewport({ locator, align: 'center', focus: false });
      }
    },
    [selectOnly, closeMenu, requestViewport],
  );
  const search = useDirectorySearch(rows, selectSearchMatch);
  const clipboard = useDirectoryClipboard({
    blocked: loadingWithoutEntries || error !== null,
  });
  const drag = useDirectoryDrag({
    rows,
    selectedLocators,
    selectedEntries,
    selectOnly,
    blocked: loadingWithoutEntries || error !== null || menu.opened,
  });
  const pinnedLocators = useMemo(() => {
    const pinned: string[] = [];
    if (activeLocator !== null) pinned.push(activeLocator);
    if (viewport.command !== null) pinned.push(viewport.command.locator);
    if (drag.draggingAnchorLocator !== null) pinned.push(drag.draggingAnchorLocator);
    return pinned;
  }, [activeLocator, viewport.command, drag.draggingAnchorLocator]);
  const commands = useDirectoryCommands({
    phase,
    refresh,
    selectAll,
    selectedEntries,
    capabilities,
    menu,
    modals,
    clipboard,
    search,
    moreButton,
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
      <DirectoryDropZone upload={upload}>
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
          <DirectorySearch search={search} onClose={commands.closeSearch} />
          <DirectoryStatus
            error={entries.size === 0 ? error : null}
            empty={snapshot?.size === 0}
            onRetry={commands.reload}
          />
          {(loadingWithoutEntries || entries.size > 0) && (
            <DirectoryTable
              scrollElement={scrollElement}
              rows={rows}
              rowIndexByLocator={rowIndexByLocator}
              pinnedLocators={pinnedLocators}
              viewportCommand={viewport.command}
              canSort={snapshot !== undefined && !loading}
              loadingWithoutEntries={loadingWithoutEntries}
              navigationBlocked={menu.opened}
              selectedLocators={selectedLocators}
              activeLocator={activeLocator}
              cutLocators={clipboard.cutLocators}
              drag={drag}
              onSelect={selectEntry}
              onActiveChange={setActiveLocator}
              onRequestViewport={viewport.request}
              onViewportCommandHandled={viewport.clear}
              onContextMenu={menu.showEntryMenu}
              onOpen={onOpen}
            />
          )}
        </div>
      </DirectoryDropZone>
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
        pasteConflict={clipboard.pasteConflict}
        onClose={modals.closeModal}
      />
    </>
  );
}
