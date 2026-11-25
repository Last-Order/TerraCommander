import { StorageAccess, type StorageLogger } from '@main/storage';
import type { AccountRuntime } from '../application-services';
import { DownloadService } from '../downloads/download-service';
import { UploadService } from '../uploads/upload-service';
import { StorageBrowser } from './storage-browser';
import { StorageConnectionManager } from './storage-connections';
import { StorageEntryOperations } from './storage-entry-operations';
import type { StoragePreferences } from './storage-preferences';
import type { StorageProviderIntegration } from './storage-provider';
import { StorageSpaceCatalog } from './storage-spaces';

export interface StorageServicesOptions {
  preferences: StoragePreferences;
  getAccounts: (signal?: AbortSignal) => Promise<AccountRuntime>;
  logger: StorageLogger;
  providers: readonly StorageProviderIntegration[];
}

export interface StorageServices {
  readonly browser: StorageBrowser;
  readonly operations: StorageEntryOperations;
  readonly downloads: DownloadService;
  readonly uploads: UploadService;
  dispose(): Promise<void>;
}

export function createStorageServices({
  preferences,
  getAccounts,
  logger,
  providers,
}: StorageServicesOptions): StorageServices {
  const connections = new StorageConnectionManager(getAccounts, logger, providers);
  const storage = new StorageAccess(connections.registry);
  const spaces = new StorageSpaceCatalog(preferences, storage, connections);

  let downloads!: DownloadService;
  const operations = new StorageEntryOperations({
    storage,
    connections,
    spaces,
    beforeSourceMutation: (ref) => downloads.assertSourceAvailable(ref),
  });
  downloads = new DownloadService({
    stat: (ref, context) => operations.statEntry(ref, context),
    read: (ref, options, context) => operations.readEntry(ref, options, context),
    list: (ref, request, context) => operations.listDirectory(ref, request, context),
  });
  const uploads = new UploadService({
    stat: (ref, context) => operations.statEntry(ref, context),
    createDirectory: (target, context) => operations.createDirectory(target, context),
    prepareUpload: (parent, name, source) => operations.prepareUpload(parent, name, source),
  });
  const browser = new StorageBrowser({
    connections,
    storage,
    spaces,
    operations,
  });

  let disposal: Promise<void> | undefined;
  return {
    browser,
    operations,
    downloads,
    uploads,
    dispose() {
      disposal ??= (async () => {
        browser.dispose();
        await connections.dispose();
      })();
      return disposal;
    },
  };
}
