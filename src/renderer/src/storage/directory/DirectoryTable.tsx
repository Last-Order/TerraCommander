import { Menu, Skeleton } from '@mantine/core';
import {
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  File,
  Folder,
  Link2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '../../../../shared/storage';
import classes from './DirectoryTable.module.css';
import { formatSize } from './entry-format';

const entryIconSize = 17;
const columns = [
  { field: 'name', label: 'entryName', className: undefined },
  { field: 'modifiedAt', label: 'entryModifiedAt', className: classes.entryDate },
  { field: 'size', label: 'entrySize', className: classes.entrySize },
] as const;

export interface DirectorySort {
  field: (typeof columns)[number]['field'];
  direction: 'ascending' | 'descending';
}

export interface DirectoryRow {
  entry: Entry;
  modifiedAt: number | undefined;
  size: number | undefined;
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
        <Skeleton width="8.5rem" height="0.75rem" />
      </td>
      <td className={classes.entrySize}>
        <Skeleton className={classes.entrySizePlaceholder} width="3rem" height="0.75rem" />
      </td>
    </tr>
  ));
}

interface DirectoryTableProps {
  rows: readonly DirectoryRow[];
  sort: DirectorySort | null;
  canSort: boolean;
  loadingWithoutEntries: boolean;
  selectedLocators: ReadonlySet<string>;
  dateFormatter: Intl.DateTimeFormat;
  sizeFormatter: Intl.NumberFormat;
  onSort: (field: DirectorySort['field']) => void;
  onSelect: (locator: string, toggle: boolean) => void;
  onContextMenu: (entry: Entry) => void;
  onOpen: (entry: Entry) => void;
}

export function DirectoryTable({
  rows,
  sort,
  canSort,
  loadingWithoutEntries,
  selectedLocators,
  dateFormatter,
  sizeFormatter,
  onSort,
  onSelect,
  onContextMenu,
  onOpen,
}: DirectoryTableProps) {
  const { t } = useTranslation('storage');

  return (
    <table className={classes.entries} aria-label={t('filesAndFolders')}>
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
                    <Icon size={14} aria-hidden="true" />
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
          {rows.map(({ entry, modifiedAt, size }) => {
            const { locator } = entry.ref;
            const isDirectory = entry.kind === 'directory';
            const Icon = isDirectory ? Folder : entry.kind === 'link' ? Link2 : File;
            const selected = selectedLocators.has(locator);

            return (
              <tr
                key={locator}
                className={classes.entryRow}
                data-selected={selected}
                onClick={(event) => onSelect(locator, event.ctrlKey)}
                onContextMenu={() => onContextMenu(entry)}
                onDoubleClick={
                  isDirectory
                    ? (event) => {
                        if (!event.ctrlKey) onOpen(entry);
                      }
                    : undefined
                }
              >
                <td className={classes.entryName}>
                  <button
                    type="button"
                    className={classes.entry}
                    data-kind={entry.kind}
                    aria-pressed={selected}
                    onKeyDown={(event) => {
                      if (isDirectory && event.key === 'Enter') {
                        event.preventDefault();
                        onOpen(entry);
                      }
                    }}
                  >
                    <Icon size={entryIconSize} aria-hidden="true" />
                    <span title={entry.name}>{entry.name}</span>
                    {isDirectory && <ChevronRight size={14} aria-hidden="true" />}
                  </button>
                </td>
                <td className={classes.entryDate}>
                  {modifiedAt !== undefined ? (
                    <time dateTime={entry.modifiedAt}>{dateFormatter.format(modifiedAt)}</time>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={classes.entrySize}>
                  {size !== undefined ? formatSize(size, sizeFormatter) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Menu.ContextMenu>
    </table>
  );
}
