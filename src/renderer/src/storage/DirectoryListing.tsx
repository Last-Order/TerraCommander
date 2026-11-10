import { useMemo, useState, type ReactNode } from 'react';
import { ActionIcon, Alert, Button, Group, Menu, VisuallyHidden } from '@mantine/core';
import { Info, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Entry, EntryRef } from '../../../shared/storage';
import { DirectoryTable, type DirectoryRow, type DirectorySort } from './DirectoryTable';
import { EntryInformationModal, type EntrySelection } from './EntryInformationModal';
import type { DirectoryCache } from './directory-cache';
import { useDirectoryListing } from './useDirectoryListing';
import classes from './StorageWorkspace.module.css';

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
  const [selectedLocators, setSelectedLocators] = useState(() => new Set<string>());
  const [menuLocator, setMenuLocator] = useState<string | null>(null);
  const [informationEntries, setInformationEntries] = useState<EntrySelection | null>(null);
  const [sort, setSort] = useState<DirectorySort | null>(null);
  const { entries, phase, snapshot, error, refresh } = useDirectoryListing({
    parent,
    cache,
    cacheable,
    version,
    onAuthRequired,
  });
  const loading = phase === 'loading' || phase === 'refreshing';
  const loadingWithoutEntries = phase === 'loading' && entries.size === 0;
  const menuEntry = menuLocator === null ? undefined : entries.get(menuLocator);

  if (phase === 'ready' && selectedLocators.size > 0) {
    const remaining = [...selectedLocators].filter((locator) => entries.has(locator));
    if (remaining.length < selectedLocators.size) setSelectedLocators(new Set(remaining));
  }
  if (phase === 'ready' && menuLocator !== null && !menuEntry) setMenuLocator(null);

  const locale = i18n.resolvedLanguage;
  const rows = useMemo(() => {
    const rows = Array.from(entries.values(), (entry): DirectoryRow => {
      const modifiedAt = Date.parse(entry.modifiedAt ?? '');
      return {
        entry,
        modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : undefined,
        size: entry.kind === 'directory' ? undefined : entry.size,
      };
    });
    if (sort && snapshot) sortRows(rows, sort, locale);
    return rows;
  }, [entries, sort, snapshot, locale]);

  const selectEntry = (locator: string, toggle: boolean) => {
    setSelectedLocators((previous) => {
      if (!toggle) return new Set([locator]);

      const next = new Set(previous);
      if (next.has(locator)) next.delete(locator);
      else next.add(locator);
      return next;
    });
  };
  const showEntryMenu = ({ ref: { locator } }: Entry) => {
    if (!selectedLocators.has(locator)) selectEntry(locator, false);
    setMenuLocator(locator);
  };
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
  const changeSort = (field: DirectorySort['field']) =>
    setSort((previous) => ({
      field,
      direction:
        previous?.field === field && previous.direction === 'ascending'
          ? 'descending'
          : 'ascending',
    }));
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const sizeFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });

  return (
    <>
      <header className={classes.directoryHeader}>
        {children}
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={t('refreshDirectory')}
          disabled={loading}
          onClick={reload}
        >
          <RefreshCw size={16} aria-hidden="true" />
        </ActionIcon>
      </header>
      {loadingWithoutEntries && (
        <VisuallyHidden>
          <output>{t('loadingDirectory')}</output>
        </VisuallyHidden>
      )}
      <div className={classes.directoryContents} aria-busy={loadingWithoutEntries}>
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
              rows={rows}
              sort={sort}
              canSort={snapshot !== undefined && !loading}
              loadingWithoutEntries={loadingWithoutEntries}
              selectedLocators={selectedLocators}
              dateFormatter={dateFormatter}
              sizeFormatter={sizeFormatter}
              onSort={changeSort}
              onSelect={selectEntry}
              onContextMenu={showEntryMenu}
              onOpen={onOpen}
            />
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<Info size={16} aria-hidden="true" />}
                onClick={showInformation}
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
