import { create } from 'zustand';
import { entryKey, type Capabilities, type Entry, type EntryRef } from '@shared/storage';
import { localConnectionId } from '@shared/storage-browser';
import type { PasteMode } from '@shared/tasks';

export interface StorageClipboard {
  mode: PasteMode;
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  entries: readonly Entry[];
}

export type PasteValidationResult =
  | { status: 'ok' }
  | { status: 'clear-cut' }
  | {
      status: 'rejected';
      reason: 'crossSource' | 'selfContainment' | 'permissionDenied' | 'unsupported';
    };

export function validatePaste({
  clipboard,
  targetParent,
  targetAncestors,
  targetCapabilities,
}: {
  clipboard: StorageClipboard;
  targetParent: EntryRef;
  targetAncestors: readonly EntryRef[];
  targetCapabilities?: Capabilities | undefined;
}): PasteValidationResult {
  if (clipboard.mode === 'cut' && entryKey(clipboard.sourceParent) === entryKey(targetParent)) {
    return { status: 'clear-cut' };
  }

  const sourceConnectionId = clipboard.sourceParent.connectionId;
  const targetConnectionId = targetParent.connectionId;
  if (
    sourceConnectionId !== localConnectionId &&
    targetConnectionId !== localConnectionId &&
    sourceConnectionId !== targetConnectionId
  ) {
    return { status: 'rejected', reason: 'crossSource' };
  }

  if (
    clipboard.entries.some(
      (entry) =>
        entry.kind === 'directory' &&
        targetAncestors.some(
          (ancestor) =>
            ancestor.connectionId === entry.ref.connectionId &&
            ancestor.spaceId === entry.ref.spaceId &&
            ancestor.locator === entry.ref.locator,
        ),
    )
  ) {
    return { status: 'rejected', reason: 'selfContainment' };
  }

  if (targetConnectionId !== localConnectionId) {
    if (targetCapabilities?.write?.support === 'unsupported') {
      return { status: 'rejected', reason: 'permissionDenied' };
    }
    if (
      (clipboard.mode === 'copy' || sourceConnectionId !== targetConnectionId) &&
      clipboard.entries.some((entry) => entry.kind === 'directory') &&
      targetCapabilities?.createDirectory?.support === 'unsupported'
    ) {
      return { status: 'rejected', reason: 'unsupported' };
    }
  }

  return { status: 'ok' };
}

interface StorageClipboardState {
  clipboard: StorageClipboard | null;
  setClipboard: (clipboard: StorageClipboard | null) => void;
}

export const useStorageClipboard = create<StorageClipboardState>((set) => ({
  clipboard: null,
  setClipboard: (clipboard) => set({ clipboard }),
}));
