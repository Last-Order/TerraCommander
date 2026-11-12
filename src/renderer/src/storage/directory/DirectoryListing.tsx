import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Button, Group, Menu, VisuallyHidden } from '@mantine/core';
import { Info, RefreshCw, SquarePen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStore } from 'zustand';
import type { Entry, EntryRef } from '../../../../shared/storage';
import { useKeyboardShortcuts } from '../../shortcuts/useKeyboardShortcuts';
import classes from './DirectoryListing.module.css';
import {
  DirectoryTable,
  type DirectoryRow,
  type DirectorySelectionModifiers,
  type DirectorySort,
} from './DirectoryTable';
import { EntryInformationModal, type EntrySelection } from './EntryInformationModal';
import { EntryRenameModal } from './EntryRenameModal';
import type { DirectoryCache } from './directory-cache';
import { useDirectoryListing } from './useDirectoryListing';
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
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const [selectedLocators, setSelectedLocators] = useState(() => new Set<string>());
  const selectionAnchor = useRef<string | null>(null);
  const [menuLocator, setMenuLocator] = useState<string | null>(null);
  const [informationEntries, setInformationEntries] = useState<EntrySelection | null>(null);
  const [renameEntry, setRenameEntry] = useState<Entry | null>(null);
  const [sort, setSort] = useState<DirectorySort | null>(null);
  const onEntryRenamed = useCallback((previous: string, locator: string) => {
    if (selectionAnchor.current === previous) selectionAnchor.current = locator;
    setSelectedLocators((selection) => {
      if (!selection.has(previous)) return selection;
      const updated = new Set(selection);
      updated.delete(previous);
      updated.add(locator);
      return updated;
    });
  }, []);
  const { entries, phase, snapshot, error, refresh } = useDirectoryListing({
    parent,
    cache,
    cacheable,
    version,
    onAuthRequired,
    onEntryRenamed,
  });
  const queue = useStorageTaskQueue();
  const tasks = useStore(queue.store, (state) => state.tasks);
  const pendingEntries = useMemo(() => selectPendingEntryEffects(tasks, parent), [tasks, parent]);
  const menuEntryPending = menuLocator !== null && pendingEntries.get(menuLocator)?.busy === true;
  const loading = phase === 'loading' || phase === 'refreshing';
  const loadingWithoutEntries = phase === 'loading' && entries.size === 0;
  const menuEntry = menuLocator === null ? undefined : entries.get(menuLocator);

  useEffect(() => {
    if (
      phase === 'ready' &&
      selectionAnchor.current !== null &&
      !entries.has(selectionAnchor.current)
    ) {
      selectionAnchor.current = null;
    }
  }, [entries, phase]);

  if (phase === 'ready' && selectedLocators.size > 0) {
    const remaining = [...selectedLocators].filter((locator) => entries.has(locator));
    if (remaining.length < selectedLocators.size) setSelectedLocators(new Set(remaining));
  }
  if (phase === 'ready' && menuLocator !== null && !menuEntry) setMenuLocator(null);

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

  const selectEntry = useCallback(
    (locator: string, { toggle, range }: DirectorySelectionModifiers) => {
      const anchor = selectionAnchor.current;
      const start = range ? rows.findIndex(({ entry }) => entry.ref.locator === anchor) : -1;
      const end = rows.findIndex(({ entry }) => entry.ref.locator === locator);
      if (end < 0) return;
      if (start < 0) selectionAnchor.current = locator;

      setSelectedLocators((previous) => {
        if (start >= 0) {
          const next = toggle ? new Set(previous) : new Set<string>();
          for (const { entry } of rows.slice(Math.min(start, end), Math.max(start, end) + 1)) {
            next.add(entry.ref.locator);
          }
          return next;
        }
        if (!toggle) return new Set([locator]);

        const next = new Set(previous);
        if (!range && next.has(locator)) next.delete(locator);
        else next.add(locator);
        return next;
      });
    },
    [rows],
  );
  const selectAll = useCallback(() => {
    if (!rows.some(({ entry }) => entry.ref.locator === selectionAnchor.current)) {
      selectionAnchor.current = rows[0]?.entry.ref.locator ?? null;
    }
    setSelectedLocators(new Set(rows.map(({ entry }) => entry.ref.locator)));
  }, [rows]);
  const showEntryMenu = useCallback(({ ref: { locator } }: Entry) => {
    selectionAnchor.current = locator;
    setSelectedLocators((previous) => (previous.has(locator) ? previous : new Set([locator])));
    setMenuLocator(locator);
  }, []);
  const showInformation = () => {
    if (!menuEntry) return;
    const selection: EntrySelection = [menuEntry];
    for (const locator of selectedLocators) {
      const entry = entries.get(locator);
      if (entry && entry !== menuEntry) selection.push(entry);
    }
    setInformationEntries(selection);
  };
  const reload = () => {
    setMenuLocator(null);
    refresh();
  };
  useKeyboardShortcuts([
    { key: 'F5', onTrigger: reload, enabled: !loading, allowInEditable: true },
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
      <div
        ref={setScrollElement}
        className={classes.directoryContents}
        aria-busy={loadingWithoutEntries}
      >
        {error && (
          <Alert color="red" role="alert">
            <Group justify="space-between">
              {t(`errors:${error}`)}
              <Button variant="subtle" size="compact-sm" onClick={reload}>
                {t('common:retry')}
              </Button>
            </Group>
          </Alert>
        )}
        {snapshot?.size === 0 && <p className={classes.directoryStatus}>{t('emptyDirectory')}</p>}
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
              {selectedLocators.size === 1 &&
                menuEntry &&
                menuEntry.capabilities.rename?.support !== 'unsupported' && (
                  <Menu.Item
                    disabled={menuEntryPending}
                    leftSection={<SquarePen size={16} strokeWidth={1.5} aria-hidden="true" />}
                    onClick={() => setRenameEntry(menuEntry)}
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
            </Menu.Dropdown>
          </Menu>
        )}
      </div>
      {renameEntry && (
        <EntryRenameModal
          entry={renameEntry}
          parent={parent}
          directoryPath={directoryPath}
          onClose={() => setRenameEntry(null)}
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
