import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import type { TransferFromLocalPathsRequest } from '@shared/tasks';
import type { DirectoryRow } from '../directory-types';
import { hasDirectoryEntryDrag } from '../table/directory-drag';

export type LocalFileDropTarget =
  | { kind: 'current-directory' }
  | { kind: 'folder'; entry: Entry; name: string };

export function hasExternalFileDrag(types: readonly string[]): boolean {
  return types.includes('Files') && !hasDirectoryEntryDrag(types);
}

export function canDropLocalFilesIntoDirectory(
  entry: Entry,
  isBusy: (ref: EntryRef) => boolean,
): boolean {
  return (
    entry.kind === 'directory' &&
    entry.capabilities.write?.support !== 'unsupported' &&
    !isBusy(entry.ref)
  );
}

export function resolveLocalFileDropTarget({
  hoveredRow,
  canDropInCurrentDirectory,
  isBusy,
  disabled,
}: {
  hoveredRow: DirectoryRow | undefined;
  canDropInCurrentDirectory: boolean;
  isBusy: (ref: EntryRef) => boolean;
  disabled: boolean;
}): LocalFileDropTarget | null {
  if (disabled) return null;
  if (hoveredRow?.entry.kind === 'directory') {
    if (!canDropLocalFilesIntoDirectory(hoveredRow.entry, isBusy)) return null;
    return {
      kind: 'folder',
      entry: hoveredRow.entry,
      name: hoveredRow.name,
    };
  }
  return canDropInCurrentDirectory ? { kind: 'current-directory' } : null;
}

export function isSameLocalFileDropTarget(
  left: LocalFileDropTarget | null,
  right: LocalFileDropTarget | null,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'current-directory') return true;
  return (
    right.kind === 'folder' &&
    entryKey(left.entry.ref) === entryKey(right.entry.ref) &&
    left.name === right.name
  );
}

export function buildLocalPathsDropRequest({
  target,
  parent,
  directoryPath,
  targetAncestors,
  paths,
}: {
  target: LocalFileDropTarget;
  parent: EntryRef;
  directoryPath: string;
  targetAncestors: readonly EntryRef[];
  paths: readonly string[];
}): TransferFromLocalPathsRequest {
  if (target.kind === 'current-directory') {
    return {
      targetParent: parent,
      targetDirectoryPath: directoryPath,
      paths,
      targetAncestors,
    };
  }
  return {
    targetParent: target.entry.ref,
    targetDirectoryPath: directoryPath ? `${directoryPath} / ${target.name}` : target.name,
    paths,
    targetAncestors: [...targetAncestors, target.entry.ref],
  };
}
