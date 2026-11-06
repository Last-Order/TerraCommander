import type { StorageLogger } from '../../storage/ports/services';
import { AccountManager } from '../core/account-manager';
import { AccountCredentialResolver } from '../core/account-credential-resolver';
import { AccountProviderRegistry } from '../core/account-provider-registry';
import type {
  AccountCipher,
  AccountProviderRegistration,
  AccountSnapshotStore,
} from '../core/ports';
import { AccountRepository } from '../persistence/account-repository';
import { CredentialStore } from '../persistence/credential-store';

interface AccountServicesOptions {
  store: AccountSnapshotStore;
  cipher: AccountCipher;
  providers?: AccountProviderRegistration[];
  now?: () => number;
  logger?: StorageLogger;
}

/** Shared account infrastructure. Provider registration performs no authentication or SDK loading. */
export function createAccountServices(options: AccountServicesOptions) {
  const repository = new AccountRepository(options.store);
  const credentials = new CredentialStore(options.cipher);
  const providers = new AccountProviderRegistry({
    repository,
    credentials,
    now: options.now ?? Date.now,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  for (const registration of options.providers ?? []) providers.register(registration);
  const accounts = new AccountManager(repository, providers);
  return {
    accounts,
    credentials: new AccountCredentialResolver(repository, providers, (id) =>
      accounts.assertAccountAvailable(id),
    ),
    dispose: () => accounts.dispose(),
  };
}
