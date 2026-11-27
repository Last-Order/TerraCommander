import type {
  ByteSource,
  OperationContext,
  ReadHandle,
  ReopenableByteSource,
  WriteExecution,
  WriteOptions,
} from '@main/storage/core/contracts';
import type {
  ConditionalWriteTarget,
  Entry,
  EntryRef,
  ReadOptions,
  ReplaceWriteTarget,
} from '@shared/storage';
import type { StorageEntryOperations } from './storage-entry-operations';

export type FileReplacementPolicy =
  | Pick<ReplaceWriteTarget, 'policy'>
  | Pick<ConditionalWriteTarget, 'policy' | 'expectedRevision'>;

/** File-scoped backend handle backed by space-checked storage entry operations. */
export interface StorageFile {
  readonly ref: EntryRef;
  stat(context?: OperationContext): Promise<Entry>;
  read(options?: ReadOptions, context?: OperationContext): Promise<ReadHandle>;
  replaceContents(
    source: ByteSource,
    policy: FileReplacementPolicy,
    context?: OperationContext,
    options?: WriteOptions,
  ): Promise<Entry>;
  prepareReplaceContents(
    source: ReopenableByteSource,
    policy: FileReplacementPolicy,
    options?: WriteOptions,
  ): WriteExecution;
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

    replaceContents(source, policy, context, options) {
      return operations.writeEntry(
        { ...policy, kind: 'replace', ref: fileRef },
        source,
        context,
        options,
      );
    },

    prepareReplaceContents(source, policy, options) {
      return operations.prepareWrite({ ...policy, kind: 'replace', ref: fileRef }, source, options);
    },
  };
}
