import type { AccountProviderServices } from '../../core/ports';
import { GoogleDriveAccountProvider } from './account-provider';
import { GoogleAccountRepository } from './account-repository';
import { GoogleDriveCredentials } from './credentials';
import { AccountGrantWriter } from './grant-writer';
import { GoogleAuthorizationFlow } from './oauth/authorization-flow';
import type { AuthorizationEnvironment, GoogleAccountGateway } from './ports';
import { GoogleTokenProvider } from './token-provider';

interface GoogleProviderOptions {
  gateway: GoogleAccountGateway;
  authorizationEnvironment: AuthorizationEnvironment;
  authorizationTimeoutMs?: number;
}

/** Google authentication consumes shared persistence, encryption, time, and diagnostics. */
export function createGoogleDriveProvider(
  services: AccountProviderServices,
  options: GoogleProviderOptions,
) {
  const repository = new GoogleAccountRepository(services.repository);
  const credentials = new GoogleDriveCredentials(services.credentials);
  const { gateway } = options;
  const tokens = new GoogleTokenProvider({ repository, credentials, gateway, now: services.now });
  return new GoogleDriveAccountProvider({
    repository,
    tokens,
    gateway,
    now: services.now,
    grantWriter: new AccountGrantWriter({ repository, credentials, gateway, now: services.now }),
    authorization: new GoogleAuthorizationFlow(gateway, options.authorizationEnvironment),
    ...(options.authorizationTimeoutMs !== undefined
      ? { authorizationTimeoutMs: options.authorizationTimeoutMs }
      : {}),
    ...(services.logger ? { logger: services.logger } : {}),
  });
}
