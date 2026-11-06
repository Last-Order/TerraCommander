import { app, shell } from 'electron';
import type { AccountProviderServices } from '../../core/ports';
import { createGoogleDriveProvider } from './create-provider';
import { readGoogleClientConfiguration } from './oauth/client-configuration';
import { GoogleSdkGateway } from './oauth/google-sdk-gateway';
import { listenForGoogleCallback } from './oauth/loopback-callback';
import type { GoogleClientConfiguration } from './ports';

// Substituted in the deferred main-process provider chunk only.
declare const __GOOGLE_DRIVE_OAUTH_CLIENT__: GoogleClientConfiguration | undefined;

export function createDesktopGoogleDriveProvider(services: AccountProviderServices) {
  const bundled =
    typeof __GOOGLE_DRIVE_OAUTH_CLIENT__ === 'undefined'
      ? undefined
      : __GOOGLE_DRIVE_OAUTH_CLIENT__;
  return createGoogleDriveProvider(services, {
    gateway: new GoogleSdkGateway(
      readGoogleClientConfiguration(bundled, !app.isPackaged, process.env),
    ),
    authorizationEnvironment: {
      openBrowser: (url) => shell.openExternal(url),
      listen: listenForGoogleCallback,
    },
  });
}
