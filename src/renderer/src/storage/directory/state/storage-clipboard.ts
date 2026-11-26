import { create } from 'zustand';
import { entryKey, type Entry, type EntryRef } from '@shared/storage';
import type { PasteMode } from '@shared/tasks';

export interface StorageClipboard {
  mode: PasteMode;
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  entries: readonly Entry[];
}

interface StorageClipboardState {
  clipboard: StorageClipboard | null;
  sourceParentKey: string | null;
  entryLocators: ReadonlySet<string>;
  setClipboard: (clipboard: StorageClipboard | null) => void;
}

const emptyLocators: ReadonlySet<string> = new Set();

export const useStorageClipboard = create<StorageClipboardState>((set) => ({
  clipboard: null,
  sourceParentKey: null,
  entryLocators: emptyLocators,
  setClipboard: (clipboard) =>
    set({
      clipboard,
      sourceParentKey: clipboard ? entryKey(clipboard.sourceParent) : null,
      entryLocators: clipboard
        ? new Set(clipboard.entries.map((entry) => entry.ref.locator))
        : emptyLocators,
    }),
}));
