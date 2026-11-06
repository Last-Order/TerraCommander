import type {
  AccountCheck,
  AccountProviderDescriptor,
  AccountSetupRequest,
  AccountState,
} from '../../../shared/accounts';
import type { OperationContext } from '../../storage/core/contracts';
import type { StorageLogger } from '../../storage/ports/services';
import type { AccountRepository } from '../persistence/account-repository';
import type { CredentialStore } from '../persistence/credential-store';
import type { AccountSnapshot } from './models';

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
  repository: AccountRepository;
  credentials: CredentialStore;
  now: () => number;
  logger?: StorageLogger;
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
