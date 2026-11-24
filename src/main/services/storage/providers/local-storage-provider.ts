import {
  localAdapterFactory,
  localSpaceSemantics,
  locateLocalEntry,
} from '@main/storage/providers/local/local-adapter';
import { listLocalVolumes } from '@main/storage/providers/local/local-volumes';
import { emptyLocalConnection, localConnectionId } from '@shared/storage-browser';
import type { LocalStorageProviderIntegration } from '../storage-provider';

export function isValidLocalStoredSpace({ locator }: { id: string; locator?: string }): boolean {
  return locator === '.';
}

export function createLocalStorageProvider(
  volumes: typeof listLocalVolumes = listLocalVolumes,
): LocalStorageProviderIntegration {
  return {
    kind: 'local',
    provider: 'local',
    connectionDefinition: {
      id: localConnectionId,
      provider: 'local',
      configuration: {},
    },
    spaceSemantics: localSpaceSemantics,
    createAdapterFactory: () => localAdapterFactory(volumes),
    summarizeConnection: (spaces) => ({
      ...emptyLocalConnection,
      detail: { messageKey: 'localFileSystem' },
      spaces,
    }),
    validateStoredSpace: isValidLocalStoredSpace,
    async resolvePath(ref) {
      const { path, info, kind } = await locateLocalEntry(ref, volumes);
      return { path, kind, dev: info.dev };
    },
  };
}
