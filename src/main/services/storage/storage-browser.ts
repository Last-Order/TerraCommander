import type { EntryRef, Space } from '@shared/storage';
import type {
  SpaceChoice,
  StorageConnectionSummary,
  StorageProvider,
} from '@shared/storage-browser';
import { StorageAccess, StorageError, type StorageLogger } from '@main/storage';
import type { ReopenableByteSource, WriteExecution } from '@main/storage/core/contracts';
import type { AccountRuntime } from '../application-services';
import { DownloadService } from '../downloads/download-service';
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

  addLocalFolder(path: string): Promise<Space> {
    return this.spaces.addLocalFolder(path);
  }

  addConnection(provider: StorageProvider, owner?: number): Promise<StorageConnectionSummary> {
    return this.connections.addConnection(
      provider,
      (account, integration) =>
        integration.summarizeAccount(
          account,
          this.spaces.displayedSpaces(account.id, integration),
          false,
        ),
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

  async validateUploadDestination(parent: EntryRef): Promise<void> {
    const directory = await this.spaces.withBrowsableSpace(parent, () => this.storage.stat(parent));
    if (directory.kind !== 'directory') throw new StorageError('InvalidArgument');
    if (directory.capabilities.write?.support === 'unsupported') {
      throw new StorageError('PermissionDenied');
    }
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
    if (this.directoryMeasurement?.owner === owner) this.directoryMeasurement.controller.abort();
    this.cancelAuthorization(owner);
  }

  async dispose(): Promise<void> {
    this.connections.cancelAuthorization();
    this.directoryMeasurement?.controller.abort();
    try {
      await this.downloads.dispose();
    } finally {
      await this.connections.dispose();
    }
  }
}
