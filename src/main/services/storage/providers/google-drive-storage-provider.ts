import {
  googleDriveAdapterFactory,
  googleDriveSpaceSemantics,
  myDriveSpace,
} from '@main/storage/providers/google-drive/google-drive-adapter';
import type { AccountStorageProviderIntegration } from '../storage-provider';

export function createGoogleDriveStorageProvider(): AccountStorageProviderIntegration {
  return {
    kind: 'account',
    provider: 'google-drive',
    defaultAuthentication: { method: 'browser' },
    spaceSemantics: googleDriveSpaceSemantics,
    createAdapterFactory: () => googleDriveAdapterFactory(),
    builtInSpace: (connectionId) => myDriveSpace(connectionId),
    summarizeAccount: (account, spaces, needsAuthorization) => ({
      id: account.id,
      provider: 'google-drive',
      name: account.displayName || account.email || 'Google Drive',
      detail:
        account.email && account.displayName ? 'Google Drive · ' + account.email : 'Google Drive',
      needsAuthorization,
      spaces,
    }),
  };
}
