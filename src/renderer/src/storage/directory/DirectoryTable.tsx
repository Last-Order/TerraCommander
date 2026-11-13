import { Fragment, useEffect, useState } from 'react';
import { Menu, Skeleton } from '@mantine/core';
import { ChevronDown, ChevronsUpDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '../../../../shared/storage';
import classes from './DirectoryTable.module.css';
import { DirectoryEntryRow } from './DirectoryEntryRow';
import { useDirectoryVirtualizer } from './useDirectoryVirtualizer';
import type {
  DirectoryRevealTarget,
  DirectoryRow,
  DirectorySelectionModifiers,
  DirectorySort,
} from './directory-types';

const entryIconSize = 16;
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
  revealTarget?: DirectoryRevealTarget | null;
  sort: DirectorySort | null;
  canSort: boolean;
  loadingWithoutEntries: boolean;
  selectedLocators: ReadonlySet<string>;
  dateFormatter: Intl.DateTimeFormat;
  sizeFormatter: Intl.NumberFormat;
  onSort: (field: DirectorySort['field']) => void;
  onSelect: (locator: string, modifiers: DirectorySelectionModifiers) => void;
  onSelectAll: () => void;
  onContextMenu: (entry: Entry) => void;
  onOpen: (entry: Entry) => void;
}

export function DirectoryTable({
  scrollElement,
  rows,
  revealTarget = null,
  sort,
  canSort,
  loadingWithoutEntries,
  selectedLocators,
  dateFormatter,
  sizeFormatter,
  onSort,
  onSelect,
  onSelectAll,
  onContextMenu,
  onOpen,
}: DirectoryTableProps) {
  const { t } = useTranslation('storage');
  const [tabNavigation, setTabNavigation] = useState(false);
  const { tableRef, enabled, scrollMargin, virtualizer, onFocus, onBlur, onKeyDown } =
    useDirectoryVirtualizer(rows, scrollElement, canSort, revealTarget);

  useEffect(() => {
    const document = tableRef.current?.ownerDocument;
    if (!document) return;

    const showTabFocus = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
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

  const virtualRows = virtualizer.getVirtualItems();
  const lastRowEnd = (virtualRows.at(-1)?.end ?? scrollMargin) - scrollMargin;
  const paddingBottom = Math.max(0, virtualizer.getTotalSize() - lastRowEnd);
  const renderRow = (row: DirectoryRow, index: number) => (
    <DirectoryEntryRow
      key={row.entry.ref.locator}
      {...row}
      index={index}
      selected={selectedLocators.has(row.entry.ref.locator)}
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
      onKeyDownCapture={(event) => {
        if (event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'a') {
          event.preventDefault();
          onSelectAll();
          return;
        }
        onKeyDown(event);
      }}
    >
      <thead>
        <tr>
          {columns.map(({ field, label, className }) => {
            const direction = canSort && sort?.field === field ? sort.direction : undefined;
            const Icon =
              direction === 'ascending' ? ChevronUp : direction ? ChevronDown : ChevronsUpDown;
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
      <Menu.ContextMenu disabled={loadingWithoutEntries}>
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
      </Menu.ContextMenu>
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
