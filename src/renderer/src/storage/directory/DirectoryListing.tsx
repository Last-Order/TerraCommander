import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Button, Menu, Transition, VisuallyHidden } from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { CircleAlert, Info, RefreshCw, SquarePen, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { Entry, EntryRef } from '../../../../shared/storage';
import { useKeyboardShortcuts } from '../../shortcuts/useKeyboardShortcuts';
import classes from './DirectoryListing.module.css';
import { DirectorySearch } from './DirectorySearch';
import { DirectoryTable } from './DirectoryTable';
import type { DirectoryRow, DirectorySort } from './directory-types';
import { EntryInformationModal, type EntrySelection } from './EntryInformationModal';
import { EntryRenameModal } from './EntryRenameModal';
import { EntryDeleteModal } from './EntryDeleteModal';
import { canDeleteEntry } from './entry-deletion';
import type { DirectoryCache } from './directory-cache';
import { useDirectoryListing } from './useDirectoryListing';
import { useDirectorySearch } from './useDirectorySearch';
import { useDirectorySelection } from './useDirectorySelection';
import { useStorageTaskQueue } from '../tasks/storage-task-queue-context';
import { selectPendingEntryEffects } from '../tasks/pending-entry-effects';

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
  onOpen,
  onAuthRequired,
  children,
}: ListingProps) {
  const { t, i18n } = useTranslation(['storage', 'common', 'errors']);
  const reduceMotion = useReducedMotion();
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [menuLocator, setMenuLocator] = useState<string | null>(null);
  const [informationEntries, setInformationEntries] = useState<EntrySelection | null>(null);
  const [renameEntry, setRenameEntry] = useState<Entry | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<Entry | null>(null);
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
  const queue = useStorageTaskQueue();
  const tasks = useStore(queue.store, (state) => state.tasks);
  const pendingEntries = useMemo(() => selectPendingEntryEffects(tasks, parent), [tasks, parent]);
  const loading = phase === 'loading' || phase === 'refreshing';
  const loadingWithoutEntries = phase === 'loading' && entries.size === 0;
  const menuEntry = menuLocator === null ? undefined : entries.get(menuLocator);

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
  const [selectedLocator] = selectedLocators;
  const selectedEntry =
    selectedLocators.size === 1 && selectedLocator !== undefined
      ? entries.get(selectedLocator)
      : undefined;
  const renamableEntry =
    selectedEntry?.capabilities.rename?.support !== 'unsupported' ? selectedEntry : undefined;
  const renamePending =
    renamableEntry !== undefined && pendingEntries.get(renamableEntry.ref.locator)?.busy === true;
  const deletableEntry = canDeleteEntry(selectedEntry) ? selectedEntry : undefined;
  const deletePending =
    deletableEntry !== undefined && pendingEntries.get(deletableEntry.ref.locator)?.busy === true;
  const selectSearchMatch = useCallback(
    (locator: string | null) => {
      selectOnly(locator);
      setMenuLocator(null);
    },
    [selectOnly],
  );
  const search = useDirectorySearch(rows, selectSearchMatch);

  if (phase === 'ready' && menuLocator !== null && !menuEntry) setMenuLocator(null);

  const showEntryMenu = useCallback(
    ({ ref: { locator } }: Entry) => {
      selectForContextMenu(locator);
      setMenuLocator(locator);
    },
    [selectForContextMenu],
  );
  const showInformation = () => {
    if (!menuEntry) return;
    const selection: EntrySelection = [menuEntry];
    for (const locator of selectedLocators) {
      const entry = entries.get(locator);
      if (entry && entry !== menuEntry) selection.push(entry);
    }
    setInformationEntries(selection);
  };
  const showRename = () => {
    if (!renamableEntry || renamePending) return;
    setMenuLocator(null);
    setRenameEntry(renamableEntry);
  };
  const reload = () => {
    setMenuLocator(null);
    refresh();
  };
  const showDelete = () => {
    if (!deletableEntry || deletePending) return;
    setMenuLocator(null);
    setDeleteEntry(deletableEntry);
  };
  const openSearch = () => {
    setMenuLocator(null);
    search.open();
    searchInput.current?.focus();
    searchInput.current?.select();
  };
  const closeSearch = () => {
    search.close();
    refreshButton.current?.focus();
  };
  useKeyboardShortcuts([
    { key: 'F2', onTrigger: showRename, enabled: !!renamableEntry && !renamePending },
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
      </header>
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
              opened={menuEntry !== undefined}
              onChange={(opened) => {
                if (!opened) setMenuLocator(null);
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
                onContextMenu={showEntryMenu}
                onOpen={onOpen}
              />
              <Menu.Dropdown>
                {renamableEntry && (
                  <Menu.Item
                    disabled={renamePending}
                    aria-keyshortcuts="F2"
                    leftSection={<SquarePen size={16} strokeWidth={1.5} aria-hidden="true" />}
                    onClick={showRename}
                  >
                    {t('renameEntry')}
                  </Menu.Item>
                )}
                <Menu.Item
                  leftSection={<Info size={16} strokeWidth={1.5} aria-hidden="true" />}
                  onClick={showInformation}
                >
                  {t('entryInformation')}
                </Menu.Item>
                {deletableEntry && (
                  <>
                    <Menu.Divider />
                    <Menu.Item
                      color="red"
                      disabled={deletePending}
                      leftSection={<Trash2 size={16} strokeWidth={1.5} aria-hidden="true" />}
                      onClick={showDelete}
                    >
                      {t('deleteEntry')}
                    </Menu.Item>
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          )}
        </div>
      </div>
      {renameEntry && (
        <EntryRenameModal
          entry={renameEntry}
          parent={parent}
          directoryPath={directoryPath}
          onClose={() => setRenameEntry(null)}
        />
      )}
      {deleteEntry && (
        <EntryDeleteModal
          entry={deleteEntry}
          parent={parent}
          directoryPath={directoryPath}
          onClose={() => setDeleteEntry(null)}
        />
      )}
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
