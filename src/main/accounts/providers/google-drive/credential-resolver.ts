import type { CredentialResolver } from '@main/common/credentials';
import type { OperationContext } from '@main/common/operation-context';
import {
  isGoogleDriveAuthorization,
  matchesGoogleDriveAuthorization,
  type GoogleDriveAuthorization,
} from '@main/storage/providers/google-drive/authorization';
import { storageAuthorizationError } from '@main/accounts/core/credential-errors';
import { assertNotCancelled, AccountError } from '@main/accounts/core/errors';
import type { GoogleAccountRepository } from './account-repository';
import type { GoogleTokenProvider } from './token-provider';

export {
  isGoogleDriveAuthorization,
  matchesGoogleDriveAuthorization,
  type GoogleDriveAuthorization,
};

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
