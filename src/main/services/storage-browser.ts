import type { EntryRef, Space } from '../../shared/storage';
import type {
  SpaceChoice,
  StorageConnectionSummary,
  StorageProvider,
} from '../../shared/storage-browser';
import { StorageAccess, StorageError, type StorageLogger } from '../storage';
import type { AccountRuntime } from './application-services';
import { DownloadService } from './download-service';
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
  private directoryMeasurement: { id: string; controller: AbortController } | undefined;

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

  addConnection(provider: StorageProvider): Promise<StorageConnectionSummary> {
    return this.connections.addConnection(provider, (account, integration) =>
      integration.summarizeAccount(
        account,
        this.spaces.displayedSpaces(account.id, integration),
        false,
      ),
    );
  }

  reauthorize(id: string): Promise<void> {
    return this.connections.reauthorize(id);
  }

  cancelAuthorization(): void {
    this.connections.cancelAuthorization();
  }

  listDirectory(parent: EntryRef, cursor?: string) {
    return this.spaces.withBrowsableSpace(parent, () => this.storage.list(parent, { cursor }));
  }

  renameEntry(ref: EntryRef, name: string) {
    this.downloads.assertSourceAvailable(ref);
    return this.spaces.withBrowsableSpace(ref, () => this.storage.rename(ref, name));
  }

  deleteEntry(ref: EntryRef): Promise<void> {
    this.downloads.assertSourceAvailable(ref);
    return this.spaces.withBrowsableSpace(ref, () => this.storage.remove(ref));
  }

  async measureDirectorySize(id: string, folders: EntryRef[]): Promise<number | null> {
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
    const measurement = { id, controller: new AbortController() };
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
