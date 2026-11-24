import { app } from 'electron';
import log from 'electron-log/main';
import Store from 'electron-store';
import type { AccountRuntime } from '../application-services';
import { createDefaultStorageProviders } from './providers/default-providers';
import { StorageBrowser } from './storage-browser';
import { StoragePreferences } from './storage-preferences';
import { createStoredSpaceValidator } from './storage-provider';

export function createDesktopStorageBrowser(
  getAccounts: (signal?: AbortSignal) => Promise<AccountRuntime>,
) {
  const store = new Store<Record<string, unknown>>({
    cwd: app.getPath('userData'),
    name: 'storage-sidebar',
    accessPropertiesByDotNotation: false,
    clearInvalidConfig: false,
  });
  const providers = createDefaultStorageProviders();
  const preferences = new StoragePreferences(
    {
      read: () => (Object.keys(store.store).length ? store.store : undefined),
      write: (snapshot) => {
        store.store = snapshot;
      },
    },
    { validateSpace: createStoredSpaceValidator(providers) },
  );
  return new StorageBrowser({
    preferences,
    getAccounts,
    logger: { event: (name, fields) => log.info(name, fields) },
    providers,
  });
}
