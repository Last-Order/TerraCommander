import {
  inspectLocalTransfer,
  localAdapterFactory,
  localSpaceSemanticsFor,
} from '@main/storage/providers/local/local-adapter';
import {
  defaultLocalPlatform,
  type LocalPlatform,
} from '@main/storage/providers/local/local-platform';
import { listLocalVolumes } from '@main/storage/providers/local/local-volumes';
import type { StorageProviderIntegration } from '../storage-provider';

/** Internal singleton connection identifier for the built-in local storage provider. */
export const internalLocalConnectionId = 'local';

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
        id: internalLocalConnectionId,
        provider: 'local',
        configuration: {},
      },
      summarize: (spaces) => ({
        id: internalLocalConnectionId,
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
    validateEntryName: (name) => platform.isValidEntryName(name),
    canonicalEntryKey: (ref) => {
      const locator = platform.caseSensitive ? ref.locator : ref.locator.toLowerCase();
      return `local:${ref.spaceId}:${locator}`;
    },
    inspectTransfer(target, sources, mode, context) {
      return inspectLocalTransfer(target, sources, mode, volumes, platform, context?.signal);
    },
  };
}
