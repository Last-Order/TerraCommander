import { shell } from 'electron';
import type { AccountProviderServices } from '../../core/ports';
import { createGoogleDriveProvider } from './create-provider';
import { readGoogleClientConfiguration } from './oauth/client-configuration';
import { GoogleSdkGateway } from './oauth/google-sdk-gateway';
import { listenForGoogleCallback } from './oauth/loopback-callback';

export function createDesktopGoogleDriveProvider(services: AccountProviderServices) {
  return createGoogleDriveProvider(services, {
    gateway: new GoogleSdkGateway(
      readGoogleClientConfiguration(
        import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID,
        import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_SECRET,
      ),
    ),
    authorizationEnvironment: {
      openBrowser: (url) => shell.openExternal(url),
      listen: listenForGoogleCallback,
    },
  });
}
