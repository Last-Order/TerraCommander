import type { AdapterFactory, OperationContext } from '@main/storage';
import type { AccountSetupRequest, AccountSummary } from '@shared/accounts';
import type { ConnectionDefinition, Entry, EntryRef, Space, SpaceSemantics } from '@shared/storage';
import type {
  StorageConnectionSummary,
  StorageProvider,
  StorageProviderAuthMode,
} from '@shared/storage-browser';

export type TransferMode = 'copy' | 'move';

export type MoveStrategy = 'native' | 'copy-delete' | 'unsupported';

export interface TransferSourceRef {
  readonly ref: EntryRef;
  readonly kind: Entry['kind'];
}

export interface TransferInspection {
  readonly selfContained: boolean;
  readonly moveStrategy: MoveStrategy;
}

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
  validateEntryName?(name: string): boolean;
  /** Returns an account-independent object key when the same underlying entry can appear under multiple connections. */
  canonicalEntryKey?(ref: EntryRef): string | undefined;
  inspectTransfer?(
    target: EntryRef,
    sources: readonly TransferSourceRef[],
    mode: TransferMode,
    context?: OperationContext,
  ): Promise<TransferInspection>;
}

export function createStoredSpaceValidator(
  providers: readonly StorageProviderIntegration[],
): (provider: string, space: { id: string; locator?: string }) => boolean {
  const byProvider = new Map<string, StorageProviderIntegration>(
    providers.map((integration) => [integration.provider, integration]),
  );
  return (provider, space) => byProvider.get(provider)?.validateStoredSpace?.(space) ?? true;
}
