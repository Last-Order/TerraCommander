import type { AdapterFactory } from '@main/storage';
import type { AccountSetupRequest, AccountSummary } from '@shared/accounts';
import type { ConnectionDefinition, Entry, EntryRef, Space, SpaceSemantics } from '@shared/storage';
import type {
  StorageConnectionSummary,
  StorageProvider,
  StorageProviderAuthMode,
} from '@shared/storage-browser';

export type StorageConnectionSource =
  | {
      readonly kind: 'built-in';
      readonly connectionDefinition: ConnectionDefinition;
      summarize(spaces: Space[]): StorageConnectionSummary;
    }
  | {
      readonly kind: 'account';
      readonly defaultAuthentication: AccountSetupRequest;
      summarize(
        account: AccountSummary,
        spaces: Space[],
        needsAuthorization: boolean,
      ): StorageConnectionSummary;
    };

export interface StorageProviderIntegration {
  readonly provider: StorageProvider;
  readonly authMode: StorageProviderAuthMode;
  readonly connection: StorageConnectionSource;
  readonly spaceSemantics?: SpaceSemantics | undefined;
  createAdapterFactory(): AdapterFactory;
  builtInSpace?(connectionId: string): Space | undefined;
  validateStoredSpace?(space: { id: string; locator?: string }): boolean;
  resolvePath?(ref: EntryRef): Promise<{ path: string; kind: Entry['kind']; dev?: number }>;
}

export function createStoredSpaceValidator(
  providers: readonly StorageProviderIntegration[],
): (provider: string, space: { id: string; locator?: string }) => boolean {
  const byProvider = new Map<string, StorageProviderIntegration>(
    providers.map((integration) => [integration.provider, integration]),
  );
  return (provider, space) => byProvider.get(provider)?.validateStoredSpace?.(space) ?? true;
}
