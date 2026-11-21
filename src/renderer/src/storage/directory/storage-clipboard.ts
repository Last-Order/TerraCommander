import type { Entry, EntryRef } from '@shared/storage';
import type { PasteMode } from '@shared/tasks';

export interface StorageClipboard {
  mode: PasteMode;
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  entries: readonly Entry[];
}
