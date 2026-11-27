import { StorageAccess, type StorageLogger } from '@main/storage';
import type { LocalPlatform } from '@main/storage/providers/local/local-platform';
import type { listLocalVolumes } from '@main/storage/providers/local/local-volumes';
import type { AccountRuntime } from '../application-services';
import { TransferService } from '../transfers/transfer-service';
import { LocalPathBridge } from './local-path-bridge';
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
  localVolumes?: typeof listLocalVolumes | undefined;
  localPlatform?: LocalPlatform | undefined;
}

export interface StorageServices {
  readonly browser: StorageBrowser;
  readonly operations: StorageEntryOperations;
  readonly transfers: TransferService;
  readonly localPathBridge: LocalPathBridge;
  dispose(): Promise<void>;
}

export function createStorageServices({
  preferences,
  getAccounts,
  logger,
  providers,
  localVolumes,
  localPlatform,
}: StorageServicesOptions): StorageServices {
  const connections = new StorageConnectionManager(getAccounts, logger, providers);
  const storage = new StorageAccess(connections.registry);
  const spaces = new StorageSpaceCatalog(preferences, storage, connections);

  const operations = new StorageEntryOperations({
    storage,
    connections,
    spaces,
  });
  const transfers = new TransferService(operations);
  const localPathBridge = new LocalPathBridge({
    spaces,
    operations,
    listVolumes: localVolumes,
    platform: localPlatform,
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
    transfers,
    localPathBridge,
    dispose() {
      disposal ??= (async () => {
        browser.dispose();
        await transfers.dispose();
        await connections.dispose();
      })();
      return disposal;
    },
  };
}
