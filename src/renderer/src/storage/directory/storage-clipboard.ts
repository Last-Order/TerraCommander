import type { Entry, EntryRef } from '@shared/storage';

export interface StorageClipboard {
  sourceParent: EntryRef;
  sourceDirectoryPath: string;
  entries: readonly Entry[];
}
