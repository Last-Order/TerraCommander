import type { AccountProviderDescriptor } from '../../../../shared/accounts';

/** Safe to enumerate without importing OAuth code, SDKs, or client configuration. */
export const googleDriveDescriptor: AccountProviderDescriptor = {
  id: 'google-drive',
  name: 'Google Drive',
  capabilities: {
    authenticationMethods: [
      { id: 'browser', kind: 'browser', name: 'Google account authorization' },
    ],
    updateAuthentication: true,
    verify: true,
  },
};
