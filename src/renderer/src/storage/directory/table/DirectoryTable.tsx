import { Skeleton } from '@mantine/core';
import { ChevronDown, ChevronsUpDown, ChevronUp, type LucideIcon } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '@shared/storage';
import type { DirectoryContextMenuPosition } from '../actions/useDirectoryContextMenu';
import type { DirectoryRow, DirectorySort } from '../directory-types';
import { useDirectorySortStore } from '../state/directory-sort';
import { useDirectoryView, useDirectoryViewStore } from '../state/directory-view-context';
import {
  DIRECTORY_NAME_MIN_WIDTH,
  resizeDirectoryColumns,
  saveDirectoryColumnWidths,
  useDirectoryColumnWidthsStore,
  type DirectoryColumnWidths,
  type ResizableDirectoryColumn,
} from './directory-columns';
import { isDirectoryNavigationKey } from './directory-navigation';
import { DirectoryEntryRow } from './DirectoryEntryRow';
import { useDirectoryDrag } from './useDirectoryDrag';
import { useDirectoryKeyboardNavigation } from './useDirectoryKeyboardNavigation';
import { useDirectoryVirtualizer } from './useDirectoryVirtualizer';
import classes from './DirectoryTable.module.css';

const entryIconSize = 16;
const sortIcons: Record<DirectorySort['direction'], LucideIcon> = {
  ascending: ChevronUp,
  descending: ChevronDown,
};
const columns = [
  { field: 'name', label: 'entryName', className: undefined, resizable: false },
  { field: 'modifiedAt', label: 'entryModifiedAt', className: classes.entryDate, resizable: true },
  { field: 'size', label: 'entrySize', className: classes.entrySize, resizable: true },
] as const satisfies readonly {
  field: DirectorySort['field'];
  label: string;
  className: string | undefined;
  resizable: boolean;
}[];

interface ColumnResizeDrag {
  column: ResizableDirectoryColumn;
  pointerId: number;
  startX: number;
  startWidths: DirectoryColumnWidths;
  latestWidths: DirectoryColumnWidths;
  tableWidth: number;
  direction: 1 | -1;
}

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
        <Skeleton width="min(100%, 8.5rem)" height="0.75rem" />
      </td>
      <td className={classes.entrySize}>
        <Skeleton
          className={classes.entrySizePlaceholder}
          width="min(100%, 3rem)"
          height="0.75rem"
        />
      </td>
    </tr>
  ));
}

interface DirectoryTableProps {
  scrollElement: HTMLDivElement | null;
  onContextMenu: (entry: Entry, position: DirectoryContextMenuPosition) => void;
  onOpen: (entry: Entry) => void;
}

