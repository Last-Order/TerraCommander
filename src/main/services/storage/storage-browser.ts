import { StorageError, type StorageAccess } from '@main/storage';
import type { EntryRef } from '@shared/storage';
import type {
  SpaceChoice,
  StorageConnectionSummary,
  StorageProvider,
} from '@shared/storage-browser';
import { measureDirectorySize } from './measure-directory-size';
import type { StorageConnectionManager } from './storage-connections';
import type { StorageEntryOperations } from './storage-entry-operations';
import type { StorageSpaceCatalog } from './storage-spaces';

export interface StorageBrowserDependencies {
  connections: StorageConnectionManager;
  storage: StorageAccess;
  spaces: StorageSpaceCatalog;
  operations: StorageEntryOperations;
}

/** Renderer-facing browsing, connection, space selection, and directory measurement facade. */
export class StorageBrowser {
  private readonly connections: StorageConnectionManager;
  private readonly storage: StorageAccess;
  private readonly spaces: StorageSpaceCatalog;
  private readonly operations: StorageEntryOperations;
  private directoryMeasurement:
    | { id: string; owner: number | undefined; controller: AbortController }
    | undefined;

  constructor({ connections, storage, spaces, operations }: StorageBrowserDependencies) {
    this.connections = connections;
    this.storage = storage;
    this.spaces = spaces;
    this.operations = operations;
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
    return this.operations.directory(parent).list(cursor);
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
    if (this.directoryMeasurement?.owner === owner) this.directoryMeasurement.controller.abort();
    this.cancelAuthorization(owner);
  }

  dispose(): void {
    this.directoryMeasurement?.controller.abort();
    this.directoryMeasurement = undefined;
  }
}
