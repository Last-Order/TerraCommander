import { realpath, stat } from 'node:fs/promises';
import type { Space } from '../../../../shared/storage';
import { emptyLocalConnection, localConnectionId } from '../../../../shared/storage-browser';
import { StorageError } from '../../../storage';
import {
  localAdapterFactory,
  localFailure,
  localSpace,
} from '../../../storage/providers/local/local-adapter';
import type { StoragePreferences } from '../storage-preferences';
import type { LocalStorageProviderIntegration } from '../storage-provider';

export function isValidLocalStoredSpace({ locator }: { id: string; locator?: string }): boolean {
  return locator === '.';
}

export function createLocalStorageProvider(
  preferences: StoragePreferences,
): LocalStorageProviderIntegration {
  return {
    kind: 'local',
    provider: 'local',
    connectionDefinition: {
      id: localConnectionId,
      provider: 'local',
      configuration: {},
    },
    createAdapterFactory: () => localAdapterFactory(() => preferences.folders()),
    summarizeConnection: (spaces) => ({
      ...emptyLocalConnection,
      detail: { messageKey: 'localFileSystem' },
      spaces,
    }),
    extraKnownSpaces: (connectionId) =>
      preferences.folders().map((folder) => localSpace(connectionId, folder)),
    validateStoredSpace: isValidLocalStoredSpace,
    async addFolder(path: string): Promise<Space> {
      try {
        const folder = await realpath(path);
        if (!(await stat(folder)).isDirectory()) throw new StorageError('InvalidArgument');
        preferences.addFolder(folder);
        return localSpace(localConnectionId, folder);
      } catch (error) {
        localFailure(error);
      }
    },
  };
}
