import type { StorageProviderIntegration } from '../storage-provider';
import { createGoogleDriveStorageProvider } from './google-drive-storage-provider';
import { createLocalStorageProvider } from './local-storage-provider';

export function createDefaultStorageProviders(): StorageProviderIntegration[] {
  return [createLocalStorageProvider(), createGoogleDriveStorageProvider()];
}
