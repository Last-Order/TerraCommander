import { ChevronRight, File, Folder, Link2, LockKeyhole, type LucideIcon } from 'lucide-react';
import { memo, type DragEvent } from 'react';
import { formatSize } from '@renderer/format/size';
import type { Entry } from '@shared/storage';
import { canRowStartDrag } from './directory-drag';
import type { DirectoryRow, DirectorySelectionModifiers } from './directory-types';
import type { DirectoryContextMenuPosition } from './useDirectoryContextMenu';
import { useEntryBusy } from './useDirectoryEffects';
import classes from './DirectoryTable.module.css';

const entryIcons: Record<Entry['kind'], LucideIcon> = {
  directory: Folder,
  link: Link2,
  file: File,
  other: File,
};

interface DirectoryEntryRowProps extends DirectoryRow {
  index: number;
  selected: boolean;
  cut: boolean;
  selectionDraggable: boolean;
  dragBlocked: boolean;
  dragging: boolean;
  dropTarget: boolean;
  disabledTitle: string;
  dateFormatter: Intl.DateTimeFormat;
  sizeFormatter: Intl.NumberFormat;
  measure: ((element: HTMLTableRowElement | null) => void) | undefined;
  onSelect: (locator: string, modifiers: DirectorySelectionModifiers) => void;
  onContextMenu: (entry: Entry, position: DirectoryContextMenuPosition) => void;
  onOpen: (entry: Entry) => void;
  onDragStart: (index: number, event: DragEvent<HTMLTableRowElement>) => void;
  onDragEnd: () => void;
}

export const DirectoryEntryRow = memo(function DirectoryEntryRow({
  entry,
  name,
  modifiedAt,
  size,
  index,
  selected,
  cut,
  selectionDraggable,
  dragBlocked,
  dragging,
  dropTarget,
  disabledTitle,
  dateFormatter,
  sizeFormatter,
  measure,
  onSelect,
  onContextMenu,
  onOpen,
  onDragStart,
  onDragEnd,
}: DirectoryEntryRowProps) {
  const disabled = useEntryBusy(entry.ref);
  const { locator } = entry.ref;
  const isDirectory = entry.kind === 'directory';
  const Icon = entryIcons[entry.kind];
  const draggable = canRowStartDrag({
    entry,
    entryBusy: disabled,
    selected,
    selectionDraggable,
    blocked: dragBlocked,
  });

  return (
    <tr
      ref={measure}
      data-index={index}
      aria-rowindex={index + 2}
      className={classes.entryRow}
      draggable={draggable}
      data-selected={selected}
      data-cut={cut || undefined}
      data-dragging={dragging || undefined}
      data-drop-target={dropTarget || undefined}
      data-disabled={disabled || undefined}
      aria-busy={disabled || undefined}
      onDragStart={draggable ? (event) => onDragStart(index, event) : undefined}
      onDragEnd={onDragEnd}
      onClick={(event) => {
        event.currentTarget.querySelector('button')?.focus({ preventScroll: true });
        onSelect(locator, { toggle: event.ctrlKey, range: event.shiftKey });
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(entry, { x: event.clientX, y: event.clientY });
      }}
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
          draggable={draggable}
          aria-pressed={selected}
          title={disabled ? disabledTitle : undefined}
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
