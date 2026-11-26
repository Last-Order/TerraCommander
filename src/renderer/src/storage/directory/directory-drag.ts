import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import type { PasteEntriesRequest } from '@shared/tasks';
import type { DirectoryRow } from './directory-types';
import type { StorageClipboard } from './storage-clipboard';

export const directoryDragMimeType = 'application/x-terracommander-entries';

export interface ResolvedDragPayload {
  entries: Entry[];
  locators: ReadonlySet<string>;
  leadName: string;
  replaceSelectionWith: string | null;
}

export function hasDirectoryEntryDrag(types: Iterable<string> | null | undefined): boolean {
  return types != null && Array.from(types).includes(directoryDragMimeType);
}

export function canDragMoveEntry(entry: Entry): boolean {
  return (
    (entry.kind === 'file' || entry.kind === 'directory' || entry.kind === 'link') &&
    entry.capabilities.moveWithin?.support !== 'unsupported'
  );
}

export function canRowStartDrag({
  entry,
  entryBusy,
  selected,
  selectionDraggable,
  blocked,
}: {
  entry: Entry;
  entryBusy: boolean;
  selected: boolean;
  selectionDraggable: boolean;
  blocked: boolean;
}): boolean {
  if (blocked || entryBusy) return false;
  if (selected) return selectionDraggable;
  return canDragMoveEntry(entry);
}

export function resolveDragStartEntries({
  draggedRow,
  rows,
  selectedLocators,
  isBusy,
}: {
  draggedRow: DirectoryRow;
  rows: readonly DirectoryRow[];
  selectedLocators: ReadonlySet<string>;
  isBusy: (ref: EntryRef) => boolean;
}): ResolvedDragPayload | null {
  const draggedLocator = draggedRow.entry.ref.locator;
  if (selectedLocators.has(draggedLocator)) {
    const selectedRows = rows.filter((row) => selectedLocators.has(row.entry.ref.locator));
    if (
      selectedRows.length === 0 ||
      selectedRows.some((row) => !canDragMoveEntry(row.entry) || isBusy(row.entry.ref))
    ) {
      return null;
    }
    return {
      entries: selectedRows.map((row) => row.entry),
      locators: new Set(selectedRows.map((row) => row.entry.ref.locator)),
      leadName: draggedRow.name,
      replaceSelectionWith: null,
    };
  }

  if (!canDragMoveEntry(draggedRow.entry) || isBusy(draggedRow.entry.ref)) {
    return null;
  }

  return {
    entries: [draggedRow.entry],
    locators: new Set([draggedLocator]),
    leadName: draggedRow.name,
    replaceSelectionWith: draggedLocator,
  };
}

export function canDropEntriesIntoTarget({
  target,
  draggedEntries,
  draggedLocators,
  isBusy,
  blocked,
}: {
  target: Entry | undefined;
  draggedEntries: readonly Entry[];
  draggedLocators: ReadonlySet<string>;
  isBusy: (ref: EntryRef) => boolean;
  blocked: boolean;
}): boolean {
  if (blocked || !target || draggedEntries.length === 0) return false;
  if (target.kind !== 'directory') return false;
  if (target.capabilities.write?.support === 'unsupported') return false;
  if (draggedLocators.has(target.ref.locator) || isBusy(target.ref)) return false;
  return draggedEntries.every((entry) => canDragMoveEntry(entry) && !isBusy(entry.ref));
}

export function buildMoveIntoDirectoryRequest({
  parent,
  directoryPath,
  ancestors,
  entries,
  targetDirectory,
  targetDirectoryName,
}: {
  parent: EntryRef;
  directoryPath: string;
  ancestors: readonly EntryRef[];
  entries: readonly Entry[];
  targetDirectory: Entry;
  targetDirectoryName?: string | undefined;
}): PasteEntriesRequest {
  const folderName = targetDirectoryName ?? targetDirectory.name;
  return {
    mode: 'cut',
    sourceParent: parent,
    sourceDirectoryPath: directoryPath,
    entries,
    targetParent: targetDirectory.ref,
    targetDirectoryPath: directoryPath ? `${directoryPath} / ${folderName}` : folderName,
    targetAncestors: [...ancestors, targetDirectory.ref],
  };
}

export function pruneCutClipboardForMovedEntries(
  clipboard: StorageClipboard | null,
  movedParent: EntryRef,
  movedEntries: readonly Entry[],
): StorageClipboard | null {
  if (!clipboard || clipboard.mode !== 'cut') return clipboard;
  if (entryKey(clipboard.sourceParent) !== entryKey(movedParent)) return clipboard;
  const movedKeys = new Set(movedEntries.map((entry) => entryKey(entry.ref)));
  const remaining = clipboard.entries.filter((entry) => !movedKeys.has(entryKey(entry.ref)));
  if (remaining.length === clipboard.entries.length) return clipboard;
  if (remaining.length === 0) return null;
  return { ...clipboard, entries: remaining };
}
