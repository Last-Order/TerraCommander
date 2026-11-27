import { StorageAccess, StorageError } from '@main/storage';
import type {
  ByteSource,
  DirectoryScope,
  OperationContext,
  ReadHandle,
  ReopenableByteSource,
  WriteExecution,
  WriteOptions,
} from '@main/storage/core/contracts';
import {
  entryKey,
  type Capabilities,
  type CreateTarget,
  type Entry,
  type EntryPage,
  type EntryRef,
  type ListRequest,
  type ReadOptions,
  type RemoveOptions,
  type SpaceSemantics,
  type WriteTarget,
} from '@shared/storage';
import type { StorageConnectionManager } from './storage-connections';
import { createStorageDirectory, type StorageDirectory } from './storage-directory';
import { createStorageFile, type StorageFile } from './storage-file';
import type { TransferInspection, TransferMode, TransferSourceRef } from './storage-provider';
import type { StorageSpaceCatalog } from './storage-spaces';

export interface StorageEntryOperationsOptions {
  storage: StorageAccess;
  connections: StorageConnectionManager;
  spaces: StorageSpaceCatalog;
}

/** Space-bounded entry operations and metadata queries shared by browsing, transfers, and tasks. */
export class StorageEntryOperations {
  private readonly storage: StorageAccess;
  private readonly connections: StorageConnectionManager;
  private readonly spaces: StorageSpaceCatalog;

  constructor(options: StorageEntryOperationsOptions) {
    this.storage = options.storage;
    this.connections = options.connections;
    this.spaces = options.spaces;
  }

  directory(ref: EntryRef): StorageDirectory {
    return createStorageDirectory(this, ref);
  }

  file(ref: EntryRef): StorageFile {
    return createStorageFile(this, ref);
  }

  spaceSemantics(ref: EntryRef): Promise<SpaceSemantics | undefined> {
    return this.spaces.spaceSemantics(ref);
  }

  spaceCapabilities(ref: EntryRef, context?: OperationContext): Promise<Capabilities> {
    return this.spaces.withBrowsableSpace(ref, () =>
      this.storage.capabilities(
        { kind: 'space', connectionId: ref.connectionId, spaceId: ref.spaceId },
        context,
      ),
    );
  }

  statEntry(ref: EntryRef, context?: OperationContext): Promise<Entry> {
    return this.spaces.withBrowsableSpace(ref, () => this.storage.stat(ref, context));
  }

  listDirectory(
    parent: EntryRef,
    request?: string | ListRequest,
    context?: OperationContext,
  ): Promise<EntryPage> {
    const listRequest = typeof request === 'string' ? { cursor: request } : request;
    return this.spaces.withBrowsableSpace(parent, () =>
      this.storage.list(parent, listRequest, context),
    );
  }

  readEntry(ref: EntryRef, options?: ReadOptions, context?: OperationContext): Promise<ReadHandle> {
    return this.spaces.withBrowsableSpace(ref, () => this.storage.read(ref, options, context));
  }

  resolveLocalPath(ref: EntryRef): Promise<{ path: string; kind: Entry['kind'] }> {
    const integration = this.connections.builtInIntegration(ref.connectionId);
    if (!integration?.resolvePath) {
      return Promise.reject(new StorageError('InvalidArgument'));
    }
    return this.spaces.withBrowsableSpace(ref, () => integration.resolvePath!(ref));
  }

  async inspectTransfer(
    target: EntryRef,
    sources: readonly TransferSourceRef[],
    mode: TransferMode,
    context?: OperationContext,
  ): Promise<TransferInspection> {
    if (sources.some((source) => source.ref.connectionId !== target.connectionId)) {
      throw new StorageError('InvalidArgument');
    }
    const integration = await this.connections.resolveIntegration(target.connectionId);
    if (!integration.inspectTransfer) {
      const targetKey = entryKey(target);
      const selfContained = sources.some(
        (source) => source.kind === 'directory' && entryKey(source.ref) === targetKey,
      );
      const crossSpace = sources.some((source) => source.ref.spaceId !== target.spaceId);
      return {
        selfContained,
        moveStrategy: mode === 'move' && crossSpace ? 'unsupported' : 'native',
      };
    }
    const distinctSpaces = new Map<string, EntryRef>([[target.spaceId, target]]);
    for (const source of sources) {
      if (!distinctSpaces.has(source.ref.spaceId)) {
        distinctSpaces.set(source.ref.spaceId, source.ref);
      }
    }
    let wrapped = () => integration.inspectTransfer!(target, sources, mode, context);
    for (const spaceRef of distinctSpaces.values()) {
      const next = wrapped;
      wrapped = () => this.spaces.withBrowsableSpace(spaceRef, next);
    }
    return wrapped();
  }

  openDirectoryScope(root: EntryRef, context?: OperationContext): Promise<DirectoryScope> {
    return this.spaces.withBrowsableSpace(root, () =>
      this.storage.openDirectoryScope(root, context),
    );
  }

  writeEntry(
    target: WriteTarget,
    source: ByteSource,
    context?: OperationContext,
    options?: WriteOptions,
  ): Promise<Entry> {
    const ref = target.kind === 'create' ? target.parent : target.ref;
    return this.spaces.withBrowsableSpace(ref, () =>
      this.storage.write(target, source, context, options),
    );
  }

  prepareWrite(
    target: WriteTarget,
    source: ReopenableByteSource,
    options?: WriteOptions,
  ): WriteExecution {
    const ref = target.kind === 'create' ? target.parent : target.ref;
    const execution = this.storage.createWriteSession(target, source, options);
    return {
      run: (context) => this.spaces.withBrowsableSpace(ref, () => execution.run(context)),
      ...(execution.discard
        ? {
            discard: (context) =>
              this.spaces.withBrowsableSpace(ref, () => execution.discard!(context)),
          }
        : {}),
    };
  }

  prepareUpload(parent: EntryRef, name: string, source: ReopenableByteSource): WriteExecution {
    return this.prepareWrite({ kind: 'create', parent, name, policy: 'create-only' }, source);
  }

  createDirectory(target: CreateTarget, context?: OperationContext): Promise<Entry> {
    return this.spaces.withBrowsableSpace(target.parent, () =>
      this.storage.createDirectory(target, context),
    );
  }

  copyWithin(ref: EntryRef, target: CreateTarget, context?: OperationContext): Promise<Entry> {
    return this.spaces.withBrowsableSpace(ref, () =>
      this.spaces.withBrowsableSpace(target.parent, () =>
        this.storage.copyWithin(ref, target, context),
      ),
    );
  }

  moveWithin(ref: EntryRef, target: CreateTarget, context?: OperationContext): Promise<Entry> {
    return this.spaces.withBrowsableSpace(ref, () =>
      this.spaces.withBrowsableSpace(target.parent, () =>
        this.storage.moveWithin(ref, target, context),
      ),
    );
  }

  renameEntry(ref: EntryRef, name: string, context?: OperationContext): Promise<Entry> {
    return this.spaces.withBrowsableSpace(ref, () => this.storage.rename(ref, name, context));
  }

  deleteEntry(ref: EntryRef, context?: OperationContext, options?: RemoveOptions): Promise<void> {
    return this.spaces.withBrowsableSpace(ref, () => this.storage.remove(ref, context, options));
  }
}