export function DirectoryTable({ scrollElement, onContextMenu, onOpen }: DirectoryTableProps) {
  const { t, i18n } = useTranslation('storage');
  const viewStore = useDirectoryViewStore();
  const rows = useDirectoryView((state) => state.rows);
  const rowIndexByLocator = useDirectoryView((state) => state.rowIndexByLocator);
  const canSort = useDirectoryView((state) => state.canSort);
  const loadingWithoutEntries = useDirectoryView((state) => state.loadingWithoutEntries);
  const activeLocator = useDirectoryView((state) => state.activeLocator);
  const viewportCommand = useDirectoryView((state) => state.viewportCommand);
  const drag = useDirectoryDrag();
  const sort = useDirectorySortStore((state) => state.sort);
  const onSort = useDirectorySortStore((state) => state.toggleSort);
  const columnWidths = useDirectoryColumnWidthsStore((state) => state.widths);
  const setColumnWidths = useDirectoryColumnWidthsStore((state) => state.setWidths);
  const resetColumnWidth = useDirectoryColumnWidthsStore((state) => state.resetColumnWidth);
  const resizeDrag = useRef<ColumnResizeDrag | null>(null);
  const [resizingColumn, setResizingColumn] = useState<ResizableDirectoryColumn | null>(null);
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
  const pinnedLocators = useMemo(() => {
    const pinned: string[] = [];
    if (activeLocator !== null) pinned.push(activeLocator);
    if (viewportCommand !== null) pinned.push(viewportCommand.locator);
    if (drag.draggingAnchorLocator !== null) pinned.push(drag.draggingAnchorLocator);
    return pinned;
  }, [activeLocator, viewportCommand, drag.draggingAnchorLocator]);
  const { tableRef, enabled, scrollMargin, virtualizer, getPageStep, syncScrollPadding } =
    useDirectoryVirtualizer({
      rows,
      rowIndexByLocator,
      scrollElement,
      canSort,
      pinnedLocators,
      viewportCommand,
      onViewportCommandHandled: viewStore.getState().clearViewportCommand,
    });
  const { onFocus, onKeyDown } = useDirectoryKeyboardNavigation({
    tableRef,
    scrollElement,
    virtualized: enabled,
    getPageStep,
    syncScrollPadding,
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
      selectionDraggable={drag.selectionDraggable}
      dragBlocked={drag.blocked || resizingColumn !== null}
      dragging={drag.draggedLocators?.has(row.entry.ref.locator) ?? false}
      dropTarget={drag.dropTargetLocator === row.entry.ref.locator}
      disabledTitle={disabledTitle}
      dateFormatter={dateFormatter}
      sizeFormatter={sizeFormatter}
      measure={enabled ? virtualizer.measureElement : undefined}
      onContextMenu={onContextMenu}
      onOpen={onOpen}
      onDragStart={drag.onRowDragStart}
    />
  );

  const finishResize = (persist: boolean) => {
    const current = resizeDrag.current;
    if (!current) return;
    resizeDrag.current = null;
    setResizingColumn(null);
    if (persist) {
      saveDirectoryColumnWidths(current.latestWidths);
    }
  };

  const startColumnResize = (
    column: ResizableDirectoryColumn,
    event: PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || !event.isPrimary || !tableRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const direction = getComputedStyle(tableRef.current).direction === 'rtl' ? -1 : 1;
    resizeDrag.current = {
      column,
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidths: columnWidths,
      latestWidths: columnWidths,
      tableWidth: tableRef.current.getBoundingClientRect().width,
      direction,
    };
    setResizingColumn(column);
  };

  const moveColumnResize = (event: PointerEvent<HTMLDivElement>) => {
    const current = resizeDrag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const deltaX = (event.clientX - current.startX) * current.direction;
    const nextWidths = resizeDirectoryColumns(
      current.startWidths,
      current.column,
      deltaX,
      current.tableWidth,
    );
    current.latestWidths = nextWidths;
    setColumnWidths(nextWidths);
  };

  const stopColumnResize = (event: PointerEvent<HTMLDivElement>) => {
    if (resizeDrag.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishResize(true);
  };

  const tableStyle = {
    '--entry-name-min-width': `${DIRECTORY_NAME_MIN_WIDTH}px`,
    '--entry-date-width': `${columnWidths.modifiedAt}px`,
    '--entry-size-width': `${columnWidths.size}px`,
  } as CSSProperties;

  return (
    <table
      ref={tableRef}
      className={classes.entries}
      style={tableStyle}
      data-tab-navigation={tabNavigation || undefined}
      data-resizing={resizingColumn !== null || undefined}
      aria-label={t('filesAndFolders')}
      aria-rowcount={rows.length + 1}
      onFocusCapture={onFocus}
      onKeyDownCapture={onKeyDown}
      {...drag.tableDragProps}
    >
      <thead>
        <tr>
          {columns.map(({ field, label, className, resizable }) => {
            const direction = canSort && sort.field === field ? sort.direction : undefined;
            const Icon = direction ? sortIcons[direction] : ChevronsUpDown;
            return (
              <th key={field} scope="col" className={className} aria-sort={direction}>
                {resizable && (
                  <div
                    aria-hidden="true"
                    className={classes.resizeHandle}
                    data-active={resizingColumn === field || undefined}
                    onPointerDown={(event) => startColumnResize(field, event)}
                    onPointerMove={moveColumnResize}
                    onPointerUp={stopColumnResize}
                    onPointerCancel={stopColumnResize}
                    onLostPointerCapture={() => finishResize(true)}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      resetColumnWidth(field);
                    }}
                  />
                )}
                {canSort ? (
                  <button
                    type="button"
                    className={classes.sortHeader}
                    onClick={() => onSort(field)}
                  >
                    <span className={classes.columnText}>{t(label)}</span>
                    <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                  </button>
                ) : (
                  <span className={classes.columnLabel}>
                    <span className={classes.columnText}>{t(label)}</span>
                  </span>
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
