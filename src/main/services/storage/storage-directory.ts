import type {
  OperationContext,
  ReopenableByteSource,
  WriteExecution,
} from '@main/storage/core/contracts';
import { StorageError } from '@main/storage/core/errors';
import type {
  Capabilities,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  SpaceSemantics,
} from '@shared/storage';
import type { StorageEntryOperations } from './storage-entry-operations';
import { createStorageFile, type StorageFile } from './storage-file';

export interface CreatedStorageDirectory {
  readonly entry: Entry;
  readonly directory: StorageDirectory;
}

/** Directory-scoped backend handle backed by space-checked storage entry operations. */
export interface StorageDirectory {
  readonly ref: EntryRef;
  child(ref: EntryRef): StorageDirectory;
  file(ref: EntryRef): StorageFile;
  stat(context?: OperationContext): Promise<Entry>;
  semantics(): Promise<SpaceSemantics | undefined>;
  capabilities(context?: OperationContext): Promise<Capabilities>;
  list(request?: string | ListRequest, context?: OperationContext): Promise<EntryPage>;
  createDirectory(name: string, context?: OperationContext): Promise<CreatedStorageDirectory>;
  prepareUpload(name: string, source: ReopenableByteSource): WriteExecution;
  copyEntry(source: EntryRef, name: string, context?: OperationContext): Promise<Entry>;
  moveEntry(source: EntryRef, name: string, context?: OperationContext): Promise<Entry>;
}

export function createStorageDirectory(
  operations: StorageEntryOperations,
  ref: EntryRef,
): StorageDirectory {
  const directoryRef: EntryRef = {
    connectionId: ref.connectionId,
    spaceId: ref.spaceId,
    locator: ref.locator,
  };

  return {
    ref: directoryRef,

    child(childRef) {
      if (
        childRef.connectionId !== directoryRef.connectionId ||
        childRef.spaceId !== directoryRef.spaceId
      ) {
        throw new StorageError('InvalidArgument');
      }
      return createStorageDirectory(operations, childRef);
    },

    file(fileRef) {
      if (
        fileRef.connectionId !== directoryRef.connectionId ||
        fileRef.spaceId !== directoryRef.spaceId
      ) {
        throw new StorageError('InvalidArgument');
      }
      return createStorageFile(operations, fileRef);
    },

    stat(context) {
      return context !== undefined
        ? operations.statEntry(directoryRef, context)
        : operations.statEntry(directoryRef);
    },

    semantics() {
      return operations.spaceSemantics(directoryRef);
    },

    capabilities(context) {
      return context !== undefined
        ? operations.spaceCapabilities(directoryRef, context)
        : operations.spaceCapabilities(directoryRef);
    },

    list(request, context) {
      if (context !== undefined) return operations.listDirectory(directoryRef, request, context);
      if (request !== undefined) return operations.listDirectory(directoryRef, request);
      return operations.listDirectory(directoryRef);
    },

    async createDirectory(name, context) {
      const target = { parent: directoryRef, name };
      const entry =
        context !== undefined
          ? await operations.createDirectory(target, context)
          : await operations.createDirectory(target);
      return {
        entry,
        directory: createStorageDirectory(operations, entry.ref),
      };
    },

    prepareUpload(name, source) {
      return operations.prepareUpload(directoryRef, name, source);
    },

    copyEntry(source, name, context) {
      const target = { parent: directoryRef, name };
      return context !== undefined
        ? operations.copyWithin(source, target, context)
        : operations.copyWithin(source, target);
    },

    moveEntry(source, name, context) {
      const target = { parent: directoryRef, name };
      return context !== undefined
        ? operations.moveWithin(source, target, context)
        : operations.moveWithin(source, target);
    },
  };
}
