import { Skeleton } from '@mantine/core';
import { ChevronDown, ChevronsUpDown, ChevronUp, type LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import { isDirectoryNavigationKey } from './directory-navigation';
import { useDirectorySortStore } from './directory-sort';
import type {
  DirectoryRevealTarget,
  DirectoryRow,
  DirectorySelectionModifiers,
  DirectorySort,
} from './directory-types';
import { DirectoryEntryRow } from './DirectoryEntryRow';
import type { DirectoryContextMenuPosition } from './useDirectoryContextMenu';
import { useDirectoryVirtualizer } from './useDirectoryVirtualizer';
import classes from './DirectoryTable.module.css';

const entryIconSize = 16;
const sortIcons: Record<DirectorySort['direction'], LucideIcon> = {
  ascending: ChevronUp,
  descending: ChevronDown,
};
const columns = [
  { field: 'name', label: 'entryName', className: undefined },
  { field: 'modifiedAt', label: 'entryModifiedAt', className: classes.entryDate },
  { field: 'size', label: 'entrySize', className: classes.entrySize },
] as const satisfies readonly {
  field: DirectorySort['field'];
  label: string;
  className: string | undefined;
}[];

function DirectorySkeletonRows() {
  return Array.from({ length: 10 }, (_, index) => (
    <tr key={index}>
      <td className={classes.entryName}>
        <div className={classes.entryPlaceholder}>
          <Skeleton style={{ width: entryIconSize, height: entryIconSize, flex: 'none' }} />
          <Skeleton width="min(55%, 14rem)" height="0.75rem" />
        </div>
      </td>
      <td className={classes.entryDate}>
        <Skeleton width="8.5rem" height="0.75rem" />
      </td>
      <td className={classes.entrySize}>
        <Skeleton className={classes.entrySizePlaceholder} width="3rem" height="0.75rem" />
      </td>
    </tr>
  ));
}

interface DirectoryTableProps {
  scrollElement: HTMLDivElement | null;
  rows: readonly DirectoryRow[];
  revealTarget: DirectoryRevealTarget | null;
  canSort: boolean;
  loadingWithoutEntries: boolean;
  navigationBlocked: boolean;
  selectedLocators: ReadonlySet<string>;
  cutLocators: ReadonlySet<string> | undefined;
  onSelect: (locator: string, modifiers: DirectorySelectionModifiers) => void;
  onContextMenu: (entry: Entry, position: DirectoryContextMenuPosition) => void;
  onOpen: (entry: Entry) => void;
}

export function DirectoryTable({
  scrollElement,
  rows,
  revealTarget,
  canSort,
  loadingWithoutEntries,
  navigationBlocked,
  selectedLocators,
  cutLocators,
  onSelect,
  onContextMenu,
  onOpen,
}: DirectoryTableProps) {
  const { t, i18n } = useTranslation('storage');
  const sort = useDirectorySortStore((state) => state.sort);
  const onSort = useDirectorySortStore((state) => state.toggleSort);
  const locale = i18n.resolvedLanguage;
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale],
  );
  const sizeFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale],
  );
  const [tabNavigation, setTabNavigation] = useState(false);
  const { tableRef, enabled, scrollMargin, virtualizer, onFocus, onBlur, onKeyDown } =
    useDirectoryVirtualizer({
      rows,
      scrollElement,
      canSort,
      revealTarget,
      selectedLocators,
      navigationBlocked: navigationBlocked || loadingWithoutEntries,
      onSelect,
    });

  useEffect(() => {
    const document = tableRef.current?.ownerDocument;
    if (!document) return;

    const showTabFocus = (event: KeyboardEvent) => {
      if (
        !event.altKey &&
        !event.metaKey &&
        ((event.key === 'Tab' && !event.ctrlKey) || isDirectoryNavigationKey(event.key))
      ) {
        setTabNavigation(true);
      }
    };
    const hideTabFocus = () => setTabNavigation(false);
    document.addEventListener('keydown', showTabFocus, true);
    document.addEventListener('pointerdown', hideTabFocus, true);
    return () => {
      document.removeEventListener('keydown', showTabFocus, true);
      document.removeEventListener('pointerdown', hideTabFocus, true);
    };
  }, [tableRef]);

  const disabledTitle = t('entryWriteLocked');
  const virtualRows = virtualizer.getVirtualItems();
  const lastRowEnd = (virtualRows.at(-1)?.end ?? scrollMargin) - scrollMargin;
  const paddingBottom = Math.max(0, virtualizer.getTotalSize() - lastRowEnd);
  const renderRow = (row: DirectoryRow, index: number) => (
    <DirectoryEntryRow
      key={row.entry.ref.locator}
      {...row}
      index={index}
      selected={selectedLocators.has(row.entry.ref.locator)}
      cut={cutLocators?.has(row.entry.ref.locator) ?? false}
      disabledTitle={disabledTitle}
      dateFormatter={dateFormatter}
      sizeFormatter={sizeFormatter}
      measure={enabled ? virtualizer.measureElement : undefined}
      onSelect={onSelect}
      onContextMenu={onContextMenu}
      onOpen={onOpen}
    />
  );

  return (
    <table
      ref={tableRef}
      className={classes.entries}
      data-tab-navigation={tabNavigation || undefined}
      aria-label={t('filesAndFolders')}
      aria-rowcount={rows.length + 1}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
      onKeyDownCapture={onKeyDown}
    >
      <thead>
        <tr>
          {columns.map(({ field, label, className }) => {
            const direction = canSort && sort?.field === field ? sort.direction : undefined;
            const Icon = direction ? sortIcons[direction] : ChevronsUpDown;
            return (
              <th key={field} scope="col" className={className} aria-sort={direction}>
                {canSort ? (
                  <button
                    type="button"
                    className={classes.sortHeader}
                    onClick={() => onSort(field)}
                  >
                    {t(label)}
                    <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                ) : (
                  <span className={classes.columnLabel}>{t(label)}</span>
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody
        aria-hidden={loadingWithoutEntries || undefined}
        className={loadingWithoutEntries ? classes.placeholderRows : undefined}
      >
        {loadingWithoutEntries && <DirectorySkeletonRows />}
        {enabled
          ? virtualRows.map((virtualRow, index) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              const gap = virtualRow.start - (virtualRows[index - 1]?.end ?? scrollMargin);
              return (
                <Fragment key={row.entry.ref.locator}>
                  {gap > 0 && <DirectorySpacer height={gap} />}
                  {renderRow(row, virtualRow.index)}
                </Fragment>
              );
            })
          : rows.map(renderRow)}
        {enabled && paddingBottom > 0 && <DirectorySpacer height={paddingBottom} />}
      </tbody>
    </table>
  );
}

function DirectorySpacer({ height }: { height: number }) {
  return (
    <tr aria-hidden="true">
      <td
        aria-hidden="true"
        colSpan={columns.length}
        className={classes.spacer}
        style={{ height }}
      />
    </tr>
  );
}
