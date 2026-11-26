import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import type { PasteEntriesRequest } from '@shared/tasks';
import type { DirectoryRow } from '../directory-types';
import type { StorageClipboard } from '../state/storage-clipboard';

export const directoryDragMimeType = 'application/x-terracommander-entries';

interface ResolvedDragPayload {
  entries: Entry[];
  locators: ReadonlySet<string>;
  replaceSelectionWith: string | null;
}

export function hasDirectoryEntryDrag(types: readonly string[]): boolean {
  return types.includes(directoryDragMimeType);
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
  const selected = selectedLocators.has(draggedLocator);
  const entries = selected
    ? rows.filter(({ entry }) => selectedLocators.has(entry.ref.locator)).map(({ entry }) => entry)
    : [draggedRow.entry];
  if (
    entries.length === 0 ||
    entries.some((entry) => !canDragMoveEntry(entry) || isBusy(entry.ref))
  ) {
    return null;
  }

  return {
    entries,
    locators: new Set(entries.map(({ ref }) => ref.locator)),
    replaceSelectionWith: selected ? null : draggedLocator,
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
