import { ChevronRight, File, Folder, Link2, LockKeyhole, type LucideIcon } from 'lucide-react';
import { memo, type DragEvent } from 'react';
import { formatSize } from '@renderer/format/size';
import { entryKey, type Entry } from '@shared/storage';
import type { DirectoryContextMenuPosition } from '../actions/useDirectoryContextMenu';
import { useCurrentDirectory } from '../current-directory-context';
import type { DirectoryRow } from '../directory-types';
import { useDirectoryView, useDirectoryViewStore } from '../state/directory-view-context';
import { useStorageClipboard } from '../state/storage-clipboard';
import { useEntryBusy } from '../state/useDirectoryEffects';
import { canRowStartDrag } from './directory-drag';
import classes from './DirectoryTable.module.css';

const entryIcons: Record<Entry['kind'], LucideIcon> = {
  directory: Folder,
  link: Link2,
  file: File,
  other: File,
};

interface DirectoryEntryRowProps extends DirectoryRow {
  index: number;
  selectionDraggable: boolean;
  dragBlocked: boolean;
  dragging: boolean;
  dropTarget: boolean;
  disabledTitle: string;
  dateFormatter: Intl.DateTimeFormat;
  sizeFormatter: Intl.NumberFormat;
  measure: ((element: HTMLTableRowElement | null) => void) | undefined;
  onContextMenu: (entry: Entry, position: DirectoryContextMenuPosition) => void;
  onOpen: (entry: Entry) => void;
  onDragStart: (index: number, event: DragEvent<HTMLTableRowElement>) => void;
}

export const DirectoryEntryRow = memo(function DirectoryEntryRow({
  entry,
  name,
  modifiedAt,
  size,
  index,
  selectionDraggable,
  dragBlocked,
  dragging,
  dropTarget,
  disabledTitle,
  dateFormatter,
  sizeFormatter,
  measure,
  onContextMenu,
  onOpen,
  onDragStart,
}: DirectoryEntryRowProps) {
  const { locator } = entry.ref;
  const { ref: parent } = useCurrentDirectory();
  const parentKey = entryKey(parent);
  const viewStore = useDirectoryViewStore();
  const selected = useDirectoryView((state) => state.selectedLocators.has(locator));
  const cut = useStorageClipboard(
    (state) =>
      state.clipboard?.mode === 'cut' &&
      state.sourceParentKey === parentKey &&
      state.entryLocators.has(locator),
  );
  const disabled = useEntryBusy(entry.ref);
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
      onClick={(event) => {
        event.currentTarget.querySelector('button')?.focus({ preventScroll: true });
        viewStore.getState().selectEntry(locator, {
          toggle: event.ctrlKey,
          range: event.shiftKey,
        });
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
