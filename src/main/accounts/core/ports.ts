import type {
  AccountCheck,
  AccountProviderDescriptor,
  AccountSetupRequest,
  AccountState,
} from '@shared/accounts';
import type { JsonValue } from '@shared/json';
import type { StructuredLogger } from '@main/common/logger';
import type { OperationContext } from '@main/common/operation-context';
import type { AccountRecord, AccountSnapshot, CredentialBinding } from './models';

export interface AccountRepositoryPort {
  list(provider?: string): AccountRecord[];
  get(id: string): AccountRecord;
  findIdentity(provider: string, identityKey: string): AccountRecord | undefined;
  findCredential(reference: string): AccountRecord;
  save(
    record: AccountRecord,
    expectedRevision: number | undefined,
    ctx: OperationContext,
  ): Promise<void>;
  remove(id: string, expectedRevision: number, ctx: OperationContext): Promise<void>;
  flush(): Promise<void>;
}

export interface CredentialStorePort {
  encrypt(binding: CredentialBinding, payload: JsonValue, ctx: OperationContext): Promise<string>;
  decrypt(
    binding: CredentialBinding,
    ciphertext: string,
    ctx: OperationContext,
  ): Promise<{ payload: JsonValue; needsReEncryption: boolean }>;
}

/** Provider operations commit through the shared repository; authentication stays provider-owned. */
export interface AccountProvider {
  readonly id: string;
  /** Validate setup, persist through the shared repository, and return the committed account ID. */
  add(request: AccountSetupRequest, ctx: OperationContext): Promise<string>;
  updateAuthentication(
    id: string,
    request: AccountSetupRequest,
    ctx: OperationContext,
  ): Promise<void>;
  verify(id: string, ctx: OperationContext): Promise<AccountCheck>;
  remove(id: string, ctx: OperationContext): Promise<void>;
  /** Read in-memory status only; listing metadata must not decrypt or contact a provider. */
  getState(id: string): AccountState;
  /** Return a backend-only handle; its shape and refresh behavior belong to this provider. */
  resolveCredentials(reference: string, ctx: OperationContext): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface AccountProviderServices {
  repository: AccountRepositoryPort;
  credentials: CredentialStorePort;
  now: () => number;
  logger?: StructuredLogger;
}

export interface AccountProviderRegistration {
  descriptor: AccountProviderDescriptor;
  create: (
    services: AccountProviderServices,
    signal: AbortSignal,
  ) => AccountProvider | Promise<AccountProvider>;
}

/** A synchronous atomic replacement defines the cancellation/commit boundary. */
export interface AccountSnapshotStore {
  read(): unknown;
  write(snapshot: AccountSnapshot): void;
}

export interface AccountCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<{ plaintext: string; needsReEncryption: boolean }>;
}
