import { localConnectionId } from '@shared/storage-browser';
import type { StoragePreferences } from '../storage-preferences';
import type { StorageProviderIntegration } from '../storage-provider';
import { createGoogleDriveStorageProvider } from './google-drive-storage-provider';
import { createLocalStorageProvider, isValidLocalStoredSpace } from './local-storage-provider';

export function validateDefaultStoredSpace(
  connectionId: string,
  space: { id: string; locator?: string },
): boolean {
  return connectionId === localConnectionId ? isValidLocalStoredSpace(space) : true;
}

export function createDefaultStorageProviders(
  preferences: StoragePreferences,
): StorageProviderIntegration[] {
  return [createLocalStorageProvider(preferences), createGoogleDriveStorageProvider()];
}
