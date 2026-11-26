import type { OperationContext, ReadHandle } from '@main/storage/core/contracts';
import type { Entry, EntryRef, ReadOptions } from '@shared/storage';
import type { StorageEntryOperations } from './storage-entry-operations';

/** File-scoped backend handle backed by space-checked storage entry operations. */
export interface StorageFile {
  readonly ref: EntryRef;
  stat(context?: OperationContext): Promise<Entry>;
  read(options?: ReadOptions, context?: OperationContext): Promise<ReadHandle>;
}

export function createStorageFile(operations: StorageEntryOperations, ref: EntryRef): StorageFile {
  const fileRef: EntryRef = {
    connectionId: ref.connectionId,
    spaceId: ref.spaceId,
    locator: ref.locator,
  };

  return {
    get ref(): EntryRef {
      return { ...fileRef };
    },

    stat(context) {
      return context !== undefined
        ? operations.statEntry(fileRef, context)
        : operations.statEntry(fileRef);
    },

    read(options, context) {
      if (context !== undefined) return operations.readEntry(fileRef, options, context);
      if (options !== undefined) return operations.readEntry(fileRef, options);
      return operations.readEntry(fileRef);
    },
  };
}
