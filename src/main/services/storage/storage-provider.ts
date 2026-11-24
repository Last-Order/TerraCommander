import type { AdapterFactory } from '@main/storage';
import type { AccountSetupRequest, AccountSummary } from '@shared/accounts';
import type { ConnectionDefinition, Entry, EntryRef, Space, SpaceSemantics } from '@shared/storage';
import type { StorageConnectionSummary, StorageProvider } from '@shared/storage-browser';

export interface LocalStorageProviderIntegration {
  readonly kind: 'local';
  readonly provider: StorageProvider;
  readonly connectionDefinition: ConnectionDefinition;
  readonly spaceSemantics?: SpaceSemantics | undefined;
  createAdapterFactory(): AdapterFactory;
  summarizeConnection(spaces: Space[]): StorageConnectionSummary;
  extraKnownSpaces(connectionId: string): Space[];
  validateStoredSpace(space: { id: string; locator?: string }): boolean;
  addFolder(path: string): Promise<Space>;
  resolvePath?(ref: EntryRef): Promise<{ path: string; kind: Entry['kind']; dev?: number }>;
}

export interface AccountStorageProviderIntegration {
  readonly kind: 'account';
  readonly provider: StorageProvider;
  readonly defaultAuthentication: AccountSetupRequest;
  readonly spaceSemantics?: SpaceSemantics | undefined;
  createAdapterFactory(): AdapterFactory;
  summarizeAccount(
    account: AccountSummary,
    spaces: Space[],
    needsAuthorization: boolean,
  ): StorageConnectionSummary;
  builtInSpace?(connectionId: string): Space | undefined;
  validateStoredSpace?(space: { id: string; locator?: string }): boolean;
}

export type StorageProviderIntegration =
  | LocalStorageProviderIntegration
  | AccountStorageProviderIntegration;
