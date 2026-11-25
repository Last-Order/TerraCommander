import { StorageAccess, StorageError } from '@main/storage';
import type {
  OperationContext,
  ReadHandle,
  ReopenableByteSource,
  WriteExecution,
} from '@main/storage/core/contracts';
import type {
  Capabilities,
  CreateTarget,
  Entry,
  EntryPage,
  EntryRef,
  ListRequest,
  ReadOptions,
  SpaceSemantics,
} from '@shared/storage';
import type { StorageConnectionManager } from './storage-connections';
import type { StorageSpaceCatalog } from './storage-spaces';

export interface StorageEntryOperationsOptions {
  storage: StorageAccess;
  connections: StorageConnectionManager;
  spaces: StorageSpaceCatalog;
  beforeSourceMutation?: (ref: EntryRef) => void;
}

/** Space-bounded entry operations and metadata queries shared by browsing, transfers, and tasks. */
export class StorageEntryOperations {
  private readonly storage: StorageAccess;
  private readonly connections: StorageConnectionManager;
  private readonly spaces: StorageSpaceCatalog;
  private readonly beforeSourceMutation: ((ref: EntryRef) => void) | undefined;

  constructor(options: StorageEntryOperationsOptions) {
    this.storage = options.storage;
    this.connections = options.connections;
    this.spaces = options.spaces;
    this.beforeSourceMutation = options.beforeSourceMutation;
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

  resolveLocalPath(ref: EntryRef): Promise<{ path: string; kind: Entry['kind']; dev?: number }> {
    const integration = this.connections.builtInIntegration(ref.connectionId);
    if (!integration?.resolvePath) {
      return Promise.reject(new StorageError('InvalidArgument'));
    }
    return this.spaces.withBrowsableSpace(ref, () => integration.resolvePath!(ref));
  }

  prepareUpload(parent: EntryRef, name: string, source: ReopenableByteSource): WriteExecution {
    const execution = this.storage.createWriteSession(
      { kind: 'create', parent, name, policy: 'create-only' },
      source,
    );
    return {
      run: (context) => this.spaces.withBrowsableSpace(parent, () => execution.run(context)),
    };
  }

  createDirectory(target: CreateTarget, context?: OperationContext): Promise<Entry> {
    return this.spaces.withBrowsableSpace(target.parent, () =>
      this.storage.createDirectory(target, context),
    );
  }

  copyWithin(ref: EntryRef, target: CreateTarget, context?: OperationContext): Promise<Entry> {
    this.beforeSourceMutation?.(ref);
    return this.spaces.withBrowsableSpace(ref, () =>
      this.spaces.withBrowsableSpace(target.parent, () =>
        this.storage.copyWithin(ref, target, context),
      ),
    );
  }

  moveWithin(ref: EntryRef, target: CreateTarget, context?: OperationContext): Promise<Entry> {
    this.beforeSourceMutation?.(ref);
    return this.spaces.withBrowsableSpace(ref, () =>
      this.spaces.withBrowsableSpace(target.parent, () =>
        this.storage.moveWithin(ref, target, context),
      ),
    );
  }

  renameEntry(ref: EntryRef, name: string, context?: OperationContext): Promise<Entry> {
    this.beforeSourceMutation?.(ref);
    return this.spaces.withBrowsableSpace(ref, () => this.storage.rename(ref, name, context));
  }

  deleteEntry(ref: EntryRef, context?: OperationContext): Promise<void> {
    this.beforeSourceMutation?.(ref);
    return this.spaces.withBrowsableSpace(ref, () => this.storage.remove(ref, context));
  }
}
