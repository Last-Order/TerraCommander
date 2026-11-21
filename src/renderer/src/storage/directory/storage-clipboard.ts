import { create } from 'zustand';
import type { Entry, EntryRef } from '@shared/storage';
import type { PasteMode } from '@shared/tasks';

export interface StorageClipboard {
  mode: PasteMode;
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  entries: readonly Entry[];
}

interface StorageClipboardState {
  clipboard: StorageClipboard | null;
  setClipboard: (clipboard: StorageClipboard | null) => void;
}

export const useStorageClipboard = create<StorageClipboardState>((set) => ({
  clipboard: null,
  setClipboard: (clipboard) => set({ clipboard }),
}));
