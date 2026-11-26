import {
  inspectLocalTransfer,
  localAdapterFactory,
  localSpaceSemanticsFor,
  locateLocalEntry,
} from '@main/storage/providers/local/local-adapter';
import {
  defaultLocalPlatform,
  type LocalPlatform,
} from '@main/storage/providers/local/local-platform';
import { listLocalVolumes } from '@main/storage/providers/local/local-volumes';
import { localConnectionId } from '@shared/storage-browser';
import type { StorageProviderIntegration } from '../storage-provider';

function isValidLocalStoredSpace({ locator }: { id: string; locator?: string }): boolean {
  return locator === '.';
}

export function createLocalStorageProvider(
  volumes: typeof listLocalVolumes = listLocalVolumes,
  platform: LocalPlatform = defaultLocalPlatform,
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
    spaceSemantics: localSpaceSemanticsFor(platform),
    createAdapterFactory: () => localAdapterFactory(volumes, platform),
    validateStoredSpace: isValidLocalStoredSpace,
    async resolvePath(ref) {
      const { path, kind } = await locateLocalEntry(ref, volumes, undefined, undefined, platform);
      return { path, kind };
    },
    inspectTransfer(target, sources, mode, context) {
      return inspectLocalTransfer(target, sources, mode, volumes, platform, context?.signal);
    },
  };
}
