import {
  googleDriveAdapterFactory,
  googleDriveSpaceSemantics,
  myDriveSpace,
} from '@main/storage/providers/google-drive/google-drive-adapter';
import type { StorageProviderIntegration } from '../storage-provider';

export function createGoogleDriveStorageProvider(): StorageProviderIntegration {
  return {
    provider: 'google-drive',
    authMode: 'browser',
    connection: {
      kind: 'account',
      defaultAuthentication: { method: 'browser' },
      summarize: (account, spaces, needsAuthorization) => ({
        id: account.id,
        provider: 'google-drive',
        name: account.displayName || account.email || 'Google Drive',
        detail:
          account.email && account.displayName ? 'Google Drive · ' + account.email : 'Google Drive',
        needsAuthorization,
        spaces,
      }),
    },
    spaceSemantics: googleDriveSpaceSemantics,
    createAdapterFactory: () => googleDriveAdapterFactory(),
    builtInSpace: (connectionId) => myDriveSpace(connectionId),
  };
}
