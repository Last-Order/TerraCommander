import {
  localAdapterFactory,
  localSpaceSemantics,
  locateLocalEntry,
} from '@main/storage/providers/local/local-adapter';
import { listLocalVolumes } from '@main/storage/providers/local/local-volumes';
import { localConnectionId } from '@shared/storage-browser';
import type { StorageProviderIntegration } from '../storage-provider';

function isValidLocalStoredSpace({ locator }: { id: string; locator?: string }): boolean {
  return locator === '.';
}

export function createLocalStorageProvider(
  volumes: typeof listLocalVolumes = listLocalVolumes,
): StorageProviderIntegration {
  return {
    provider: 'local',
    authMode: 'none',
    connection: {
      kind: 'built-in',
      connectionDefinition: {
        id: localConnectionId,
        provider: 'local',
        configuration: {},
      },
      summarize: (spaces) => ({
        id: localConnectionId,
        provider: 'local',
        name: { messageKey: 'thisPc' },
        detail: { messageKey: 'localFileSystem' },
        needsAuthorization: false,
        spaces,
      }),
    },
    spaceSemantics: localSpaceSemantics,
    createAdapterFactory: () => localAdapterFactory(volumes),
    validateStoredSpace: isValidLocalStoredSpace,
    async resolvePath(ref) {
      const { path, info, kind } = await locateLocalEntry(ref, volumes);
      return { path, kind, dev: info.dev };
    },
  };
}
