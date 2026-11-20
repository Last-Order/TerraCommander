import { memo } from 'react';
import { ChevronRight, File, Folder, Link2, LockKeyhole, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Entry } from '../../../../shared/storage';
import type { DirectoryRow, DirectorySelectionModifiers } from './directory-types';
import classes from './DirectoryTable.module.css';
import { formatSize } from '../../format/size';

const entryIcons: Record<Entry['kind'], LucideIcon> = {
  directory: Folder,
  link: Link2,
  file: File,
  other: File,
};

interface DirectoryEntryRowProps extends DirectoryRow {
  index: number;
  selected: boolean;
  dateFormatter: Intl.DateTimeFormat;
  sizeFormatter: Intl.NumberFormat;
  measure: ((element: HTMLTableRowElement | null) => void) | undefined;
  onSelect: (locator: string, modifiers: DirectorySelectionModifiers) => void;
  onContextMenu: (entry: Entry) => void;
  onOpen: (entry: Entry) => void;
}

export const DirectoryEntryRow = memo(function DirectoryEntryRow({
  entry,
  name,
  disabled,
  modifiedAt,
  size,
  index,
  selected,
  dateFormatter,
  sizeFormatter,
  measure,
  onSelect,
  onContextMenu,
  onOpen,
}: DirectoryEntryRowProps) {
  const { t } = useTranslation('storage');
  const { locator } = entry.ref;
  const isDirectory = entry.kind === 'directory';
  const Icon = entryIcons[entry.kind];

  return (
    <tr
      ref={measure}
      data-index={index}
      aria-rowindex={index + 2}
      className={classes.entryRow}
      data-selected={selected}
      data-disabled={disabled || undefined}
      aria-busy={disabled || undefined}
      onClick={(event) => {
        event.currentTarget.querySelector('button')?.focus({ preventScroll: true });
        onSelect(locator, { toggle: event.ctrlKey, range: event.shiftKey });
      }}
      onContextMenu={() => onContextMenu(entry)}
      onDoubleClick={
        isDirectory
          ? (event) => {
              if (!event.ctrlKey && !event.shiftKey) onOpen(entry);
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
          title={disabled ? t('entryWriteLocked') : undefined}
          onKeyDown={(event) => {
            if (isDirectory && event.key === 'Enter') {
              event.preventDefault();
              onOpen(entry);
            }
          }}
        >
          <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
          <span title={name}>{name}</span>
          {disabled && <LockKeyhole size={14} strokeWidth={1.5} aria-hidden="true" />}
          {isDirectory && <ChevronRight size={16} strokeWidth={1.5} aria-hidden="true" />}
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
});
