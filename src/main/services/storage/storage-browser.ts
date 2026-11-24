import { StorageAccess, StorageError, type StorageLogger } from '@main/storage';
import type { ReopenableByteSource, WriteExecution } from '@main/storage/core/contracts';
import type { CreateTarget, Entry, EntryRef, SpaceSemantics } from '@shared/storage';
import type {
  SpaceChoice,
  StorageConnectionSummary,
  StorageProvider,
} from '@shared/storage-browser';
import type { AccountRuntime } from '../application-services';
import { DownloadService } from '../downloads/download-service';
import { UploadService } from '../uploads/upload-service';
import { measureDirectorySize } from './measure-directory-size';
import { StorageConnectionManager } from './storage-connections';
import type { StoragePreferences } from './storage-preferences';
import type { StorageProviderIntegration } from './storage-provider';
import { StorageSpaceCatalog } from './storage-spaces';

export interface StorageBrowserOptions {
  preferences: StoragePreferences;
  getAccounts: (signal?: AbortSignal) => Promise<AccountRuntime>;
  logger: StorageLogger;
  providers: readonly StorageProviderIntegration[];
}

export class StorageBrowser {
  readonly downloads: DownloadService;
  readonly uploads: UploadService;
  private readonly connections: StorageConnectionManager;
  private readonly storage: StorageAccess;
  private readonly spaces: StorageSpaceCatalog;
  private directoryMeasurement:
    | { id: string; owner: number | undefined; controller: AbortController }
    | undefined;

  constructor({ preferences, getAccounts, logger, providers }: StorageBrowserOptions) {
    this.connections = new StorageConnectionManager(getAccounts, logger, providers);
    this.storage = new StorageAccess(this.connections.registry);
    this.spaces = new StorageSpaceCatalog(preferences, this.storage, this.connections);
    this.downloads = new DownloadService({
      stat: (ref, context) =>
        this.spaces.withBrowsableSpace(ref, () => this.storage.stat(ref, context)),
      read: (ref, options, context) =>
        this.spaces.withBrowsableSpace(ref, () => this.storage.read(ref, options, context)),
      list: (ref, request, context) =>
        this.spaces.withBrowsableSpace(ref, () => this.storage.list(ref, request, context)),
    });
    this.uploads = new UploadService({
      stat: (ref, context) =>
        this.spaces.withBrowsableSpace(ref, () => this.storage.stat(ref, context)),
      createDirectory: (target, context) =>
        this.spaces.withBrowsableSpace(target.parent, () =>
          this.storage.createDirectory(target, context),
        ),
      prepareUpload: (parent, name, source) => this.prepareUpload(parent, name, source),
    });
  }

  listConnections(): Promise<StorageConnectionSummary[]> {
    return this.spaces.listConnections();
  }

  listSpaces(id: string, refresh = false): Promise<SpaceChoice[]> {
    return this.spaces.listSpaces(id, refresh);
  }

  saveSpaces(id: string, spaceIds: string[]): Promise<void> {
    return this.spaces.saveSpaces(id, spaceIds);
  }

  addConnection(provider: StorageProvider, owner?: number): Promise<StorageConnectionSummary> {
    return this.connections.addConnection(
      provider,
      (id, integration) => this.spaces.displayedSpaces(id, integration),
      owner,
    );
  }

  reauthorize(id: string, owner?: number): Promise<void> {
    return this.connections.reauthorize(id, owner);
  }

  cancelAuthorization(owner?: number): void {
    this.connections.cancelAuthorization(owner);
  }

  listDirectory(parent: EntryRef, cursor?: string) {
    return this.spaces.withBrowsableSpace(parent, () => this.storage.list(parent, { cursor }));
  }

  spaceSemantics(ref: EntryRef): Promise<SpaceSemantics | undefined> {
    return this.spaces.spaceSemantics(ref);
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

  statEntry(ref: EntryRef): Promise<Entry> {
    return this.spaces.withBrowsableSpace(ref, () => this.storage.stat(ref));
  }

  resolveLocalPath(ref: EntryRef): Promise<{ path: string; kind: Entry['kind']; dev?: number }> {
    const integration = this.connections.builtInIntegration(ref.connectionId);
    if (!integration?.resolvePath) {
      return Promise.reject(new StorageError('InvalidArgument'));
    }
    return this.spaces.withBrowsableSpace(ref, () => integration.resolvePath!(ref));
  }

  createDirectory(target: CreateTarget): Promise<Entry> {
    return this.spaces.withBrowsableSpace(target.parent, () =>
      this.storage.createDirectory(target),
    );
  }

  copyWithin(ref: EntryRef, target: CreateTarget): Promise<Entry> {
    this.downloads.assertSourceAvailable(ref);
    return this.spaces.withBrowsableSpace(ref, () =>
      this.spaces.withBrowsableSpace(target.parent, () => this.storage.copyWithin(ref, target)),
    );
  }

  moveWithin(ref: EntryRef, target: CreateTarget): Promise<Entry> {
    this.downloads.assertSourceAvailable(ref);
    return this.spaces.withBrowsableSpace(ref, () =>
      this.spaces.withBrowsableSpace(target.parent, () => this.storage.moveWithin(ref, target)),
    );
  }

  renameEntry(ref: EntryRef, name: string) {
    this.downloads.assertSourceAvailable(ref);
    return this.spaces.withBrowsableSpace(ref, () => this.storage.rename(ref, name));
  }

  deleteEntry(ref: EntryRef): Promise<void> {
    this.downloads.assertSourceAvailable(ref);
    return this.spaces.withBrowsableSpace(ref, () => this.storage.remove(ref));
  }

  async measureDirectorySize(
    id: string,
    folders: EntryRef[],
    owner?: number,
  ): Promise<number | null> {
    const first = folders[0];
    if (
      !first ||
      folders.some(
        ({ connectionId, spaceId }) =>
          connectionId !== first.connectionId || spaceId !== first.spaceId,
      )
    ) {
      throw new StorageError('InvalidArgument');
    }

    this.directoryMeasurement?.controller.abort();
    const measurement = { id, owner, controller: new AbortController() };
    this.directoryMeasurement = measurement;
    try {
      return await this.spaces.withBrowsableSpace(first, () =>
        measureDirectorySize(this.storage, folders, measurement.controller.signal),
      );
    } finally {
      if (this.directoryMeasurement === measurement) this.directoryMeasurement = undefined;
    }
  }

  cancelDirectoryMeasurement(id: string): void {
    if (this.directoryMeasurement?.id === id) this.directoryMeasurement.controller.abort();
  }

  cancelOwnerOperations(owner: number): void {
    this.downloads.cancelOwner(owner);
    this.uploads.cancelOwner(owner);
    if (this.directoryMeasurement?.owner === owner) this.directoryMeasurement.controller.abort();
    this.cancelAuthorization(owner);
  }

  async dispose(): Promise<void> {
    this.connections.cancelAuthorization();
    this.directoryMeasurement?.controller.abort();
    try {
      await Promise.allSettled([this.downloads.dispose(), this.uploads.dispose()]);
    } finally {
      await this.connections.dispose();
    }
  }
}
