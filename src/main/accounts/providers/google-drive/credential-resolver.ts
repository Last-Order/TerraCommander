import { storageAuthorizationError } from '../../core/credential-errors';
import type { ConnectionDefinition } from '../../../../shared/storage';
import type { OperationContext } from '../../../storage/core/contracts';
import type { CredentialResolver } from '../../../storage/ports/services';
import type { GoogleAccountRepository } from './account-repository';
import { assertNotCancelled, AccountError } from '../../core/errors';
import type { GoogleTokenProvider } from './token-provider';

export interface GoogleDriveAuthorization {
  readonly provider: 'google-drive';
  readonly connectionId: string;
  readonly subject: string;
  readonly oauthClientId: string;
  getAccessToken(ctx?: OperationContext): Promise<string>;
}

export function isGoogleDriveAuthorization(value: unknown): value is GoogleDriveAuthorization {
  return (
    typeof value === 'object' &&
    value !== null &&
    'provider' in value &&
    value.provider === 'google-drive' &&
    'connectionId' in value &&
    typeof value.connectionId === 'string' &&
    'subject' in value &&
    typeof value.subject === 'string' &&
    'oauthClientId' in value &&
    typeof value.oauthClientId === 'string' &&
    'getAccessToken' in value &&
    typeof value.getAccessToken === 'function'
  );
}

export class GoogleDriveCredentialResolver implements CredentialResolver {
  constructor(
    private readonly repository: GoogleAccountRepository,
    private readonly tokens: GoogleTokenProvider,
  ) {}

  async resolve(reference: string, ctx: OperationContext): Promise<GoogleDriveAuthorization> {
    try {
      assertNotCancelled(ctx.signal);
      const account = this.repository.findCredential(reference);
      this.tokens.assertAccountUsable(account.id);
      return Object.freeze({
        provider: 'google-drive' as const,
        connectionId: account.id,
        subject: account.subject,
        oauthClientId: account.oauthClientId,
        getAccessToken: async (operation: OperationContext = {}) => {
          try {
            // Re-read on each use: an old handle cannot survive removal and re-addition.
            const current = this.repository.findCredential(reference);
            if (current.id !== account.id) throw new AccountError('IdentityMismatch');
            return await this.tokens.getAccessToken(account.id, operation);
          } catch (error) {
            throw storageAuthorizationError(error);
          }
        },
      });
    } catch (error) {
      throw storageAuthorizationError(error);
    }
  }
}

/** Future adapter factories can check the handle without importing any Google SDK types. */
export function matchesGoogleDriveAuthorization(
  authorization: unknown,
  connection: ConnectionDefinition,
): authorization is GoogleDriveAuthorization {
  return (
    isGoogleDriveAuthorization(authorization) &&
    authorization.provider === connection.provider &&
    authorization.connectionId === connection.id &&
    authorization.subject === connection.configuration.subject &&
    authorization.oauthClientId === connection.configuration.oauthClientId
  );
}
